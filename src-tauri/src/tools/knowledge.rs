//! `search_knowledge` — agentic retrieval over the chat's project knowledge base
//! (0.4.3). Read-only (safety level 0), so it runs without an approval prompt.
//!
//! The tool is offered to a chat only when the chat's `knowledge_enabled` flag
//! is on and its project has a non-empty index (see the request builder in
//! `commands::messages`). At call time it resolves the chat's project, embeds the
//! query with the project's embedding model, and returns the top matching chunks
//! with their source file so the model can cite them.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// Default / maximum chunks returned per call.
const DEFAULT_K: usize = 5;
const MAX_K: usize = 20;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "search_knowledge".into(),
            description: "Search this project's indexed documents (the knowledge base) for \
passages relevant to a query, using semantic similarity. Use it whenever the user's question \
might be answered by the project's files, or to ground your answer in their documents. Returns \
the most relevant text chunks with their source file path; cite the file when you use a chunk."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to look for. A focused natural-language question or topic works best."
                    },
                    "max_results": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_K,
                        "default": DEFAULT_K,
                        "description": "How many chunks to return (default 5)."
                    }
                },
                "required": ["query"]
            }),
        },
    }
}

pub async fn run(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    http: &reqwest::Client,
) -> AppResult<String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim();
    if query.is_empty() {
        return Ok(json!({ "error": "query is required" }).to_string());
    }
    let k = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .map(|n| (n as usize).clamp(1, MAX_K))
        .unwrap_or(DEFAULT_K);

    // The knowledge base is project-scoped; find this chat's project.
    let project_id: Option<String> =
        sqlx::query_scalar("SELECT project_id FROM chats WHERE id = ?1")
            .bind(chat_id)
            .fetch_optional(db)
            .await?
            .flatten();
    let project_id = match project_id {
        Some(p) => p,
        None => {
            return Ok(json!({
                "error": "this chat is not in a project, so it has no knowledge base"
            })
            .to_string())
        }
    };

    match crate::knowledge::search(db, http, &project_id, query, k).await {
        Ok(hits) if hits.is_empty() => Ok(json!({
            "results": [],
            "note": "No matching passages were found in the project's knowledge base."
        })
        .to_string()),
        Ok(hits) => {
            let results: Vec<Value> = hits
                .iter()
                .map(|h| {
                    json!({
                        "source": h.path,
                        "title": h.title,
                        "chunk": h.ordinal,
                        "score": (h.score * 1000.0).round() / 1000.0,
                        "text": h.text,
                    })
                })
                .collect();
            Ok(json!({ "results": results }).to_string())
        }
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}
