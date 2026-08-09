//! Why a connector isn't working (0.11.2).
//!
//! "Failed to connect" is true of every failure and useful for none of them. A
//! diagnosis runs the checks in the order they can fail — is there a command at
//! all, is that program on the PATH the app inherited, are the credentials the
//! catalog says are required actually filled in, and only then the handshake —
//! and reports the *first* one that is false, with the thing to do about it.
//!
//! The checks before the handshake are the point. A missing `TAVILY_API_KEY` and
//! an npx that isn't installed both surface as a child that exits immediately,
//! and telling those apart afterwards means reading stderr and guessing. Asking
//! first costs nothing and answers precisely.

use super::catalog::ConnectorEntry;
use crate::db::models::McpServer;
use crate::mcp::{self, json_string_map};
use serde::Serialize;
use std::path::PathBuf;

/// One question, answered. `ok: false` on the first check is the answer; later
/// checks are not run, because a handshake against a server with no credentials
/// only produces a second, vaguer version of the same failure.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub ok: bool,
    /// What was actually found — a resolved path, a missing variable's name, the
    /// server's own error. Written to be read by a person.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub server_id: String,
    pub ok: bool,
    /// One line: what is wrong, or that nothing is.
    pub summary: String,
    pub checks: Vec<Check>,
    /// The concrete next action, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_step: Option<String>,
    /// Where to read more — the catalog entry's docs, or the page a missing
    /// credential comes from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
}

fn pass(name: &str, detail: impl Into<String>) -> Check {
    Check { name: name.into(), ok: true, detail: detail.into() }
}

fn fail(name: &str, detail: impl Into<String>) -> Check {
    Check { name: name.into(), ok: false, detail: detail.into() }
}

/// Find a program the way the launcher will. On Windows that means PATHEXT,
/// because `npx` is really `npx.cmd` and `CreateProcess` will not find it;
/// elsewhere it is a plain PATH walk for an executable file.
fn on_path(program: &str) -> Option<PathBuf> {
    if program.contains('/') || program.contains('\\') {
        let p = PathBuf::from(program);
        return p.is_file().then_some(p);
    }
    #[cfg(windows)]
    {
        match crate::util::program::resolve(program) {
            Some(crate::util::program::Resolved::Exe(p))
            | Some(crate::util::program::Resolved::Batch(p)) => Some(p),
            None => None,
        }
    }
    #[cfg(not(windows))]
    {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|cand| cand.is_file())
    }
}

/// Run the checks. `entry` is the catalog entry the server was installed from,
/// when there is one — it is what makes "you have not set TAVILY_API_KEY"
/// possible instead of "the server exited".
pub async fn run(server: &McpServer, entry: Option<&ConnectorEntry>) -> Diagnosis {
    let mut checks: Vec<Check> = Vec::new();
    let docs_url = entry.and_then(|e| e.docs_url.clone());

    macro_rules! stop {
        ($summary:expr, $next:expr) => {{
            let ok = false;
            return Diagnosis {
                server_id: server.id.clone(),
                ok,
                summary: $summary,
                checks,
                next_step: $next,
                docs_url,
            };
        }};
    }

    if !server.enabled {
        checks.push(fail("enabled", "this server is switched off, so its tools are hidden from every zone"));
        stop!(
            "the server is disabled".into(),
            Some("switch it on in Settings → MCP, then connect".into())
        );
    }
    checks.push(pass("enabled", "on"));

    match server.transport.as_str() {
        "stdio" => {
            let command = server.command.as_deref().unwrap_or("").trim().to_string();
            if command.is_empty() {
                checks.push(fail("command", "no command is configured"));
                stop!("no command to run".into(), Some("edit the server and give it a command".into()));
            }
            let parts = mcp::shell_split(&command);
            let program = parts.first().cloned().unwrap_or_default();
            checks.push(pass("command", command.clone()));

            match on_path(&program) {
                Some(path) => checks.push(pass("program", format!("{program} → {}", path.display()))),
                None => {
                    checks.push(fail(
                        "program",
                        format!(
                            "'{program}' is not on the PATH this app inherited when it started"
                        ),
                    ));
                    let next = if program.starts_with("npx") || program.starts_with("node") {
                        "install Node (which provides npx), then restart MultiZone — a program \
                         installed after the app started is not on the PATH it inherited"
                    } else {
                        "install it, or give the server the full path to the executable, then \
                         restart MultiZone so the new PATH is picked up"
                    };
                    stop!(format!("'{program}' was not found"), Some(next.into()));
                }
            }
        }
        "sse" | "http" => {
            let url = server.url.as_deref().unwrap_or("").trim().to_string();
            if url.is_empty() {
                checks.push(fail("url", "no URL is configured"));
                stop!("no URL to call".into(), Some("edit the server and give it a URL".into()));
            }
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                checks.push(fail("url", format!("'{url}' is not an http(s) URL")));
                stop!("the URL is not usable".into(), Some("it should start with https://".into()));
            }
            checks.push(pass("url", url));
        }
        other => {
            checks.push(fail("transport", format!("unknown transport '{other}'")));
            stop!(format!("unknown transport '{other}'"), None);
        }
    }

    // Credentials the catalog says are required. Only entries know this — a
    // hand-configured server has nothing to check against, and saying so beats
    // implying it is fine.
    let env = json_string_map(server.env.as_deref());
    let headers = json_string_map(server.headers.as_deref());
    match entry {
        Some(entry) => {
            let mut missing: Vec<&super::catalog::ConnectorField> = Vec::new();
            for f in entry.env.iter().filter(|f| f.required) {
                if !env.iter().any(|(k, v)| k == &f.key && !v.trim().is_empty()) {
                    missing.push(f);
                }
            }
            for f in entry.headers.iter().filter(|f| f.required) {
                if !headers.iter().any(|(k, v)| k == &f.key && !v.trim().is_empty()) {
                    missing.push(f);
                }
            }
            if let Some(first) = missing.first() {
                let names: Vec<&str> = missing.iter().map(|f| f.key.as_str()).collect();
                checks.push(fail("credentials", format!("not set: {}", names.join(", "))));
                let where_from = first
                    .credential_url
                    .clone()
                    .or_else(|| entry.docs_url.clone())
                    .map(|u| format!(" Get one at {u}."))
                    .unwrap_or_default();
                let summary = format!("{} is not set", first.key);
                return Diagnosis {
                    server_id: server.id.clone(),
                    ok: false,
                    summary,
                    checks,
                    next_step: Some(format!(
                        "edit the server and fill in {}.{where_from}",
                        first.label
                    )),
                    docs_url: first.credential_url.clone().or(docs_url),
                };
            }
            checks.push(pass(
                "credentials",
                if entry.fields().count() == 0 {
                    "this connector needs none".to_string()
                } else {
                    "every value the catalog marks required is set".to_string()
                },
            ));
        }
        None => {
            let n = env.len() + headers.len();
            checks.push(pass(
                "credentials",
                format!(
                    "{n} value(s) configured — this server was set up by hand, so there is no \
                     catalog entry saying which are required"
                ),
            ));
        }
    }

    // Only now the expensive check. Its error text already carries the child's
    // stderr (stdio) or the 401 hint (http), which is what makes it worth
    // reporting verbatim.
    match mcp::manager().connect(server).await {
        Ok(tools) => {
            checks.push(pass("handshake", format!("connected; it advertises {} tool(s)", tools.len())));
            Diagnosis {
                server_id: server.id.clone(),
                ok: true,
                summary: format!("connected — {} tool(s) available", tools.len()),
                checks,
                next_step: (tools.is_empty()).then(|| {
                    "it connected but advertised no tools, which usually means it is waiting on \
                     configuration of its own"
                        .to_string()
                }),
                docs_url,
            }
        }
        Err(e) => {
            let detail = e.to_string();
            checks.push(fail("handshake", detail.clone()));
            Diagnosis {
                server_id: server.id.clone(),
                ok: false,
                // First line only: the rest is the server's own output, which the
                // check carries in full.
                summary: detail.lines().next().unwrap_or(&detail).to_string(),
                checks,
                next_step: None,
                docs_url,
            }
        }
    }
}
