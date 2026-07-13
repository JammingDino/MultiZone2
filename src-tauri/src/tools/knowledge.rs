//! `search_local_files` — agentic retrieval over the chat's project knowledge base
//! (0.4.3). Read-only (safety level 0), so it runs without an approval prompt.
//!
//! Renamed from `search_knowledge` in 0.9.0: "knowledge" told neither the user nor
//! a small local model what the tool actually does. The old name still dispatches
//! (see `tool_safety_by_name` / `dispatch`) so zones and stored tool-call history
//! written before the rename keep working.
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
            name: "search_local_files".into(),
            description: "Search the user's own local files — the documents in this project's \
folder, which have been indexed for you — and return the passages most relevant to a query. \
This is a meaning-based (semantic) search: describe what you are looking for in plain language \
rather than guessing exact wording. Use it whenever the user's question might be answered by \
their own files, or to ground your answer in their documents. Returns the most relevant text \
chunks with the file each came from; cite that file when you use a chunk. To find an exact \
string or symbol instead of a topic, use `search_file_text`."
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

    // The knowledge base is scoped to the chat's project; chats without a project
    // fall back to the global KB (the app's default-directory index).
    let project_id: Option<String> =
        sqlx::query_scalar("SELECT project_id FROM chats WHERE id = ?1")
            .bind(chat_id)
            .fetch_optional(db)
            .await?
            .flatten();
    let project_id = project_id.unwrap_or_else(|| crate::knowledge::GLOBAL_KB_ID.to_string());

    match crate::knowledge::search(db, http, &project_id, query, k).await {
        Ok(hits) if hits.is_empty() => Ok(json!({
            "results": [],
            "note": "No matching passages were found in the project's knowledge base."
        })
        .to_string()),
        Ok(hits) => {
            // Number each result with a `ref` and ask the model to cite it inline
            // with `[n]`, mirroring web_search — the frontend turns the markers it
            // actually uses into a Sources list (0.4.1 inline citations).
            let results: Vec<Value> = hits
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    json!({
                        "ref": i + 1,
                        "source": h.path,
                        "title": h.title,
                        "chunk": h.ordinal,
                        "score": (h.score * 1000.0).round() / 1000.0,
                        "text": h.text,
                    })
                })
                .collect();
            Ok(json!({
                "results": results,
                "citation_instructions": "When you use information from a passage, cite it inline \
                    with its `ref` number in square brackets immediately after the claim, e.g. [1]. \
                    Only cite the passages you actually used."
            })
            .to_string())
        }
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}
