//! Minimal MCP (Model Context Protocol) client — 0.4.2.
//!
//! MCP is JSON-RPC 2.0 over one of two transports:
//!   * **stdio** — spawn a local command; exchange newline-delimited JSON-RPC
//!     messages over the child's stdin/stdout. The dominant transport for
//!     desktop hosts (same model Claude Desktop uses).
//!   * **sse / streamable HTTP** — POST JSON-RPC to a remote URL; the server
//!     replies with either `application/json` or an `text/event-stream` frame.
//!
//! We deliberately hand-roll the few methods we need (`initialize`,
//! `notifications/initialized`, `tools/list`, `tools/call`) rather than pull in
//! a heavy SDK — consistent with the codebase's no-native-deps / minimal-crate
//! pattern. Live connections are cached in a process-global [`Manager`] keyed by
//! server id, so a stdio child stays warm across tool calls instead of paying
//! npx-startup per call.

pub mod catalog;
pub mod diagnose;

use crate::db::models::{McpServer, McpTool};
use crate::error::{AppError, AppResult};
use crate::llm::types::{Tool, ToolFunction};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

const PROTOCOL_VERSION: &str = "2024-11-05";
const REQUEST_TIMEOUT_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// Qualified tool names
// ---------------------------------------------------------------------------

/// First 8 hex chars of a server's UUID (dashes stripped). Stable across server
/// renames, so per-zone enablement survives editing a server's display name.
pub fn short_id(server_id: &str) -> String {
    server_id.replace('-', "").chars().take(8).collect()
}

/// The model-facing / per-zone id for an MCP tool: `mcp__<shortServerId>__<tool>`.
/// Matches the `mcp__server__tool` convention used elsewhere and stays within the
/// 64-char, `[A-Za-z0-9_-]` function-name limits for typical tool names.
pub fn qualified_name(server_id: &str, tool_name: &str) -> String {
    format!("mcp__{}__{}", short_id(server_id), tool_name)
}

/// Split a qualified name back into `(shortServerId, toolName)`. The short id is
/// a fixed 8 chars, so a tool name containing `__` round-trips correctly.
pub fn parse_qualified(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp__")?;
    if rest.len() < 10 || &rest[8..10] != "__" {
        return None;
    }
    let short = rest[..8].to_string();
    let tool = rest[10..].to_string();
    if tool.is_empty() {
        return None;
    }
    Some((short, tool))
}

pub fn is_mcp_tool(name: &str) -> bool {
    name.starts_with("mcp__")
}

// ---------------------------------------------------------------------------
// Connection status (runtime-only, surfaced to Settings)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    /// "connected" | "error" | "disconnected"
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ServerStatus {
    fn disconnected() -> Self {
        Self { state: "disconnected".into(), error: None }
    }
    fn connected() -> Self {
        Self { state: "connected".into(), error: None }
    }
    fn error(msg: impl Into<String>) -> Self {
        Self { state: "error".into(), error: Some(msg.into()) }
    }
}

/// A tool as reported by `tools/list`, before it is persisted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
}

/// A resource as reported by `resources/list` (0.15.3).
///
/// Resources are the half of MCP that is *context* rather than capability — a
/// wiki page, a schema, a dashboard's current state. We call `tools/list` and
/// `tools/call` and nothing else, so a server offering fifty documents offered
/// this app none of them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredResource {
    pub uri: String,
    pub name: String,
    pub description: Option<String>,
    pub mime_type: Option<String>,
}

/// A prompt as reported by `prompts/list` (0.15.3). A server-authored prompt
/// template, which is what a slash command is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPrompt {
    pub name: String,
    pub description: Option<String>,
    /// `{ name, description?, required? }` per the spec, passed through as-is so
    /// the UI can build a form without this layer knowing the shape.
    pub arguments: Vec<Value>,
}

// ---------------------------------------------------------------------------
// Transport connections
// ---------------------------------------------------------------------------

enum Connection {
    Stdio(StdioConn),
    Http(HttpConn),
}

impl Connection {
    async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        match self {
            Connection::Stdio(c) => c.request(method, params).await,
            Connection::Http(c) => c.request(method, params).await,
        }
    }

    async fn notify(&self, method: &str, params: Value) -> AppResult<()> {
        match self {
            Connection::Stdio(c) => c.notify(method, params).await,
            Connection::Http(c) => c.notify(method, params).await,
        }
    }
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>;

/// The tail of a stdio child's stderr, shared with the task draining it.
type StderrLog = Arc<Mutex<String>>;

/// How much of a child's stderr to keep. Enough for a stack trace or a usage
/// message; not enough for a chatty server to grow without bound.
const STDERR_KEEP_BYTES: usize = 8192;

struct StdioConn {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicI64,
    stderr: StderrLog,
    // Kept alive so the child isn't reaped; `kill_on_drop` tears it down when the
    // connection is dropped (server removed / reconnected).
    _child: Mutex<Child>,
}

impl StdioConn {
    /// Attach whatever the child printed to stderr to a failure message. The
    /// difference between "failed to connect" and a report worth reading is
    /// almost always in here.
    async fn with_stderr(&self, msg: &str) -> String {
        let log = self.stderr.lock().await;
        let tail = log.trim();
        if tail.is_empty() {
            format!("{msg} (it printed nothing to stderr)")
        } else {
            format!("{msg}. Its output:\n{tail}")
        }
    }

    fn next_line<S: Serialize>(value: &S) -> AppResult<String> {
        Ok(format!("{}\n", serde_json::to_string(value)?))
    }

    async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let line = Self::next_line(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        }))?;
        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
        }
        let resp = match tokio::time::timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS), rx).await {
            Err(_) => return Err(AppError::Other(self.with_stderr("MCP request timed out").await)),
            Ok(Err(_)) => {
                // The reader task cleared the pending map: the child's stdout is
                // closed, which means it exited. Its stderr is the answer.
                return Err(AppError::Other(
                    self.with_stderr("the MCP server exited without answering").await,
                ));
            }
            Ok(Ok(v)) => v,
        };
        extract_result(resp)
    }

    async fn notify(&self, method: &str, params: Value) -> AppResult<()> {
        let line = Self::next_line(&json!({
            "jsonrpc": "2.0", "method": method, "params": params,
        }))?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }
}

struct HttpConn {
    http: reqwest::Client,
    url: String,
    /// Extra headers from the server row, sent with every request. This is where
    /// an `Authorization: Bearer …` for a hosted server lives — without it no
    /// remote MCP server that authenticates is reachable at all (0.11.2).
    headers: Vec<(String, String)>,
    session: Mutex<Option<String>>,
    next_id: AtomicI64,
}

impl HttpConn {
    async fn send(&self, body: Value, expect_response: bool) -> AppResult<Option<Value>> {
        let mut req = self
            .http
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(&body);
        // Applied after the defaults, so a server that needs a different `Accept`
        // (some hosted servers refuse the SSE offer) can say so.
        for (k, v) in &self.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(s) = self.session.lock().await.clone() {
            req = req.header("Mcp-Session-Id", s);
        }
        let resp = req.send().await?;
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            *self.session.lock().await = Some(sid.to_string());
        }
        let status = resp.status();
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = resp.text().await?;
        if !status.is_success() {
            let body: String = text.chars().take(300).collect();
            // 401/403 is the one HTTP failure with a specific fix, and until
            // 0.11.2 it was also the one we had no way to act on. Say what to do.
            let hint = match status.as_u16() {
                401 | 403 if self.headers.is_empty() => {
                    " — this server wants credentials and none are configured. \
                     Add an `Authorization` header to the server (Settings → MCP)."
                }
                401 | 403 => {
                    " — the credentials sent were rejected. Check the `Authorization` \
                     header on this server; if it is a short-lived access token it may \
                     simply have expired."
                }
                _ => "",
            };
            return Err(AppError::Other(format!("MCP HTTP {status}{hint}: {body}")));
        }
        if !expect_response {
            return Ok(None);
        }
        let want_id = body.get("id").cloned();
        let msg = if ct.contains("text/event-stream") {
            parse_sse(&text, want_id.as_ref())?
        } else if text.trim().is_empty() {
            return Err(AppError::Other("MCP returned empty response".into()));
        } else {
            serde_json::from_str::<Value>(&text)?
        };
        Ok(Some(msg))
    }

    async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let msg = self
            .send(body, true)
            .await?
            .ok_or_else(|| AppError::Other("MCP returned no response".into()))?;
        extract_result(msg)
    }

    async fn notify(&self, method: &str, params: Value) -> AppResult<()> {
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.send(body, false).await?;
        Ok(())
    }
}

/// Pull a JSON-RPC message out of an SSE body, preferring the frame whose `id`
/// matches the request. SSE frames carry the payload on `data:` lines.
fn parse_sse(body: &str, want_id: Option<&Value>) -> AppResult<Value> {
    let mut fallback: Option<Value> = None;
    for chunk in body.split("\n\n") {
        let mut data = String::new();
        for line in chunk.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                data.push_str(rest.trim_start());
            }
        }
        if data.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&data) {
            if want_id.is_some() && v.get("id") == want_id {
                return Ok(v);
            }
            if v.get("result").is_some() || v.get("error").is_some() {
                fallback.get_or_insert(v);
            }
        }
    }
    fallback.ok_or_else(|| AppError::Other("no JSON-RPC message in MCP SSE response".into()))
}

/// Unwrap a JSON-RPC response into its `result`, mapping a JSON-RPC `error`
/// object onto an [`AppError`].
fn extract_result(resp: Value) -> AppResult<Value> {
    if let Some(err) = resp.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown MCP error");
        return Err(AppError::Other(format!("MCP error: {msg}")));
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

// ---------------------------------------------------------------------------
// Manager (process-global)
// ---------------------------------------------------------------------------

pub struct Manager {
    db: SqlitePool,
    http: reqwest::Client,
    conns: Mutex<HashMap<String, Arc<Connection>>>,
    status: Mutex<HashMap<String, ServerStatus>>,
}

static MANAGER: OnceLock<Manager> = OnceLock::new();

/// Initialise the global manager. Called once at startup.
pub fn init(db: SqlitePool, http: reqwest::Client) {
    let _ = MANAGER.set(Manager {
        db,
        http,
        conns: Mutex::new(HashMap::new()),
        status: Mutex::new(HashMap::new()),
    });
}

pub fn manager() -> &'static Manager {
    MANAGER.get().expect("MCP manager not initialised")
}

impl Manager {
    async fn set_status(&self, server_id: &str, status: ServerStatus) {
        self.status.lock().await.insert(server_id.to_string(), status);
    }

    /// Current cached status for a server (defaults to disconnected).
    pub async fn status(&self, server_id: &str) -> ServerStatus {
        self.status
            .lock()
            .await
            .get(server_id)
            .cloned()
            .unwrap_or_else(ServerStatus::disconnected)
    }

    /// Drop a live connection (if any) and mark the server disconnected.
    pub async fn disconnect(&self, server_id: &str) {
        self.conns.lock().await.remove(server_id);
        self.set_status(server_id, ServerStatus::disconnected()).await;
    }

    /// Open a fresh connection to a server, run the initialize handshake, and
    /// return its advertised tools. Replaces any existing connection. Updates the
    /// cached status to connected/error.
    pub async fn connect(&self, server: &McpServer) -> AppResult<Vec<DiscoveredTool>> {
        match self.connect_inner(server).await {
            Ok(tools) => {
                self.set_status(&server.id, ServerStatus::connected()).await;
                Ok(tools)
            }
            Err(e) => {
                self.conns.lock().await.remove(&server.id);
                self.set_status(&server.id, ServerStatus::error(e.to_string())).await;
                Err(e)
            }
        }
    }

    async fn connect_inner(&self, server: &McpServer) -> AppResult<Vec<DiscoveredTool>> {
        let conn = Arc::new(self.open(server).await?);

        // initialize handshake
        let init_params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "MultiZone", "version": env!("CARGO_PKG_VERSION") },
        });
        conn.request("initialize", init_params).await?;
        conn.notify("notifications/initialized", json!({})).await?;

        let tools = list_tools(&conn).await?;

        self.conns.lock().await.insert(server.id.clone(), conn);
        Ok(tools)
    }

    async fn open(&self, server: &McpServer) -> AppResult<Connection> {
        match server.transport.as_str() {
            "stdio" => self.open_stdio(server),
            "sse" | "http" => self.open_http(server),
            other => Err(AppError::Invalid(format!("unknown MCP transport: {other}"))),
        }
    }

    /// Resolve a bare program name to a concrete executable on Windows.
    ///
    /// `CreateProcess` (what `Command::new` ends up calling) does not do the
    /// PATHEXT lookup a shell does, so `Command::new("npx")` fails with "program
    /// not found" even when npx is installed — the real file is `npx.cmd`, a
    /// batch shim, and only a literal `npx.exe` would ever be found. Node-based
    /// MCP servers (`npx @playwright/mcp@latest`, `npx -y …`) hit this every
    /// time. We walk PATH × PATHEXT ourselves and hand back the full path.
    ///
    /// Returns `None` when nothing matches, so the caller can fall through to
    /// the original name and produce the normal spawn error.
    #[cfg(windows)]
    fn resolve_program_windows(program: &str) -> Option<std::path::PathBuf> {
        use std::path::Path;

        // An explicit path or an already-extensioned name needs no lookup.
        if program.contains('/') || program.contains('\\') {
            let p = Path::new(program);
            return p.is_file().then(|| p.to_path_buf());
        }

        let exts: Vec<String> = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(|e| e.trim().to_ascii_lowercase())
            .filter(|e| !e.is_empty())
            .collect();

        if Path::new(program).extension().is_some() {
            for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
                let cand = dir.join(program);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }

        for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
            for ext in &exts {
                let cand = dir.join(format!("{program}{ext}"));
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
        None
    }

    fn open_stdio(&self, server: &McpServer) -> AppResult<Connection> {
        let command = server
            .command
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::Invalid("stdio server has no command".into()))?;
        let parts = shell_split(command);
        let (program, args) = parts
            .split_first()
            .ok_or_else(|| AppError::Invalid("empty MCP command".into()))?;

        // On Windows resolve through PATHEXT, then route batch shims (.cmd/.bat,
        // which is what npx/npm/yarn actually are) through cmd.exe — CreateProcess
        // cannot execute a batch file directly.
        #[cfg(windows)]
        let mut cmd = {
            match Self::resolve_program_windows(program) {
                Some(path) => {
                    let is_batch = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| {
                            let e = e.to_ascii_lowercase();
                            e == "cmd" || e == "bat"
                        })
                        .unwrap_or(false);
                    if is_batch {
                        let mut c = tokio::process::Command::new("cmd.exe");
                        c.arg("/C").arg(&path);
                        c
                    } else {
                        tokio::process::Command::new(&path)
                    }
                }
                None => tokio::process::Command::new(program),
            }
        };
        #[cfg(not(windows))]
        let mut cmd = tokio::process::Command::new(program);

        cmd.args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            // Captured rather than discarded: when a stdio server exits during
            // the handshake, its stderr is the only place that says *why* — "the
            // command ran, the server exited, GOOGLE_CREDENTIALS_PATH is not
            // set" instead of "failed to connect" (0.11.2).
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        // Optional env overrides (JSON object).
        for (k, v) in json_string_map(server.env.as_deref()) {
            cmd.env(k, v);
        }

        // Suppress the console window flash on Windows for the child process.
        // `creation_flags` is an inherent method on tokio's Command on Windows.
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Other(format!(
                    "failed to start MCP server '{program}': program not found. \
                     Check it is installed and on PATH — the app inherits the PATH \
                     it was launched with, so a freshly installed tool may need a \
                     restart of the app (or of your session) to be visible."
                ))
            } else {
                AppError::Other(format!("failed to start MCP server '{program}': {e}"))
            }
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Other("MCP child has no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Other("MCP child has no stdout".into()))?;

        // Keep the tail of the child's stderr. A server that refuses to start
        // says so here and nowhere else.
        let stderr_log: StderrLog = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let log = stderr_log.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut buf = log.lock().await;
                    buf.push_str(line.trim_end());
                    buf.push('\n');
                    if buf.len() > STDERR_KEEP_BYTES {
                        let cut = buf.len() - STDERR_KEEP_BYTES;
                        let cut = buf
                            .char_indices()
                            .map(|(i, _)| i)
                            .find(|i| *i >= cut)
                            .unwrap_or(buf.len());
                        buf.replace_range(..cut, "");
                    }
                }
            });
        }

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(id) = v.get("id").and_then(Value::as_i64) {
                        if let Some(tx) = reader_pending.lock().await.remove(&id) {
                            let _ = tx.send(v);
                        }
                    }
                }
            }
            // stdout closed — fail any awaiting requests by dropping their senders.
            reader_pending.lock().await.clear();
        });

        Ok(Connection::Stdio(StdioConn {
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicI64::new(1),
            stderr: stderr_log,
            _child: Mutex::new(child),
        }))
    }

    fn open_http(&self, server: &McpServer) -> AppResult<Connection> {
        let url = server
            .url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::Invalid("sse server has no URL".into()))?;
        Ok(Connection::Http(HttpConn {
            http: self.http.clone(),
            url: url.to_string(),
            headers: json_string_map(server.headers.as_deref()),
            session: Mutex::new(None),
            next_id: AtomicI64::new(1),
        }))
    }

    /// Call a tool by its qualified name (`mcp__<shortId>__<tool>`), connecting
    /// lazily if no live connection exists. Returns the textual tool output.
    pub async fn call(&self, qualified: &str, arguments: Value) -> AppResult<String> {
        let (short, tool) = parse_qualified(qualified)
            .ok_or_else(|| AppError::Invalid(format!("not an MCP tool: {qualified}")))?;
        let server = self.server_by_short_id(&short).await?;

        let conn = self.ensure_connected(&server).await?;
        let result = conn
            .request("tools/call", json!({ "name": tool, "arguments": arguments }))
            .await?;
        Ok(render_tool_result(&result))
    }

    /// Every resource a server currently offers (0.15.3).
    ///
    /// A server that does not implement the method is not an error — it is a
    /// server without resources, which is most of them. The JSON-RPC error
    /// comes back as `Err`, and both callers turn that into an empty list
    /// rather than a failure the user has to read.
    pub async fn list_resources(&self, server_id: &str) -> AppResult<Vec<DiscoveredResource>> {
        let server = self.server_by_id(server_id).await?;
        let conn = self.ensure_connected(&server).await?;
        let result = conn.request("resources/list", json!({})).await?;
        Ok(result
            .get("resources")
            .and_then(Value::as_array)
            .map(|rs| {
                rs.iter()
                    .filter_map(|r| {
                        let uri = r.get("uri")?.as_str()?.to_string();
                        Some(DiscoveredResource {
                            name: r
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or(&uri)
                                .to_string(),
                            uri,
                            description: r.get("description").and_then(Value::as_str).map(str::to_string),
                            mime_type: r.get("mimeType").and_then(Value::as_str).map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Read one resource, flattened to text the model can be handed.
    pub async fn read_resource(&self, server_id: &str, uri: &str) -> AppResult<String> {
        let server = self.server_by_id(server_id).await?;
        let conn = self.ensure_connected(&server).await?;
        let result = conn.request("resources/read", json!({ "uri": uri })).await?;
        Ok(render_resource_contents(&result))
    }

    /// Every prompt a server offers (0.15.3).
    pub async fn list_prompts(&self, server_id: &str) -> AppResult<Vec<DiscoveredPrompt>> {
        let server = self.server_by_id(server_id).await?;
        let conn = self.ensure_connected(&server).await?;
        let result = conn.request("prompts/list", json!({})).await?;
        Ok(result
            .get("prompts")
            .and_then(Value::as_array)
            .map(|ps| {
                ps.iter()
                    .filter_map(|p| {
                        Some(DiscoveredPrompt {
                            name: p.get("name")?.as_str()?.to_string(),
                            description: p.get("description").and_then(Value::as_str).map(str::to_string),
                            arguments: p
                                .get("arguments")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Expand a prompt template into the text it stands for.
    pub async fn get_prompt(
        &self,
        server_id: &str,
        name: &str,
        arguments: Value,
    ) -> AppResult<String> {
        let server = self.server_by_id(server_id).await?;
        let conn = self.ensure_connected(&server).await?;
        let result = conn
            .request("prompts/get", json!({ "name": name, "arguments": arguments }))
            .await?;
        Ok(render_prompt_messages(&result))
    }

    async fn server_by_id(&self, id: &str) -> AppResult<McpServer> {
        sqlx::query_as::<_, McpServer>(&format!(
            "SELECT {SERVER_COLS} FROM mcp_servers WHERE id = ?1"
        ))
        .bind(id)
        .fetch_optional(&self.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("MCP server {id}")))
    }

    /// Return a live connection for a server, opening one if needed.
    async fn ensure_connected(&self, server: &McpServer) -> AppResult<Arc<Connection>> {
        if let Some(conn) = self.conns.lock().await.get(&server.id).cloned() {
            return Ok(conn);
        }
        self.connect(server).await?;
        self.conns
            .lock()
            .await
            .get(&server.id)
            .cloned()
            .ok_or_else(|| AppError::Other("MCP connection lost".into()))
    }

    async fn server_by_short_id(&self, short: &str) -> AppResult<McpServer> {
        let servers = sqlx::query_as::<_, McpServer>(&format!(
            "SELECT {SERVER_COLS} FROM mcp_servers"
        ))
        .fetch_all(&self.db)
        .await?;
        servers
            .into_iter()
            .find(|s| short_id(&s.id) == short)
            .ok_or_else(|| AppError::NotFound(format!("MCP server {short}")))
    }
}

pub const SERVER_COLS: &str =
    "id, name, transport, command, url, env, headers, catalog_id, enabled, created_at, updated_at";

/// Read one of the `env` / `headers` columns: a JSON object of string values.
/// Anything that isn't a string is skipped rather than stringified — a header
/// value of `true` is a mistake to ignore, not one to send as `"true"`.
pub fn json_string_map(raw: Option<&str>) -> Vec<(String, String)> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => map
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

async fn list_tools(conn: &Connection) -> AppResult<Vec<DiscoveredTool>> {
    let result = conn.request("tools/list", json!({})).await?;
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(tools
        .into_iter()
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?.to_string();
            Some(DiscoveredTool {
                name,
                description: t
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input_schema: t.get("inputSchema").cloned(),
            })
        })
        .collect())
}

/// Flatten a `resources/read` result into text (0.15.3).
///
/// MCP returns `{ contents: [{ uri, mimeType?, text? | blob? }] }`. Binary
/// (`blob`) parts are named rather than decoded: base64 image bytes pasted into
/// a prompt are tokens spent on nothing, and the user is better told that the
/// resource is binary than handed 40KB of it.
fn render_resource_contents(result: &Value) -> String {
    let mut out = String::new();
    let Some(parts) = result.get("contents").and_then(Value::as_array) else {
        return out;
    };
    for part in parts {
        if !out.is_empty() {
            out.push_str("

");
        }
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            out.push_str(text);
        } else if part.get("blob").is_some() {
            let uri = part.get("uri").and_then(Value::as_str).unwrap_or("resource");
            let mime = part
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            out.push_str(&format!("[binary resource {uri} ({mime}) — not inlined]"));
        }
    }
    out
}

/// Flatten a `prompts/get` result into the text it stands for (0.15.3).
///
/// The result is a message list with roles. We keep the text and drop the
/// roles: this becomes the body of a message the *user* is about to send, so
/// re-labelling half of it "assistant" would be a claim about a turn that never
/// happened.
fn render_prompt_messages(result: &Value) -> String {
    let mut out = String::new();
    let Some(messages) = result.get("messages").and_then(Value::as_array) else {
        return out;
    };
    for m in messages {
        let content = m.get("content");
        // A single content object, or an array of them — the spec allows both.
        let parts: Vec<&Value> = match content {
            Some(Value::Array(a)) => a.iter().collect(),
            Some(v) => vec![v],
            None => continue,
        };
        for part in parts {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push_str("

");
                }
                out.push_str(text);
            }
        }
    }
    out
}

/// Flatten an MCP `tools/call` result into a plain string for the model. MCP
/// returns `{ content: [{type:"text", text}, ...], isError? }`; we join text
/// parts and prefix errors so the model can react.
fn render_tool_result(result: &Value) -> String {
    let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
    let mut out = String::new();
    if let Some(parts) = result.get("content").and_then(Value::as_array) {
        for part in parts {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = part.get("text").and_then(Value::as_str) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(t);
                    }
                }
                _ => {
                    // Non-text content (images/resources) — pass through as JSON
                    // so nothing is silently dropped.
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(&part.to_string());
                }
            }
        }
    }
    if out.is_empty() {
        out = result.to_string();
    }
    if is_error {
        format!("Tool reported an error: {out}")
    } else {
        out
    }
}

// ---------------------------------------------------------------------------
// Tool-definition / danger helpers for the message pipeline
// ---------------------------------------------------------------------------

/// Build OpenAI tool definitions for the MCP ids enabled on a zone. `enabled`
/// holds the qualified ids stored in `zone.tools_enabled`; anything that isn't a
/// known, persisted MCP tool is skipped.
pub async fn tool_defs_for_ids(db: &SqlitePool, enabled: &[String]) -> Vec<Tool> {
    let wanted: std::collections::HashSet<&str> = enabled
        .iter()
        .filter(|id| is_mcp_tool(id))
        .map(String::as_str)
        .collect();
    if wanted.is_empty() {
        return Vec::new();
    }
    let rows = match fetch_enabled_tools(db, &wanted).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("MCP tool_defs_for_ids failed: {e}");
            return Vec::new();
        }
    };
    rows.into_iter()
        .map(|(qualified, tool)| {
            let parameters = tool
                .input_schema
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            Tool {
                tool_type: "function".into(),
                function: ToolFunction {
                    name: qualified,
                    description: tool.description.clone().unwrap_or_default(),
                    parameters,
                },
            }
        })
        .collect()
}

/// Map qualified MCP tool name → danger level for the zone's enabled MCP tools,
/// consumed by the approval gate alongside built-in `tool_safety_by_name`.
pub async fn danger_for_ids(db: &SqlitePool, enabled: &[String]) -> HashMap<String, u8> {
    let wanted: std::collections::HashSet<&str> = enabled
        .iter()
        .filter(|id| is_mcp_tool(id))
        .map(String::as_str)
        .collect();
    if wanted.is_empty() {
        return HashMap::new();
    }
    match fetch_enabled_tools(db, &wanted).await {
        Ok(rows) => rows
            .into_iter()
            .map(|(qualified, tool)| (qualified, tool.danger_level.clamp(0, 2) as u8))
            .collect(),
        Err(e) => {
            tracing::warn!("MCP danger_for_ids failed: {e}");
            HashMap::new()
        }
    }
}

/// Load every persisted MCP tool whose qualified id is in `wanted`, pairing each
/// with its computed qualified name.
async fn fetch_enabled_tools(
    db: &SqlitePool,
    wanted: &std::collections::HashSet<&str>,
) -> AppResult<Vec<(String, McpTool)>> {
    // `id`, `name`, `created_at` and `updated_at` exist on BOTH mcp_tools and
    // mcp_servers, so the bare `TOOL_COLS` list is ambiguous across this join —
    // SQLite rejects it with "ambiguous column name", the error is swallowed by
    // the callers, and the zone silently receives zero MCP tools. Qualify every
    // selected column with the mcp_tools alias so the join is unambiguous.
    let cols = TOOL_COLS
        .split(", ")
        .map(|c| format!("t.{c}"))
        .collect::<Vec<_>>()
        .join(", ");
    let rows = sqlx::query_as::<_, McpTool>(&format!(
        "SELECT {cols} FROM mcp_tools t
         JOIN mcp_servers s ON s.id = t.server_id
         WHERE s.enabled = 1"
    ))
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|t| {
            let qualified = qualified_name(&t.server_id, &t.name);
            wanted.contains(qualified.as_str()).then_some((qualified, t))
        })
        .collect())
}

pub const TOOL_COLS: &str =
    "id, server_id, name, description, input_schema, danger_level, created_at, updated_at";

/// A very small shell-style splitter: whitespace-separated, honouring single and
/// double quotes. Enough for MCP command lines like
/// `npx -y @scope/server --root "C:\\Program Files"`.
pub(crate) fn shell_split(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has_token = false;
    for c in input.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    has_token = true;
                }
                c if c.is_whitespace() => {
                    if has_token {
                        out.push(std::mem::take(&mut cur));
                        has_token = false;
                    }
                }
                _ => {
                    cur.push(c);
                    has_token = true;
                }
            },
        }
    }
    if has_token {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_name_round_trips() {
        let sid = "a1b2c3d4-5678-90ab-cdef-1234567890ab";
        let q = qualified_name(sid, "search_files");
        assert_eq!(q, "mcp__a1b2c3d4__search_files");
        let (short, tool) = parse_qualified(&q).unwrap();
        assert_eq!(short, short_id(sid));
        assert_eq!(tool, "search_files");
    }

    #[test]
    fn qualified_name_with_double_underscore_tool() {
        let sid = "ffffffff-0000-0000-0000-000000000000";
        let q = qualified_name(sid, "do__thing");
        let (_short, tool) = parse_qualified(&q).unwrap();
        assert_eq!(tool, "do__thing");
    }

    #[test]
    fn non_mcp_names_dont_parse() {
        assert!(parse_qualified("web_search").is_none());
        assert!(!is_mcp_tool("web_search"));
        assert!(is_mcp_tool("mcp__abcd1234__x"));
    }

    #[test]
    fn shell_split_quotes() {
        let parts = shell_split(r#"npx -y @scope/server --root "C:\Program Files""#);
        assert_eq!(parts, vec!["npx", "-y", "@scope/server", "--root", r"C:\Program Files"]);
    }
}

#[cfg(test)]
mod resource_prompt_tests {
    use super::*;

    #[test]
    fn resource_text_parts_are_joined() {
        let v = json!({ "contents": [
            { "uri": "file:///a", "text": "first" },
            { "uri": "file:///b", "text": "second" }
        ]});
        assert_eq!(render_resource_contents(&v), "first

second");
    }

    /// Base64 image bytes pasted into a prompt are tokens spent on nothing. The
    /// user is better told the resource is binary than handed 40KB of it.
    #[test]
    fn a_binary_resource_is_named_rather_than_inlined() {
        let v = json!({ "contents": [
            { "uri": "file:///logo.png", "mimeType": "image/png", "blob": "iVBORw0KGgo=" }
        ]});
        let out = render_resource_contents(&v);
        assert!(out.contains("file:///logo.png"), "{out}");
        assert!(out.contains("image/png"), "{out}");
        assert!(!out.contains("iVBORw0KGgo"), "the bytes must not be inlined: {out}");
    }

    /// A server that answers with a shape we did not expect gets an empty
    /// string, not a panic — this runs against third-party code.
    #[test]
    fn a_result_with_no_contents_is_empty_not_a_panic() {
        assert_eq!(render_resource_contents(&json!({})), "");
        assert_eq!(render_resource_contents(&json!({ "contents": "nope" })), "");
        assert_eq!(render_prompt_messages(&json!({})), "");
        assert_eq!(render_prompt_messages(&json!({ "messages": [{}] })), "");
    }

    /// The spec allows `content` to be one object or a list of them.
    #[test]
    fn prompt_content_is_read_in_both_shapes() {
        let single = json!({ "messages": [
            { "role": "user", "content": { "type": "text", "text": "review this" } }
        ]});
        assert_eq!(render_prompt_messages(&single), "review this");

        let many = json!({ "messages": [
            { "role": "user", "content": [
                { "type": "text", "text": "one" },
                { "type": "text", "text": "two" }
            ]}
        ]});
        assert_eq!(render_prompt_messages(&many), "one

two");
    }

    /// Roles are dropped on purpose: the expansion becomes the body of a
    /// message the *user* is about to send, so labelling half of it "assistant"
    /// would assert a turn that never happened.
    #[test]
    fn roles_are_dropped_and_every_turn_is_kept() {
        let v = json!({ "messages": [
            { "role": "user", "content": { "type": "text", "text": "context" } },
            { "role": "assistant", "content": { "type": "text", "text": "and more" } }
        ]});
        let out = render_prompt_messages(&v);
        assert_eq!(out, "context

and more");
        assert!(!out.contains("assistant"));
    }

    /// A resource with no name falls back to its URI, so a picker never shows a
    /// blank row.
    #[test]
    fn a_nameless_resource_is_labelled_by_its_uri() {
        let r = json!({ "uri": "file:///notes.md" });
        let name = r.get("name").and_then(Value::as_str)
            .unwrap_or_else(|| r.get("uri").unwrap().as_str().unwrap());
        assert_eq!(name, "file:///notes.md");
    }
}
