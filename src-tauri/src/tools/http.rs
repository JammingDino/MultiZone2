//! `http_request` — a general HTTP call, so a zone can talk to an API (0.9.3).
//!
//! Distinct from `extract_url`, which is the read-a-web-page path (it strips
//! chrome and returns prose). This one returns the raw response — status,
//! headers, body — so a model can `GET` a JSON endpoint, `POST` to a webhook,
//! or drive a local service.
//!
//! Classed **dangerous** (level 2): it can send data off the machine and can
//! mutate remote state, so every call goes through the approval gate and the
//! user sees the URL, method, and body before it runs. That approval prompt is
//! the security boundary here — there is deliberately no allowlist, because a
//! local-first app's most common use of this tool is calling a service on
//! localhost, which any sensible blocklist would forbid.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use std::time::Duration;

/// Response bodies are truncated at this size — a model can't use more, and a
/// large binary payload would blow the context window.
const MAX_BODY_BYTES: usize = 100_000;
const TIMEOUT_SECS: u64 = 30;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "http_request".into(),
            description:
                "Make an HTTP request to a URL and get back the raw status, headers, and body. \
                 Use this to call an API — fetch JSON from an endpoint, POST to a service, drive a \
                 local server. To *read a web page* as prose instead, use `extract_url`, which \
                 strips the navigation and returns clean text.\n\n\
                 The user is asked to approve every request before it is sent, and can see the \
                 method, URL, and body. Large responses are truncated."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Full URL, including the scheme (http:// or https://)."
                    },
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                        "description": "HTTP method. Defaults to GET.",
                        "default": "GET"
                    },
                    "headers": {
                        "type": "object",
                        "description": "Request headers as a flat object, e.g. {\"Authorization\": \"Bearer …\"}.",
                        "additionalProperties": { "type": "string" }
                    },
                    "body": {
                        "type": "string",
                        "description": "Request body as a string. For JSON, send the serialized JSON and set a Content-Type header."
                    },
                    "json": {
                        "type": "object",
                        "description": "Convenience alternative to `body`: send this object as a JSON body, with the Content-Type set for you."
                    }
                },
                "required": ["url"]
            }),
        },
    }
}

pub async fn run(args: &Value, http: &reqwest::Client) -> AppResult<String> {
    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim();
    if url.is_empty() {
        return Ok(json!({ "error": "http_request needs a 'url'" }).to_string());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Ok(json!({
            "error": "url must start with http:// or https://"
        })
        .to_string());
    }

    let method_raw = args
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .trim()
        .to_ascii_uppercase();
    let method = match reqwest::Method::from_bytes(method_raw.as_bytes()) {
        Ok(m) => m,
        Err(_) => return Ok(json!({ "error": format!("unsupported method: {method_raw}") }).to_string()),
    };

    let mut req = http.request(method, url).timeout(Duration::from_secs(TIMEOUT_SECS));

    if let Some(headers) = args.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in headers {
            if let Some(val) = v.as_str() {
                req = req.header(k.as_str(), val);
            }
        }
    }

    // `json` is the convenience form; an explicit `body` wins if both are given.
    if let Some(body) = args.get("body").and_then(|v| v.as_str()) {
        req = req.body(body.to_string());
    } else if let Some(payload) = args.get("json") {
        if !payload.is_null() {
            req = req.json(payload);
        }
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return Ok(json!({ "error": format!("request failed: {e}") }).to_string()),
    };

    let status = resp.status();
    let headers: serde_json::Map<String, Value> = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|s| (k.as_str().to_string(), Value::String(s.to_string())))
        })
        .collect();

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Ok(json!({ "error": format!("failed to read response body: {e}") }).to_string()),
    };
    let truncated = bytes.len() > MAX_BODY_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_BODY_BYTES)];
    let body = String::from_utf8_lossy(slice).to_string();

    // Hand back parsed JSON when that's what it is — saves the model a parsing
    // step and keeps the result legible in the transcript.
    let parsed: Option<Value> = serde_json::from_str(&body).ok();

    Ok(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "status_text": status.canonical_reason().unwrap_or(""),
        "headers": headers,
        "body": if parsed.is_some() { Value::Null } else { Value::String(body) },
        "json": parsed,
        "truncated": truncated,
    })
    .to_string())
}
