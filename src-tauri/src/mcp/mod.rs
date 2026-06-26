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

struct StdioConn {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicI64,
    // Kept alive so the child isn't reaped; `kill_on_drop` tears it down when the
    // connection is dropped (server removed / reconnected).
    _child: Mutex<Child>,
}

impl StdioConn {
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
        let resp = tokio::time::timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS), rx)
            .await
            .map_err(|_| {
                AppError::Other("MCP request timed out".into())
            })?
            .map_err(|_| AppError::Other("MCP connection closed".into()))?;
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
            return Err(AppError::Other(format!(
                "MCP HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            )));
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

        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);

        // Optional env overrides (JSON object).
        if let Some(env_raw) = &server.env {
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(env_raw) {
                for (k, v) in map {
                    if let Some(s) = v.as_str() {
                        cmd.env(k, s);
                    }
                }
            }
        }

        // Suppress the console window flash on Windows for the child process.
        // `creation_flags` is an inherent method on tokio's Command on Windows.
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            AppError::Other(format!("failed to start MCP server '{program}': {e}"))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Other("MCP child has no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Other("MCP child has no stdout".into()))?;

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
    "id, name, transport, command, url, env, enabled, created_at, updated_at";

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
fn shell_split(input: &str) -> Vec<String> {
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
