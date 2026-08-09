//! `app_read` / `app_control` — the model driving MultiZone itself (0.11.0).
//!
//! Every other tool reaches outward: the filesystem, the web, a terminal. This
//! one reaches back into the app the conversation is happening in, so the
//! answer to "make this dark" or "give me a zone for code review" is the thing
//! happening rather than a description of which menu to open.
//!
//! It is deliberately not a hand-written list of app actions. Both functions
//! forward to [`crate::api::call_in_process`], which serves the request through
//! the same axum router the HTTP API serves — so the model's reach is exactly
//! the API's surface, by construction, and a route added next release is
//! callable the day it lands with nothing here to update. `GET /api/routes` is
//! the catalog, which is why neither description tries to be one: the surface
//! is ~180 routes, and pasting it into a tool schema would bill every request
//! for a list that is already one call away.

use crate::commands::messages::{EngineCtx, StreamSink};
use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};

pub fn definitions() -> Vec<Tool> {
    vec![read_definition(), control_definition()]
}

fn read_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "app_read".into(),
            description:
                "Read MultiZone's own state through its API — chats, zones, projects, tags, \
                 skills, settings, usage. Start with path \"/api/routes\", which lists every \
                 route this build serves with a one-line description; that is the catalog of \
                 what you and `app_control` can do."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "An API path, with query string if any, e.g. /api/routes, /api/zones, /api/settings/theme"
                    }
                },
                "required": ["path"]
            }),
        },
    }
}

fn control_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "app_control".into(),
            description:
                "Change MultiZone itself: appearance, zones, providers, projects, tags, skills, \
                 settings — anything the user could do in the app. Call app_read \"/api/routes\" \
                 first for the route and its shape. PATCH /api/theme with {\"mode\":\"dark\"} \
                 switches to dark mode (app_read \"/api/theme\" first for the palette, the \
                 effects and the custom-CSS field, each with its range); POST /api/zones creates \
                 or updates a zone. Changes are live in the open window immediately."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "method": {
                        "type": "string",
                        "enum": ["POST", "PUT", "PATCH", "DELETE"],
                        "description": "Use app_read for GET."
                    },
                    "path": { "type": "string", "description": "An API path, e.g. /api/settings/theme" },
                    "body": { "type": "object", "description": "JSON body, when the route takes one." }
                },
                "required": ["method", "path"]
            }),
        },
    }
}

/// Routes this tool will not call, and why.
///
/// Both refusals are about the tool being *inside* a running turn:
///
/// - Sending or regenerating a message re-enters the engine. Aimed at the
///   current chat that is a turn calling itself; aimed at another it is a
///   second engine with no supervision and no stream anyone is reading. There
///   is already a tool for delegating work to another chat — `subchat` — which
///   the user approves as such and can watch.
/// - Answering a tool approval is the model granting itself permission. The
///   approval prompt is the boundary between "the model asked" and "the user
///   agreed", and a model that can answer one has removed it.
fn refusal(path: &str) -> Option<&'static str> {
    let p = path.split('?').next().unwrap_or(path);
    let last = p.rsplit('/').next().unwrap_or("");
    match last {
        "messages" | "regenerate" | "regenerate-participant" | "queue" => Some(
            "running a turn from inside a turn is what the `subchat` tool is for — \
             it runs under the user's supervision and streams where they can see it",
        ),
        "approval" => {
            Some("a tool approval is the user's answer to give, not the model's")
        }
        _ => None,
    }
}

/// Normalize what the model wrote into a path this API will recognise. Models
/// reach for a full URL about as often as a path, and refusing one over the
/// other teaches nothing.
fn normalize(path: &str) -> String {
    let p = path.trim();
    let p = p
        .strip_prefix("http://")
        .or_else(|| p.strip_prefix("https://"))
        .and_then(|rest| rest.find('/').map(|i| &rest[i..]))
        .unwrap_or(p);
    if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{p}")
    }
}

pub async fn read(args: &Value, ctx: &EngineCtx, sink: &StreamSink) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
    if path.is_empty() {
        return Ok(json!({ "error": "app_read requires a 'path', e.g. /api/routes" }).to_string());
    }
    call(ctx, sink, "GET", &normalize(path), None).await
}

pub async fn control(args: &Value, ctx: &EngineCtx, sink: &StreamSink) -> AppResult<String> {
    let method = args.get("method").and_then(|v| v.as_str()).unwrap_or("").trim().to_uppercase();
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
    if path.is_empty() {
        return Ok(json!({ "error": "app_control requires a 'path'" }).to_string());
    }
    if method.is_empty() {
        return Ok(json!({ "error": "app_control requires a 'method'" }).to_string());
    }
    if method == "GET" {
        return Ok(json!({ "error": "use app_read for GET requests" }).to_string());
    }
    let body = args.get("body").filter(|b| b.is_object()).cloned();
    call(ctx, sink, &method, &normalize(path), body).await
}

async fn call(
    ctx: &EngineCtx,
    sink: &StreamSink,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> AppResult<String> {
    if let Some(reason) = refusal(path) {
        return Ok(json!({ "error": format!("{method} {path} is not available here: {reason}") })
            .to_string());
    }

    let (status, raw) =
        match crate::api::call_in_process(sink.app().clone(), ctx, method, path, body).await {
            Ok(out) => out,
            Err(e) => return Ok(json!({ "error": e.to_string() }).to_string()),
        };

    // Hand back parsed JSON where the route returns JSON, so the model reads a
    // structure rather than a string of one. 204 and friends carry no body.
    let parsed: Option<Value> = serde_json::from_str(&raw).ok();
    let ok = (200..300).contains(&status);
    let mut out = json!({ "status": status, "ok": ok });
    match parsed {
        Some(v) if !raw.trim().is_empty() => out["result"] = v,
        _ if !raw.trim().is_empty() => out["result"] = Value::String(raw),
        _ => {}
    }
    if !ok && status == 404 {
        out["note"] =
            Value::String("call app_read \"/api/routes\" for the paths this build serves".into());
    }
    Ok(out.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_url_is_accepted_as_a_path() {
        assert_eq!(normalize("http://127.0.0.1:8765/api/zones"), "/api/zones");
        assert_eq!(normalize("/api/zones"), "/api/zones");
        assert_eq!(normalize("api/zones"), "/api/zones");
        assert_eq!(normalize("  /api/settings/theme  "), "/api/settings/theme");
    }

    /// The two refusals are the tool's whole safety story beyond the approval
    /// prompt, so they hold whatever the path is dressed up as.
    #[test]
    fn turn_running_and_self_approval_are_refused() {
        assert!(refusal("/api/chats/abc/messages").is_some());
        assert!(refusal("/api/chats/abc/messages?wait=true").is_some());
        assert!(refusal("/api/chats/abc/regenerate").is_some());
        assert!(refusal("/api/chats/abc/approval").is_some());
        // Everything else is the API's business, not this file's.
        assert!(refusal("/api/settings/theme").is_none());
        assert!(refusal("/api/zones").is_none());
        assert!(refusal("/api/chats").is_none());
    }
}
