use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "web_search".into(),
            description:
                "Search the web. Returns a list of result URLs with titles and snippets."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "The search query" },
                    "num_results": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5 }
                },
                "required": ["query"]
            }),
        },
    }
}

/// Zone config shape (per-tool):
/// {
///   "web_search": {
///     "provider": "searxng" | "brave" | "tavily",
///     "endpoint": "https://...",
///     "api_key": "..."
///   }
/// }
pub async fn run(args: &Value, zone_config: &Value) -> AppResult<String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let n = args
        .get("num_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(5);

    if query.is_empty() {
        return Ok(json!({ "error": "query parameter required" }).to_string());
    }

    let cfg = zone_config.get("web_search").cloned().unwrap_or(Value::Null);
    let provider = cfg
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("none");

    // Stub: actual provider integrations land in Phase 8.
    Ok(json!({
        "query": query,
        "num_results": n,
        "provider": provider,
        "results": [],
        "note": "web_search tool is configured but the provider integration is a stub. Configure provider/endpoint/api_key in zone tool_config."
    })
    .to_string())
}
