//! A locally installed agent CLI as a provider (0.19.1): Claude Code or Codex,
//! running on whatever subscription the user signed it into.
//!
//! A provider whose base URL is `cli://claude` or `cli://codex` is not reached
//! over HTTP. Each request spawns the CLI in print mode, feeds it the
//! conversation on stdin, and translates its JSON event lines into the
//! OpenAI-compatible SSE chunks the stream consumer already reads — so chat,
//! panels, compaction and titles work unchanged.
//!
//! The CLI is used as a model, not as an agent: Claude Code runs with none of
//! its own tools, no user settings and the app's own system prompt; Codex
//! runs read-only.
//!
//! The app's tools reach it over MCP, but are never run by it. A loopback MCP
//! server lives for the request and only lists them. When the model calls
//! one, the call goes back to the app as an ordinary tool call and the CLI is
//! stopped at the end of that message. The app's own loop then runs the tool
//! (approvals, visuals, checkpoints, runaway guards) and sends the result on
//! the next request, exactly as it would to an HTTP provider.

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
    /// The model called an app tool: end the stream here, before the CLI
    /// tries to run it.
    cut: bool,
    /// Claude content-block index → OpenAI tool-call index.
    blocks: std::collections::HashMap<u64, usize>,
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
                            Ok(vec![call(index, b["id"].as_str(), Some(name), "")])
                        }
                        Some("content_block_delta") => {
                            let d = &ev["delta"];
                            Ok(match d["type"].as_str() {
                                Some("text_delta") => vec![delta("content", d["text"].as_str().unwrap_or(""))],
                                Some("thinking_delta") => {
                                    vec![delta("reasoning_content", d["thinking"].as_str().unwrap_or(""))]
                                }
                                Some("input_json_delta") => match self.blocks.get(&block) {
                                    Some(&i) => vec![call(i, None, None, d["partial_json"].as_str().unwrap_or(""))],
                                    None => vec![],
                                },
                                _ => vec![],
                            })
                        }
                        Some("message_delta") => {
                            self.usage = Some(ev["usage"].clone());
                            Ok(vec![])
                        }
                        // The end of a message that called tools: the CLI would
                        // run them next, and the app is the one that should.
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
                // Codex reports a tool call as it starts; stop it there.
                "item.started"
                    if v["item"]["type"] == "mcp_tool_call" && v["item"]["server"] == "multizone" =>
                {
                    let item = &v["item"];
                    let args = match &item["arguments"] {
                        Value::String(s) => s.clone(),
                        Value::Null => "{}".to_string(),
                        a => a.to_string(),
                    };
                    self.done = true;
                    self.cut = true;
                    Ok(vec![call(0, item["id"].as_str(), item["tool"].as_str(), &args), tool_finish()])
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

/// Ends the request's MCP server.
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

/// One JSON-RPC message to the bridge, answered; `None` for a notification.
/// A `tools/call` is never answered: by then the stream has been cut, the CLI
/// is being stopped, and the app runs the tool itself.
async fn rpc(tools: &Value, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let result = match msg["method"].as_str() {
        Some("initialize") => json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "multizone", "version": env!("CARGO_PKG_VERSION") },
        }),
        Some("tools/list") => json!({ "tools": tools }),
        Some("ping") => json!({}),
        Some("tools/call") => std::future::pending().await,
        _ => {
            return Some(json!({ "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": "method not found" } }))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// A streamable-HTTP MCP server on loopback for one request, at an
/// unguessable path. Returns its URL.
async fn serve_tools(tools: &[Tool]) -> AppResult<(String, Server)> {
    use axum::{http::StatusCode, response::IntoResponse, routing::post, Json, Router};
    let tools = std::sync::Arc::new(mcp_tools(tools));
    let path = format!("/mcp/{}", uuid::Uuid::new_v4().simple());
    let app = Router::new().route(
        &path,
        post(move |Json(msg): Json<Value>| {
            let tools = tools.clone();
            async move {
                match rpc(&tools, &msg).await {
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

/// Spawn the CLI for this request and return its reply as an SSE response.
pub async fn stream(cli: Cli, req: &ChatRequest) -> AppResult<reqwest::Response> {
    let model = safe_model(&req.model)?;
    let (system, mut prompt) = flatten(&req.messages);
    let dir = std::env::temp_dir();
    let mut guard = None;
    let mut mcp_guard = None;

    // The tools this step offers, served to the CLI for the life of the run.
    let server = match req.tools.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => Some(serve_tools(t).await?),
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
                mcp_guard = Some(TempFile(path));
            }
            if !system.trim().is_empty() {
                // A file, not an argument: system prompts outgrow Windows'
                // 32K command line.
                let path = dir.join(format!("multizone-cli-{}.txt", uuid::Uuid::new_v4()));
                std::fs::write(&path, &system)?;
                cmd.arg("--system-prompt-file").arg(&path);
                guard = Some(TempFile(path));
            }
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
            }
            cmd.arg("-");
        }
    }
    // Codex has no system-prompt flag; Claude's went in a file above.
    let stdin_text = match cli {
        Cli::Codex if !system.trim().is_empty() => format!("<instructions>\n{system}\n</instructions>\n\n{prompt}"),
        _ => prompt,
    };

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
    tokio::spawn(async move {
        let _ = stdin.write_all(stdin_text.as_bytes()).await;
        // Dropped here, closing stdin so the CLI starts.
    });
    let stdout = BufReader::new(child.stdout.take().expect("piped")).lines();
    let stderr = child.stderr.take().expect("piped");

    struct St {
        cli: Cli,
        child: tokio::process::Child,
        lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
        stderr: Option<tokio::process::ChildStderr>,
        t: Translator,
        ended: bool,
        _guards: (Option<TempFile>, Option<TempFile>, Option<(String, Server)>),
    }
    let st = St {
        cli,
        child,
        lines: stdout,
        stderr: Some(stderr),
        t: Translator::default(),
        ended: false,
        _guards: (guard, mcp_guard, server),
    };

    // Dropping the stream (stop button, finished turn) drops the child, and
    // kill_on_drop ends the process.
    let body = futures_util::stream::unfold(st, |mut st| async move {
        if st.ended {
            return None;
        }
        loop {
            match st.lines.next_line().await {
                Ok(Some(line)) => {
                    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    match st.t.line(st.cli, &v) {
                        Ok(chunks) if chunks.is_empty() => continue,
                        Ok(chunks) => {
                            let mut sse: String =
                                chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
                            // Ending here drops the state, and with it the
                            // CLI, before it can try to run the tool.
                            if st.t.cut {
                                sse.push_str("data: [DONE]\n\n");
                                st.ended = true;
                            }
                            return Some((Ok::<_, std::io::Error>(sse), st));
                        }
                        Err(msg) => {
                            st.ended = true;
                            return Some((Err(std::io::Error::other(msg)), st));
                        }
                    }
                }
                Ok(None) => {
                    st.ended = true;
                    if st.t.done {
                        return Some((Ok("data: [DONE]\n\n".to_string()), st));
                    }
                    // Exited without finishing: stderr says why.
                    let mut err = String::new();
                    if let Some(mut e) = st.stderr.take() {
                        let _ = tokio::io::AsyncReadExt::read_to_string(&mut e, &mut err).await;
                    }
                    let status = st.child.wait().await.ok();
                    let msg = format!(
                        "{} exited ({}) without an answer: {}",
                        st.cli.label(),
                        status.map(|s| s.to_string()).unwrap_or_default(),
                        err.trim()
                    );
                    return Some((Err(std::io::Error::other(msg)), st));
                }
                Err(e) => {
                    st.ended = true;
                    return Some((Err(e), st));
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
pub async fn complete(cli: Cli, req: &ChatRequest) -> AppResult<ChatResponse> {
    let res = stream(cli, req).await?;
    let mut events = eventsource_stream::Eventsource::eventsource(res.bytes_stream());
    let (mut content, mut usage) = (String::new(), None);
    while let Some(ev) = events.next().await {
        let ev = ev.map_err(|e| AppError::Provider(e.to_string()))?;
        if ev.data == "[DONE]" {
            break;
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
    async fn the_bridge_lists_tools_and_never_runs_them() {
        let tools = json!([{ "name": "read_file" }]);
        let init = rpc(&tools, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}})).await.unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(rpc(&tools, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.is_none());
        let list = rpc(&tools, &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).await.unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], "read_file");
        let msg = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file"}});
        let call = rpc(&tools, &msg);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(100), call).await.is_err());
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
        let response = stream(Cli::Claude, &req).await.unwrap();
        let s = crate::llm::client::LlmStream { response, dialect: crate::llm::responses::Dialect::ChatCompletions };
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let agg = crate::llm::streaming::consume_stream(s, cancel, false, |_| {}).await.unwrap();
        assert!(agg.error.is_none(), "{:?}", agg.error);
        assert_eq!(agg.finish_reason.as_deref(), Some("tool_calls"));
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
        let response = stream(Cli::Claude, &next).await.unwrap();
        let s = crate::llm::client::LlmStream { response, dialect: crate::llm::responses::Dialect::ChatCompletions };
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let agg = crate::llm::streaming::consume_stream(s, cancel, false, |_| {}).await.unwrap();
        assert!(agg.tool_calls.is_empty(), "called again: {:?}", agg.tool_calls);
        assert!(agg.content.contains("-3") || agg.content.to_lowercase().contains("snow"), "{}", agg.content);
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
        let response = stream(Cli::Claude, &req).await.unwrap();
        let s = crate::llm::client::LlmStream { response, dialect: crate::llm::responses::Dialect::ChatCompletions };
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let agg = crate::llm::streaming::consume_stream(s, cancel, false, |_| {}).await.unwrap();
        assert!(agg.error.is_none(), "{:?}", agg.error);
        assert!(agg.content.contains("Paris"), "{}", agg.content);
        assert!(agg.usage.is_some());
        assert!(complete(Cli::Claude, &req).await.unwrap().choices[0].message.content.is_some());
    }
}
