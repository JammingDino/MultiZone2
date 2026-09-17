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
            description: "Call this whenever the user's question might be answered by their own \
indexed documents, or to ground an answer in them. Semantic search — describe what you want in \
plain language rather than guessing exact wording; for an exact string or symbol use \
`grep` instead. Returns passages with the file each came from."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "A focused natural-language question or topic." },
                    "max_results": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_K,
                        "default": DEFAULT_K,
                        "description": "How many chunks to return."
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
                        // `source` stays project-relative — that is the form
                        // worth showing a model. `abs_path` is carried for the
                        // UI, which needs a real path to reveal the file in the
                        // OS file manager when the citation is clicked.
                        "source": h.path,
                        "abs_path": h.abs_path,
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
