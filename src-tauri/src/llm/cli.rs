//! A locally installed agent CLI as a provider (0.19.1): Claude Code or Codex,
//! running on whatever subscription the user signed it into.
//!
//! A provider whose base URL is `cli://claude` or `cli://codex` is not reached
//! over HTTP. The app runs the CLI in print mode, feeds it the conversation on
//! stdin, and translates its JSON event lines into the OpenAI-compatible SSE
//! chunks the stream consumer already reads — so chat, panels, compaction and
//! titles work unchanged.
//!
//! The CLI is used as a model, not as an agent: Claude Code runs with none of
//! its own tools, no user settings and the app's own system prompt; Codex
//! runs read-only.
//!
//! The app's tools reach it over a loopback MCP server, but the app runs them.
//! When the model calls one, the call goes back to the app as an ordinary tool
//! call while the CLI waits on the bridge; the app's own loop runs the tool
//! (approvals, visuals, checkpoints, runaway guards) and its next request
//! delivers the result to the same process. See "Runs that outlive a request".

use crate::error::{AppError, AppResult};
use crate::llm::types::*;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cli {
    Claude,
    Codex,
}

impl Cli {
    pub fn from_base_url(url: &str) -> Option<Cli> {
        match url.trim().trim_end_matches('/').to_ascii_lowercase().as_str() {
            "cli://claude" => Some(Cli::Claude),
            "cli://codex" => Some(Cli::Codex),
            _ => None,
        }
    }

    fn program(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Cli::Claude => "Claude Code",
            Cli::Codex => "Codex",
        }
    }

    /// What the model picker offers. Both CLIs take other names too; these are
    /// the ones that do not go stale. `default` leaves the choice to the CLI.
    pub fn models(self) -> Vec<String> {
        let m: &[&str] = match self {
            Cli::Claude => &["default", "fable", "haiku", "opus", "sonnet"],
            Cli::Codex => &["default"],
        };
        m.iter().map(|s| s.to_string()).collect()
    }
}

/// The conversation as one prompt. A CLI in print mode takes a single message,
/// so earlier turns are written out as a transcript ahead of the last one.
/// Returns (system prompt, prompt).
fn flatten(messages: &[ChatMessage]) -> (String, String) {
    let text = |m: &ChatMessage| crate::llm::responses::text_of(&m.content);
    // Tool results carry only the call id; the transcript names the tool.
    let names: std::collections::HashMap<&str, &str> = messages
        .iter()
        .flat_map(|m| m.tool_calls.iter().flatten())
        .map(|c| (c.id.as_str(), c.function.name.as_str()))
        .collect();
    let system: Vec<String> =
        messages.iter().filter(|m| m.role == "system").map(text).collect();
    let rest: Vec<&ChatMessage> = messages.iter().filter(|m| m.role != "system").collect();

    let mut out = String::new();
    let last_user = rest.iter().rposition(|m| m.role == "user");
    let (history, last) = match last_user {
        Some(i) if i == rest.len() - 1 => (&rest[..i], Some(rest[i])),
        _ => (&rest[..], None),
    };
    if !history.is_empty() {
        out.push_str("<conversation_so_far>\n");
        for m in history {
            let who = match m.role.as_str() {
                "assistant" => "Assistant".to_string(),
                "tool" => {
                    let id = m.tool_call_id.as_deref().unwrap_or("");
                    format!("Result of {}", names.get(id).copied().unwrap_or("a tool"))
                }
                _ => "User".to_string(),
            };
            let body = text(m);
            if !body.trim().is_empty() || m.tool_calls.is_none() {
                out.push_str(&format!("\n[{who}]\n{body}\n"));
            }
            for c in m.tool_calls.iter().flatten() {
                out.push_str(&format!("\n[Assistant called {}]\n{}\n", c.function.name, c.function.arguments));
            }
        }
        out.push_str("</conversation_so_far>\n\n");
    }
    match last {
        Some(m) => out.push_str(&text(m)),
        None => out.push_str("Continue."),
    }
    (system.join("\n\n"), out)
}

/// Model names reach a command line, and `.cmd` shims go through cmd.exe.
fn safe_model(model: &str) -> AppResult<Option<&str>> {
    let m = model.trim();
    if m.is_empty() || m.eq_ignore_ascii_case("default") {
        return Ok(None);
    }
    if m.chars().all(|c| c.is_ascii_alphanumeric() || "._:-[]/".contains(c)) {
        Ok(Some(m))
    } else {
        Err(AppError::Provider(format!("not a model name: {m:?}")))
    }
}

/// Deletes the system-prompt file once the run is over.
struct TempFile(std::path::PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn command(cli: Cli) -> tokio::process::Command {
    #[cfg(windows)]
    {
        // `codex` from npm is `codex.cmd`, which a bare name does not find;
        // std escapes a `.cmd` path's arguments safely when spawning it.
        let path = crate::mcp::Manager::resolve_program_windows(cli.program());
        let mut cmd = tokio::process::Command::new(
            path.map(|p| p.into_os_string()).unwrap_or_else(|| cli.program().into()),
        );
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }
    #[cfg(not(windows))]
    tokio::process::Command::new(cli.program())
}

/// Translates one CLI's event lines into OpenAI stream chunks.
#[derive(Default)]
struct Translator {
    /// The CLI reached the end of its answer.
    done: bool,
    /// The model called app tools: this request's answer ends here, and the
    /// CLI waits on the bridge for the results.
    cut: bool,
    /// Claude content-block index → OpenAI tool-call index.
    blocks: std::collections::HashMap<u64, usize>,
    /// The calls made, as (id, name, arguments so far).
    calls: Vec<(String, String, String)>,
    /// Claude's running usage, for a turn cut before its `result` line.
    usage: Option<Value>,
}

/// What Claude Code calls a tool served by the bridge.
const CLAUDE_PREFIX: &str = "mcp__multizone__";

impl Translator {
    /// Chunks for one line, or the error the CLI reported.
    fn line(&mut self, cli: Cli, v: &Value) -> Result<Vec<Value>, String> {
        let delta = |field: &str, s: &str| json!({ "choices": [{ "index": 0, "delta": { field: s } }] });
        let finish = || json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] });
        let usage = |prompt: i64, cached: i64, completion: i64| {
            json!({ "choices": [], "usage": {
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "prompt_tokens_details": { "cached_tokens": cached },
            }})
        };
        let n = |u: &Value, k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
        let call = |index: usize, id: Option<&str>, name: Option<&str>, args: &str| {
            let mut f = json!({ "arguments": args });
            if let Some(name) = name {
                f["name"] = json!(name);
            }
            let mut c = json!({ "index": index, "function": f });
            if let Some(id) = id {
                c["id"] = json!(id);
                c["type"] = json!("function");
            }
            json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [c] } }] })
        };
        let tool_finish = || json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }] });
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        match cli {
            Cli::Claude => match kind {
                "stream_event" => {
                    let ev = &v["event"];
                    let block = ev["index"].as_u64().unwrap_or(0);
                    match ev["type"].as_str() {
                        Some("content_block_start") if ev["content_block"]["type"] == "tool_use" => {
                            let b = &ev["content_block"];
                            let name = b["name"].as_str().unwrap_or("");
                            let name = name.strip_prefix(CLAUDE_PREFIX).unwrap_or(name);
                            let index = self.blocks.len();
                            self.blocks.insert(block, index);
                            let id = b["id"].as_str().unwrap_or("");
                            self.calls.push((id.to_string(), name.to_string(), String::new()));
                            Ok(vec![call(index, Some(id), Some(name), "")])
                        }
                        Some("content_block_delta") => {
                            let d = &ev["delta"];
                            Ok(match d["type"].as_str() {
                                Some("text_delta") => vec![delta("content", d["text"].as_str().unwrap_or(""))],
                                Some("thinking_delta") => {
                                    vec![delta("reasoning_content", d["thinking"].as_str().unwrap_or(""))]
                                }
                                Some("input_json_delta") => match self.blocks.get(&block) {
                                    Some(&i) => {
                                        let part = d["partial_json"].as_str().unwrap_or("");
                                        self.calls[i].2.push_str(part);
                                        vec![call(i, None, None, part)]
                                    }
                                    None => vec![],
                                },
                                _ => vec![],
                            })
                        }
                        Some("message_delta") => {
                            self.usage = Some(ev["usage"].clone());
                            Ok(vec![])
                        }
                        // The end of a message that called tools: the app runs
                        // them, and the CLI waits for the results.
                        Some("message_stop") if !self.blocks.is_empty() => {
                            self.done = true;
                            self.cut = true;
                            let mut out = vec![tool_finish()];
                            if let Some(u) = &self.usage {
                                let cached = n(u, "cache_read_input_tokens");
                                let prompt = n(u, "input_tokens") + n(u, "cache_creation_input_tokens") + cached;
                                out.push(usage(prompt, cached, n(u, "output_tokens")));
                            }
                            Ok(out)
                        }
                        _ => Ok(vec![]),
                    }
                }
                "result" => {
                    self.done = true;
                    if v["is_error"].as_bool().unwrap_or(false) {
                        let msg = v["result"].as_str().unwrap_or("Claude Code reported an error");
                        return Err(msg.to_string());
                    }
                    let u = &v["usage"];
                    let cached = n(u, "cache_read_input_tokens");
                    let prompt = n(u, "input_tokens") + n(u, "cache_creation_input_tokens") + cached;
                    Ok(vec![finish(), usage(prompt, cached, n(u, "output_tokens"))])
                }
                _ => Ok(vec![]),
            },
            Cli::Codex => match kind {
                // Codex reports a tool call as it starts, then waits on the
                // bridge for the app's result.
                "item.started"
                    if v["item"]["type"] == "mcp_tool_call" && v["item"]["server"] == "multizone" =>
                {
                    let item = &v["item"];
                    let args = match &item["arguments"] {
                        Value::String(s) => s.clone(),
                        Value::Null => "{}".to_string(),
                        a => a.to_string(),
                    };
                    let (id, name) = (item["id"].as_str().unwrap_or(""), item["tool"].as_str().unwrap_or(""));
                    self.calls.push((id.to_string(), name.to_string(), args.clone()));
                    self.done = true;
                    self.cut = true;
                    Ok(vec![call(0, Some(id), Some(name), &args), tool_finish()])
                }
                "item.completed" => {
                    let item = &v["item"];
                    let text = item["text"].as_str().unwrap_or("");
                    Ok(match item["type"].as_str() {
                        Some("agent_message") => vec![delta("content", text)],
                        Some("reasoning") => vec![delta("reasoning_content", text)],
                        _ => vec![],
                    })
                }
                "turn.completed" => {
                    self.done = true;
                    let u = &v["usage"];
                    let cached = n(u, "cached_input_tokens");
                    Ok(vec![finish(), usage(n(u, "input_tokens"), cached, n(u, "output_tokens"))])
                }
                "turn.failed" => Err(v["error"]["message"].as_str().unwrap_or("Codex turn failed").to_string()),
                "error" => Err(v["message"].as_str().unwrap_or("Codex reported an error").to_string()),
                _ => Ok(vec![]),
            },
        }
    }
}

/// Ends the run's MCP server.
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The app's tools in MCP's shape.
fn mcp_tools(tools: &[Tool]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.function.name,
                    "description": t.function.description,
                    "inputSchema": t.function.parameters,
                })
            })
            .collect(),
    )
}

/// A tool call the model made and the app has yet to answer. The app's half
/// (`tx`) is taken when the next request carries the result; the bridge's half
/// (`rx`) when the CLI's `tools/call` arrives. Either can come first.
struct Call {
    id: String,
    name: String,
    args: Value,
    tx: Option<tokio::sync::oneshot::Sender<String>>,
    rx: Option<tokio::sync::oneshot::Receiver<String>>,
}

type Calls = std::sync::Arc<std::sync::Mutex<Vec<Call>>>;

/// The waiting half for a `tools/call`. MCP does not carry the model's
/// tool-use id, so the call is matched by name and arguments; by name alone if
/// the CLI re-serialised the arguments differently. The CLI can call before the
/// app has read the end of the message that made the call, so this waits.
async fn claim(calls: &Calls, name: &str, args: &Value) -> Option<tokio::sync::oneshot::Receiver<String>> {
    for _ in 0..600 {
        if let Ok(mut list) = calls.lock() {
            let open = |c: &&mut Call| c.rx.is_some() && c.name == name;
            let i = list.iter_mut().position(|c| open(&c) && &c.args == args)
                .or_else(|| list.iter_mut().position(|c| open(&c)));
            if let Some(i) = i {
                return list[i].rx.take();
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    None
}

/// One JSON-RPC message to the bridge, answered; `None` for a notification.
/// A `tools/call` waits for the app to run the tool and send the result.
async fn rpc(tools: &Value, calls: &Calls, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let result = match msg["method"].as_str() {
        Some("initialize") => json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "multizone", "version": env!("CARGO_PKG_VERSION") },
        }),
        Some("tools/list") => json!({ "tools": tools }),
        Some("ping") => json!({}),
        Some("tools/call") => {
            let p = &msg["params"];
            let name = p["name"].as_str().unwrap_or("");
            let args = p.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let (text, err) = match claim(calls, name, &args).await {
                Some(rx) => match rx.await {
                    Ok(text) => (text, false),
                    Err(_) => ("The app did not run this tool.".to_string(), true),
                },
                None => (format!("No call to {name} is waiting for a result."), true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": err })
        }
        _ => {
            return Some(json!({ "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": "method not found" } }))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// A streamable-HTTP MCP server on loopback for one run, at an unguessable
/// path. Returns its URL.
async fn serve_tools(tools: &[Tool], calls: Calls) -> AppResult<(String, Server)> {
    use axum::{http::StatusCode, response::IntoResponse, routing::post, Json, Router};
    let tools = std::sync::Arc::new(mcp_tools(tools));
    let path = format!("/mcp/{}", uuid::Uuid::new_v4().simple());
    let app = Router::new().route(
        &path,
        post(move |Json(msg): Json<Value>| {
            let (tools, calls) = (tools.clone(), calls.clone());
            async move {
                match rpc(&tools, &calls, &msg).await {
                    Some(reply) => Json(reply).into_response(),
                    None => StatusCode::ACCEPTED.into_response(),
                }
            }
        })
        // No server-initiated stream; the spec allows saying so.
        .get(|| async { StatusCode::METHOD_NOT_ALLOWED })
        .delete(|| async { StatusCode::METHOD_NOT_ALLOWED }),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let url = format!("http://{}{path}", listener.local_addr()?);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, Server(task)))
}

// ---------------------------------------------------------------------------
// Runs that outlive a request (0.19.2)
// ---------------------------------------------------------------------------
//
// 0.19.1 started a fresh CLI for every request and wrote the whole
// conversation into one new user message each time. The prompt cache matches
// whole blocks, so every tool step paid for the transcript again: one study
// chat made 44 requests, 3.35M input tokens, 16% of them cached, and spent a
// five-hour subscription window. A CLI used directly keeps one process and
// one conversation, and caches nearly everything.
//
// So the process now belongs to the chat. A tool call waits inside the CLI on
// the bridge while the app runs the tool; the app's next request delivers the
// result and the same process carries on. Claude Code also stays alive between
// turns (stream-json on stdin), so the next user message goes to it rather than
// to a new process. Anything the run cannot account for — an edited or
// regenerated message, compaction, a different tool set — starts a fresh run,
// which is always correct, only dearer.

/// One CLI process and what it has been told.
struct Run {
    cli: Cli,
    model: String,
    tools_sig: u64,
    child: tokio::process::Child,
    /// Claude's stdin, held open for the next turn. Codex reads one prompt.
    stdin: Option<tokio::process::ChildStdin>,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    stderr: Option<tokio::process::ChildStderr>,
    calls: Calls,
    /// The user messages of the request it last answered, hashed in order.
    users: Vec<u64>,
    /// Bumped on every park, so a stale idle timer leaves a newer run alone.
    gen: u64,
    _server: Option<(String, Server)>,
    _files: (Option<TempFile>, Option<TempFile>),
}

impl Run {
    /// Tool calls the app has yet to answer.
    fn pending(&self) -> Vec<String> {
        self.calls.lock().map(|l| l.iter().filter(|c| c.tx.is_some()).map(|c| c.id.clone()).collect()).unwrap_or_default()
    }
}

/// Parked runs, by chat and model. An idle Claude process holds a few hundred
/// MB, so only a handful are kept.
fn runs() -> &'static std::sync::Mutex<std::collections::HashMap<String, Run>> {
    static RUNS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Run>>> =
        std::sync::OnceLock::new();
    RUNS.get_or_init(Default::default)
}
const MAX_PARKED: usize = 4;
const IDLE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

fn hash<T: std::hash::Hash>(v: T) -> u64 {
    use std::hash::Hasher;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

fn tools_sig(req: &ChatRequest) -> u64 {
    hash(req.tools.as_ref().map(|t| t.iter().map(|t| t.function.name.clone()).collect::<Vec<_>>()))
}

fn user_hashes(messages: &[ChatMessage]) -> Vec<u64> {
    messages
        .iter()
        .filter(|m| m.role == "user")
        .map(|m| hash(crate::llm::responses::text_of(&m.content)))
        .collect()
}

fn run_key(session: &str, cli: Cli, req: &ChatRequest) -> String {
    format!("{session}\u{0}{cli:?}\u{0}{}\u{0}{}", req.model, tools_sig(req))
}

/// How a request continues a parked run, if it does.
#[derive(Debug, PartialEq)]
enum Resume {
    /// Results for the pending calls, by id. Any system notes the app added
    /// since (step-budget nudges) ride on the last one.
    Results(Vec<(String, String)>),
    /// The next user message, for a Claude run idle between turns.
    User(String),
}

fn resume_plan(users: &[u64], pending: &[String], has_stdin: bool, req: &ChatRequest) -> Option<Resume> {
    let now = user_hashes(&req.messages);
    let text = |m: &ChatMessage| crate::llm::responses::text_of(&m.content);
    if !pending.is_empty() {
        // Same user messages; after the message that made the calls, only
        // their results and system notes.
        if now != users {
            return None;
        }
        let last_call = req.messages.iter().rposition(|m| m.tool_calls.is_some())?;
        let ids: Vec<&str> = req.messages[last_call].tool_calls.iter().flatten().map(|c| c.id.as_str()).collect();
        let mut want: Vec<&str> = pending.iter().map(String::as_str).collect();
        let mut got: Vec<&str> = ids.clone();
        want.sort();
        got.sort();
        if want != got {
            return None;
        }
        let mut results = Vec::new();
        let mut notes = Vec::new();
        for m in &req.messages[last_call + 1..] {
            match m.role.as_str() {
                "tool" => results.push((m.tool_call_id.clone()?, text(m))),
                "system" => notes.push(text(m)),
                _ => return None,
            }
        }
        if results.len() != pending.len() {
            return None;
        }
        if let (Some(last), false) = (results.last_mut(), notes.is_empty()) {
            last.1.push_str(&format!("\n\n<system_note>\n{}\n</system_note>", notes.join("\n\n")));
        }
        return Some(Resume::Results(results));
    }
    // Idle between turns: exactly one new user message, at the end.
    let last = req.messages.iter().rposition(|m| m.role != "system")?;
    if !has_stdin || req.messages[last].role != "user" || now.len() != users.len() + 1 || now[..users.len()] != *users {
        return None;
    }
    Some(Resume::User(text(&req.messages[last])))
}

/// One user message in Claude's stream-json input.
fn user_line(text: &str) -> String {
    format!("{}\n", json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }))
}

/// Take a parked run this request continues, and hand it its input.
async fn resume(key: &str, cli: Cli, req: &ChatRequest) -> Option<Run> {
    let mut run = runs().lock().ok()?.remove(key)?;
    if run.cli != cli || run.model != req.model || run.tools_sig != tools_sig(req) {
        return None;
    }
    if !matches!(run.child.try_wait(), Ok(None)) {
        return None;
    }
    match resume_plan(&run.users, &run.pending(), run.stdin.is_some(), req)? {
        Resume::Results(results) => {
            let mut list = run.calls.lock().ok()?;
            for (id, text) in results {
                if let Some(tx) = list.iter_mut().find(|c| c.id == id).and_then(|c| c.tx.take()) {
                    let _ = tx.send(text);
                }
            }
            list.retain(|c| c.tx.is_some() || c.rx.is_some());
        }
        Resume::User(text) => {
            run.stdin.as_mut()?.write_all(user_line(&text).as_bytes()).await.ok()?;
            run.stdin.as_mut()?.flush().await.ok()?;
        }
    }
    Some(run)
}

/// Keep a run for the request that continues it. The oldest goes when too
/// many are parked; an idle one goes after half an hour.
fn park(key: String, mut run: Run, req: &ChatRequest) {
    static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    run.users = user_hashes(&req.messages);
    run.gen = GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let gen = run.gen;
    let Ok(mut map) = runs().lock() else { return };
    map.insert(key.clone(), run);
    while map.len() > MAX_PARKED {
        let Some(oldest) = map.iter().min_by_key(|(_, r)| r.gen).map(|(k, _)| k.clone()) else { break };
        map.remove(&oldest);
    }
    drop(map);
    tokio::spawn(async move {
        tokio::time::sleep(IDLE).await;
        if let Ok(mut map) = runs().lock() {
            if map.get(&key).is_some_and(|r| r.gen == gen) {
                map.remove(&key);
            }
        }
    });
}

/// Start a CLI on this request's whole conversation.
async fn spawn(cli: Cli, req: &ChatRequest) -> AppResult<Run> {
    let model = safe_model(&req.model)?;
    let (system, mut prompt) = flatten(&req.messages);
    let dir = std::env::temp_dir();
    let mut prompt_file = None;
    let mut mcp_file = None;
    let calls: Calls = Default::default();

    // The tools this request offers, served to the CLI for the life of the run.
    let server = match req.tools.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => Some(serve_tools(t, calls.clone()).await?),
        None => None,
    };
    // Neither CLI can be made to call a particular tool; ask instead.
    if let Some(name) = req.tool_choice.as_ref().and_then(|c| c["function"]["name"].as_str()) {
        prompt.push_str(&format!("\n\nAnswer by calling the {name} tool."));
    }

    let mut cmd = command(cli);
    match cli {
        Cli::Claude => {
            cmd.args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--setting-sources",
                "",
                "--tools",
                "",
            ]);
            if let Some(m) = model {
                cmd.args(["--model", m]);
            }
            if let Some((url, _)) = &server {
                let path = dir.join(format!("multizone-mcp-{}.json", uuid::Uuid::new_v4()));
                let config = json!({ "mcpServers": { "multizone": { "type": "http", "url": url } } });
                std::fs::write(&path, config.to_string())?;
                cmd.arg("--mcp-config").arg(&path);
                // The app asks for approval itself; Claude Code's own check
                // would refuse every call in print mode.
                cmd.arg("--allowedTools=mcp__multizone");
                mcp_file = Some(TempFile(path));
            }
            if !system.trim().is_empty() {
                // A file, not an argument: system prompts outgrow Windows'
                // 32K command line.
                let path = dir.join(format!("multizone-cli-{}.txt", uuid::Uuid::new_v4()));
                std::fs::write(&path, &system)?;
                cmd.arg("--system-prompt-file").arg(&path);
                prompt_file = Some(TempFile(path));
            }
            // A tool call waits on the bridge for as long as an approval takes.
            cmd.env("MCP_TOOL_TIMEOUT", "86400000");
        }
        Cli::Codex => {
            cmd.args(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"]);
            if let Some(m) = model {
                cmd.args(["-m", m]);
            }
            if let Some(e) = req.reasoning_effort.as_deref().filter(|e| ["low", "medium", "high"].contains(e)) {
                cmd.args(["-c", &format!("model_reasoning_effort={e}")]);
            }
            if let Some((url, _)) = &server {
                cmd.args(["-c", &format!("mcp_servers.multizone.url={}", json!(url))]);
                cmd.args(["-c", "mcp_servers.multizone.tool_timeout_sec=86400"]);
            }
            cmd.arg("-");
        }
    }

    // A scratch directory, so neither CLI picks up a CLAUDE.md, AGENTS.md or
    // git state from wherever the app happened to be launched.
    cmd.current_dir(&dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Provider(format!(
                "{} is not installed, or not on PATH. Install the `{}` CLI and sign in to it, then restart the app.",
                cli.label(),
                cli.program()
            ))
        } else {
            AppError::Provider(format!("could not start {}: {e}", cli.label()))
        }
    })?;

    let mut stdin = child.stdin.take().expect("piped");
    let stdin = match cli {
        // Kept open: the next turn is written to the same process.
        Cli::Claude => {
            stdin.write_all(user_line(&prompt).as_bytes()).await?;
            stdin.flush().await?;
            Some(stdin)
        }
        // Codex has no system-prompt flag, and starts once stdin closes.
        Cli::Codex => {
            let text = if system.trim().is_empty() {
                prompt
            } else {
                format!("<instructions>\n{system}\n</instructions>\n\n{prompt}")
            };
            tokio::spawn(async move {
                let _ = stdin.write_all(text.as_bytes()).await;
            });
            None
        }
    };
    let lines = BufReader::new(child.stdout.take().expect("piped")).lines();
    let stderr = child.stderr.take();
    Ok(Run {
        cli,
        model: req.model.clone(),
        tools_sig: tools_sig(req),
        child,
        stdin,
        lines,
        stderr,
        calls,
        users: Vec::new(),
        gen: 0,
        _server: server,
        _files: (prompt_file, mcp_file),
    })
}

/// The CLI's reply to this request as an SSE response: from the chat's parked
/// run when the request continues it, otherwise from a new one.
pub async fn stream(cli: Cli, req: &ChatRequest, session: &str) -> AppResult<reqwest::Response> {
    let key = run_key(session, cli, req);
    let run = match resume(&key, cli, req).await {
        Some(run) => run,
        None => spawn(cli, req).await?,
    };
    // Only a request with tools is a chat's own turn; a title or a summary
    // asked of the same chat is answered and let go.
    let keep = req.tools.as_ref().is_some_and(|t| !t.is_empty());
    let messages = req.clone();

    struct St {
        run: Option<Run>,
        t: Translator,
        key: String,
        keep: bool,
        req: ChatRequest,
    }
    let st = St { run: Some(run), t: Translator::default(), key, keep, req: messages };
    let error = |msg: &str| format!("data: {}\n\n", json!({ "error": { "message": msg } }));

    // Dropping the stream (stop button) without parking drops the run, and
    // kill_on_drop ends the process.
    let body = futures_util::stream::unfold(st, move |mut st| async move {
        let run = st.run.as_mut()?;
        loop {
            match run.lines.next_line().await {
                Ok(Some(line)) => {
                    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    match st.t.line(run.cli, &v) {
                        Ok(chunks) if chunks.is_empty() => continue,
                        Ok(chunks) => {
                            let mut sse: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
                            if st.t.cut || st.t.done {
                                sse.push_str("data: [DONE]\n\n");
                                let run = st.run.take()?;
                                // The calls wait on the bridge for the app's results.
                                if let Ok(mut list) = run.calls.lock() {
                                    for (id, name, args) in st.t.calls.drain(..) {
                                        let (tx, rx) = tokio::sync::oneshot::channel();
                                        let args = serde_json::from_str(&args).unwrap_or_else(|_| json!({}));
                                        list.push(Call { id, name, args, tx: Some(tx), rx: Some(rx) });
                                    }
                                }
                                // Parked before the [DONE] goes out: the reader
                                // drops the stream as soon as it sees it.
                                let alive = st.t.cut || run.stdin.is_some();
                                if st.keep && alive {
                                    park(st.key.clone(), run, &st.req);
                                }
                            }
                            return Some((Ok::<_, std::io::Error>(sse), st));
                        }
                        Err(msg) => {
                            st.run = None;
                            return Some((Ok(error(&msg)), st));
                        }
                    }
                }
                Ok(None) => {
                    // Exited without finishing: stderr says why.
                    let mut run = st.run.take()?;
                    let mut err = String::new();
                    if let Some(mut e) = run.stderr.take() {
                        let _ = tokio::io::AsyncReadExt::read_to_string(&mut e, &mut err).await;
                    }
                    let status = run.child.wait().await.ok();
                    let msg = format!(
                        "{} exited ({}) without an answer: {}",
                        run.cli.label(),
                        status.map(|s| s.to_string()).unwrap_or_default(),
                        err.trim()
                    );
                    return Some((Ok(error(&msg)), st));
                }
                Err(e) => {
                    st.run = None;
                    return Some((Ok(error(&e.to_string())), st));
                }
            }
        }
    });

    let res = http::Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .body(reqwest::Body::wrap_stream(body))
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(reqwest::Response::from(res))
}

/// The whole reply at once, for the callers that do not stream.
pub async fn complete(cli: Cli, req: &ChatRequest, session: &str) -> AppResult<ChatResponse> {
    let res = stream(cli, req, session).await?;
    let mut events = eventsource_stream::Eventsource::eventsource(res.bytes_stream());
    let (mut content, mut usage) = (String::new(), None);
    while let Some(ev) = events.next().await {
        let ev = ev.map_err(|e| AppError::Provider(e.to_string()))?;
        if ev.data == "[DONE]" {
            break;
        }
        if let Some(msg) = stream_error(&ev.data) {
            return Err(AppError::Provider(msg));
        }
        let Ok(chunk) = serde_json::from_str::<StreamChunk>(&ev.data) else { continue };
        if chunk.usage.is_some() {
            usage = chunk.usage;
        }
        for c in chunk.choices {
            content.push_str(c.delta.content.as_deref().unwrap_or(""));
        }
    }
    Ok(ChatResponse {
        choices: vec![ChatChoice {
            message: ChatMessage {
                role: "assistant".into(),
                content: Some(MessageContent::Text(content)),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
            finish_reason: Some("stop".into()),
        }],
        usage,
    })
}

/// The message of an `{"error": …}` frame — how OpenAI-compatible servers, and
/// this module, report a failure inside a stream that has already started.
pub fn stream_error(data: &str) -> Option<String> {
    if !data.contains("\"error\"") {
        return None;
    }
    let v: Value = serde_json::from_str(data).ok()?;
    let e = v.get("error").filter(|e| !e.is_null())?;
    Some(e.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, text: &str) -> ChatMessage {
        ChatMessage { role: role.into(), content: Some(MessageContent::Text(text.into())), tool_calls: None, tool_call_id: None, name: None }
    }

    #[test]
    fn base_urls_and_models() {
        assert_eq!(Cli::from_base_url("cli://Claude/"), Some(Cli::Claude));
        assert_eq!(Cli::from_base_url("cli://codex"), Some(Cli::Codex));
        assert_eq!(Cli::from_base_url("http://localhost:11434/v1"), None);
        assert_eq!(safe_model("default").unwrap(), None);
        assert_eq!(safe_model("claude-opus-5-5[1m]").unwrap(), Some("claude-opus-5-5[1m]"));
        assert!(safe_model("sonnet & calc").is_err(), "cmd.exe metacharacters");
    }

    #[test]
    fn a_conversation_flattens_to_system_and_prompt() {
        let (sys, p) = flatten(&[msg("system", "Be terse."), msg("user", "hi")]);
        assert_eq!((sys.as_str(), p.as_str()), ("Be terse.", "hi"), "one turn is sent as-is");

        let (_, p) = flatten(&[msg("user", "one"), msg("assistant", "two"), msg("user", "three")]);
        assert!(p.contains("[User]\none") && p.contains("[Assistant]\ntwo"));
        assert!(p.ends_with("</conversation_so_far>\n\nthree"));
    }

    #[test]
    fn claude_events_become_chunks() {
        let mut t = Translator::default();
        let text = json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}});
        let out = t.line(Cli::Claude, &text).unwrap();
        let c: StreamChunk = serde_json::from_value(out[0].clone()).unwrap();
        assert_eq!(c.choices[0].delta.content.as_deref(), Some("Hi"));

        let think = json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}});
        let c: StreamChunk = serde_json::from_value(t.line(Cli::Claude, &think).unwrap()[0].clone()).unwrap();
        assert_eq!(c.choices[0].delta.reasoning_content.as_deref(), Some("hm"));

        // The full `assistant` message repeats the deltas and must not double them.
        assert!(t.line(Cli::Claude, &json!({"type":"assistant","message":{}})).unwrap().is_empty());

        let done = json!({"type":"result","is_error":false,"usage":{"input_tokens":2,"cache_creation_input_tokens":10,"cache_read_input_tokens":5,"output_tokens":7}});
        let out = t.line(Cli::Claude, &done).unwrap();
        let u: StreamChunk = serde_json::from_value(out[1].clone()).unwrap();
        let u = u.usage.unwrap();
        assert_eq!((u.prompt_tokens, u.cached_prompt_tokens(), u.completion_tokens), (17, 5, 7));
        assert!(t.done);

        let err = json!({"type":"result","is_error":true,"result":"Not logged in"});
        assert_eq!(Translator::default().line(Cli::Claude, &err).unwrap_err(), "Not logged in");
    }

    #[test]
    fn codex_events_become_chunks() {
        let mut t = Translator::default();
        let msg = json!({"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Done."}});
        let c: StreamChunk = serde_json::from_value(t.line(Cli::Codex, &msg).unwrap()[0].clone()).unwrap();
        assert_eq!(c.choices[0].delta.content.as_deref(), Some("Done."));
        let cmd = json!({"type":"item.completed","item":{"type":"command_execution","command":"ls"}});
        assert!(t.line(Cli::Codex, &cmd).unwrap().is_empty());
        let end = json!({"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":9}});
        let u: StreamChunk = serde_json::from_value(t.line(Cli::Codex, &end).unwrap()[1].clone()).unwrap();
        assert_eq!(u.usage.unwrap().cached_prompt_tokens(), 40);
        let fail = json!({"type":"turn.failed","error":{"message":"usage limit"}});
        assert_eq!(t.line(Cli::Codex, &fail).unwrap_err(), "usage limit");
    }

    #[test]
    fn a_claude_tool_call_is_handed_back_and_the_run_cut() {
        let mut t = Translator::default();
        let ev = |e: Value| json!({ "type": "stream_event", "event": e });
        let start = ev(json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__multizone__read_file","input":{}}}));
        let c: StreamChunk = serde_json::from_value(t.line(Cli::Claude, &start).unwrap()[0].clone()).unwrap();
        let tc = &c.choices[0].delta.tool_calls.as_ref().unwrap()[0];
        assert_eq!((tc.index, tc.id.as_deref()), (0, Some("toolu_1")));
        assert_eq!(tc.function.as_ref().unwrap().name.as_deref(), Some("read_file"), "prefix stripped");

        let args = ev(json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}));
        let c: StreamChunk = serde_json::from_value(t.line(Cli::Claude, &args).unwrap()[0].clone()).unwrap();
        let tc = &c.choices[0].delta.tool_calls.as_ref().unwrap()[0];
        assert_eq!(tc.function.as_ref().unwrap().arguments.as_deref(), Some("{\"path\":"));

        t.line(Cli::Claude, &ev(json!({"type":"message_delta","usage":{"input_tokens":3,"output_tokens":4}}))).unwrap();
        let out = t.line(Cli::Claude, &ev(json!({"type":"message_stop"}))).unwrap();
        let c: StreamChunk = serde_json::from_value(out[0].clone()).unwrap();
        assert_eq!(c.choices[0].finish_reason.as_deref(), Some("tool_calls"));
        assert!(t.cut && out.len() == 2, "cut, with usage");

        // A message with no tool calls is not cut; it ends on `result`.
        let mut plain = Translator::default();
        assert!(plain.line(Cli::Claude, &ev(json!({"type":"message_stop"}))).unwrap().is_empty());
        assert!(!plain.cut);
    }

    #[test]
    fn a_codex_tool_call_is_handed_back() {
        let mut t = Translator::default();
        let other = json!({"type":"item.started","item":{"type":"mcp_tool_call","server":"github","tool":"x","arguments":{}}});
        assert!(t.line(Cli::Codex, &other).unwrap().is_empty(), "someone else's server");
        let ours = json!({"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"multizone","tool":"list_dir","arguments":{"path":"."}}});
        let out = t.line(Cli::Codex, &ours).unwrap();
        let c: StreamChunk = serde_json::from_value(out[0].clone()).unwrap();
        let f = c.choices[0].delta.tool_calls.as_ref().unwrap()[0].function.clone().unwrap();
        assert_eq!((f.name.as_deref(), f.arguments.as_deref()), (Some("list_dir"), Some("{\"path\":\".\"}")));
        assert!(t.cut);
    }

    #[test]
    fn tool_history_reads_as_a_transcript() {
        let mut a = msg("assistant", "");
        a.content = None;
        a.tool_calls = Some(vec![ToolCall {
            id: "c1".into(),
            call_type: "function".into(),
            function: FunctionCall { name: "read_file".into(), arguments: "{\"path\":\"a\"}".into() },
        }]);
        let mut r = msg("tool", "hello");
        r.tool_call_id = Some("c1".into());
        let (_, p) = flatten(&[msg("user", "read a"), a, r]);
        assert!(p.contains("[Assistant called read_file]\n{\"path\":\"a\"}"), "{p}");
        assert!(p.contains("[Result of read_file]\nhello"), "{p}");
        assert!(p.ends_with("Continue."), "a turn after a tool result has no new user message");
    }

    #[tokio::test]
    async fn the_bridge_answers_a_call_with_the_apps_result() {
        let tools = json!([{ "name": "read_file" }]);
        let calls: Calls = Default::default();
        let init = rpc(&tools, &calls, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}})).await.unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(rpc(&tools, &calls, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.is_none());
        let list = rpc(&tools, &calls, &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).await.unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], "read_file");

        // The CLI calls before the app has registered the call: it waits.
        let msg = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"a"}}});
        let (t2, c2) = (tools.clone(), calls.clone());
        let pending = tokio::spawn(async move { rpc(&t2, &c2, &msg).await });
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let (tx, rx) = tokio::sync::oneshot::channel();
        calls.lock().unwrap().push(Call { id: "t1".into(), name: "read_file".into(), args: json!({"path":"a"}), tx: None, rx: Some(rx) });
        tx.send("contents of a".into()).unwrap();
        let reply = pending.await.unwrap().unwrap();
        assert_eq!(reply["result"]["content"][0]["text"], "contents of a");
        assert_eq!(reply["result"]["isError"], false);
    }

    #[test]
    fn a_request_continues_a_run_only_when_it_follows_on() {
        let base = vec![msg("system", "s"), msg("user", "read a")];
        let users = user_hashes(&base);
        let mut called = msg("assistant", "");
        called.tool_calls = Some(vec![ToolCall {
            id: "t1".into(),
            call_type: "function".into(),
            function: FunctionCall { name: "read_file".into(), arguments: "{}".into() },
        }]);
        let mut result = msg("tool", "A");
        result.tool_call_id = Some("t1".into());
        let req = |m: Vec<ChatMessage>| ChatRequest {
            model: "m".into(), messages: m, temperature: None, max_tokens: None, top_p: None, tools: None,
            tool_choice: None, reasoning_effort: None, chat_template_kwargs: None, thinking_extra: Default::default(),
            thinking_ask: None, stream_options: None, stream: true,
        };
        let pending = vec!["t1".to_string()];
        let step = [base.clone(), vec![called.clone(), result.clone(), msg("system", "two steps left")]].concat();
        assert_eq!(
            resume_plan(&users, &pending, true, &req(step)),
            Some(Resume::Results(vec![("t1".into(), "A\n\n<system_note>\ntwo steps left\n</system_note>".into())])),
            "the result, with the nudge riding on it",
        );
        let steered = [base.clone(), vec![called.clone(), result.clone(), msg("user", "stop")]].concat();
        assert_eq!(resume_plan(&users, &pending, true, &req(steered)), None, "a new user message mid-turn");
        let edited = vec![msg("system", "s"), msg("user", "read b"), called.clone(), result.clone()];
        assert_eq!(resume_plan(&users, &pending, true, &req(edited)), None, "an edited message");

        // Idle between turns: one new user message continues it.
        let done = [base.clone(), vec![called, result, msg("assistant", "A says hi")]].concat();
        let users = user_hashes(&done);
        let next = [done.clone(), vec![msg("user", "thanks")]].concat();
        assert_eq!(resume_plan(&users, &[], true, &req(next.clone())), Some(Resume::User("thanks".into())));
        assert_eq!(resume_plan(&users, &[], false, &req(next)), None, "Codex cannot take another turn");
        assert_eq!(resume_plan(&users, &[], true, &req(base)), None, "a regenerated reply");
    }

    #[test]
    fn an_error_frame_is_read_as_an_error() {
        assert_eq!(stream_error(r#"{"error":{"message":"usage limit reached"}}"#).as_deref(), Some("usage limit reached"));
        assert_eq!(stream_error(r#"{"choices":[],"error":null}"#), None);
        assert_eq!(stream_error(r#"{"choices":[{"delta":{"content":"the error was"}}]}"#), None);
    }

    /// The bridge end to end: Claude sees an app tool over MCP, calls it, and
    /// the call comes back as an OpenAI tool call. `-- --ignored`, as below.
    #[tokio::test]
    #[ignore]
    async fn live_claude_tool_call() {
        let tool = Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "get_weather".into(),
                description: "Current weather for a city.".into(),
                parameters: json!({"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}),
            },
        };
        let req = ChatRequest {
            model: "haiku".into(),
            messages: vec![msg("system", "Use your tools."), msg("user", "What's the weather in Oslo?")],
            temperature: None, max_tokens: None, top_p: None, tools: Some(vec![tool]), tool_choice: None,
            reasoning_effort: None, chat_template_kwargs: None, thinking_extra: Default::default(),
            thinking_ask: None, stream_options: None, stream: true,
        };
        let session = "live-tool-test";
        let response = stream(Cli::Claude, &req, session).await.unwrap();
        let s = crate::llm::client::LlmStream { response, dialect: crate::llm::responses::Dialect::ChatCompletions };
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let agg = crate::llm::streaming::consume_stream(s, cancel, false, |_| {}).await.unwrap();
        assert!(agg.error.is_none(), "{:?}", agg.error);
        assert_eq!(agg.finish_reason.as_deref(), Some("tool_calls"));
        let key = run_key(session, Cli::Claude, &req);
        let pid = runs().lock().unwrap().get(&key).and_then(|r| r.child.id()).expect("parked, waiting on the bridge");
        assert_eq!(agg.tool_calls[0].function.name, "get_weather");
        assert!(agg.tool_calls[0].function.arguments.contains("Oslo"), "{}", agg.tool_calls[0].function.arguments);

        // The app ran it; the result goes back and the model answers from it
        // instead of calling again.
        let mut next = req.clone();
        let mut called = msg("assistant", "");
        called.tool_calls = Some(agg.tool_calls.clone());
        let mut result = msg("tool", "Oslo: -3°C, snowing");
        result.tool_call_id = Some(agg.tool_calls[0].id.clone());
        next.messages.extend([called, result]);
        let response = stream(Cli::Claude, &next, session).await.unwrap();
        let s = crate::llm::client::LlmStream { response, dialect: crate::llm::responses::Dialect::ChatCompletions };
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let agg = crate::llm::streaming::consume_stream(s, cancel, false, |_| {}).await.unwrap();
        assert!(agg.error.is_none(), "{:?}", agg.error);
        assert!(agg.tool_calls.is_empty(), "called again: {:?}", agg.tool_calls);
        assert!(agg.content.contains("-3") || agg.content.to_lowercase().contains("snow"), "{}", agg.content);
        let u = agg.usage.clone().expect("usage");
        eprintln!("step 2: {} prompt tokens, {} cached", u.prompt_tokens, u.cached_prompt_tokens());
        assert!(u.cached_prompt_tokens() > 0, "the continued request read its prefix from cache");
        let pid2 = runs().lock().unwrap().get(&key).and_then(|r| r.child.id()).expect("idle between turns");
        assert_eq!(pid2, pid, "the same process, not a new one");

        // The next user turn goes to the same process too.
        let mut answered = next.clone();
        answered.messages.push(msg("assistant", &agg.content));
        answered.messages.push(msg("user", "And in Bergen? Use the tool."));
        let response = stream(Cli::Claude, &answered, session).await.unwrap();
        let s = crate::llm::client::LlmStream { response, dialect: crate::llm::responses::Dialect::ChatCompletions };
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let agg = crate::llm::streaming::consume_stream(s, cancel, false, |_| {}).await.unwrap();
        assert!(agg.error.is_none(), "{:?}", agg.error);
        assert!(agg.tool_calls[0].function.arguments.contains("Bergen"), "{:?}", agg.tool_calls);
        let u = agg.usage.clone().expect("usage");
        eprintln!("turn 2: {} prompt tokens, {} cached", u.prompt_tokens, u.cached_prompt_tokens());
        let run = runs().lock().unwrap().remove(&key).expect("parked again");
        assert_eq!(run.child.id(), Some(pid));
    }

    /// Against the real CLI, through the real stream consumer. Needs `claude`
    /// installed and signed in: `cargo test --lib live_claude -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_claude() {
        let req = ChatRequest {
            model: "haiku".into(),
            messages: vec![msg("system", "Answer with one word."), msg("user", "Capital of France?")],
            temperature: None, max_tokens: None, top_p: None, tools: None, tool_choice: None,
            reasoning_effort: None, chat_template_kwargs: None, thinking_extra: Default::default(),
            thinking_ask: None, stream_options: None, stream: true,
        };
        let response = stream(Cli::Claude, &req, "live-test").await.unwrap();
        let s = crate::llm::client::LlmStream { response, dialect: crate::llm::responses::Dialect::ChatCompletions };
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let agg = crate::llm::streaming::consume_stream(s, cancel, false, |_| {}).await.unwrap();
        assert!(agg.error.is_none(), "{:?}", agg.error);
        assert!(agg.content.contains("Paris"), "{}", agg.content);
        assert!(agg.usage.is_some());
        assert!(complete(Cli::Claude, &req, "live-test").await.unwrap().choices[0].message.content.is_some());
    }
}
