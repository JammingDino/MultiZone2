//! Subchat orchestration tools (0.5.1). Let a zone spawn and drive side
//! conversations ("subagents"): create a subchat assigned to another zone, send
//! it messages, and read its transcript back. Subchats are linked to their
//! parent via `parent_chat_id` and owned by `initiated_by_zone_id` (the calling
//! zone), and are read-only from the user's perspective.
//!
//! Unlike the other tools, these run nested LLM turns, so they receive the
//! engine context (`EngineCtx` + `StreamSink`) and call `run_send_entry`
//! directly. The recursive turn call is boxed to break the async cycle
//! (run_turn → dispatch → here → run_send_entry → run_turn).

use crate::commands::messages::{run_send_entry, EngineCtx, InputPart, StreamSink, TurnOverride};
use crate::commands::{new_id, now_ts};
use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// Fallback when `subchatDepthLimit` isn't set in app settings.
const DEFAULT_DEPTH_LIMIT: i64 = 3;

/// Run a subchat turn behind a `dyn Future + Send` boundary. The explicit
/// trait-object erases the concrete future type, breaking the recursive async
/// cycle (run_turn → dispatch → here → run_send_entry → run_turn) that would
/// otherwise make the future fail `Send` inference.
fn run_turn_boxed<'a>(
    ctx: &'a EngineCtx,
    sink: &'a StreamSink,
    chat_id: &'a str,
    parts: Vec<InputPart>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(run_send_entry(ctx, sink, chat_id, parts, TurnOverride::default()))
}

pub fn definitions() -> Vec<Tool> {
    vec![spawn_definition(), send_definition(), read_definition()]
}

fn spawn_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "spawn_subagent".into(),
            description:
                "Spawn a subagent: create a new subchat assigned to another zone, send it an \
                 initial message, run its first turn, and return the subchat's id plus the \
                 subagent's response. Use this to delegate a focused task to a specialist zone. \
                 The subchat is observable by the user but read-only. Continue the conversation \
                 with send_subchat_message, or re-read it with read_subchat."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "zone_id": {
                        "type": "string",
                        "description": "The zone to assign as the subagent — its id or its exact (case-insensitive) name. Call list_zones if unsure."
                    },
                    "initial_message": {
                        "type": "string",
                        "description": "The task/prompt to send to the subagent as its first message."
                    },
                    "context_mode": {
                        "type": "string",
                        "enum": ["full", "task_only", "summary"],
                        "description": "How much context to give the subagent. 'task_only' (default): only initial_message. 'full': the whole current conversation is included as hidden context. 'summary': you have summarized the relevant context yourself inside initial_message."
                    }
                },
                "required": ["zone_id", "initial_message"]
            }),
        },
    }
}

fn send_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "send_subchat_message".into(),
            description:
                "Send a follow-up message to an existing subchat you spawned and return the \
                 subagent's response. Use the subchat id returned by spawn_subagent."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "subchat_id": { "type": "string", "description": "The subchat id returned by spawn_subagent." },
                    "message": { "type": "string", "description": "The message to send to the subagent." }
                },
                "required": ["subchat_id", "message"]
            }),
        },
    }
}

fn read_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "read_subchat".into(),
            description:
                "Read the full transcript of a subchat (every user/assistant turn) so you can \
                 review what the subagent has done so far."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "subchat_id": { "type": "string", "description": "The subchat id to read." }
                },
                "required": ["subchat_id"]
            }),
        },
    }
}

// ─── Execution ────────────────────────────────────────────────────────────────

/// `spawn_subagent` — resolve the target zone, enforce the depth limit, create a
/// subchat owned by the caller, send the first message, and return the new id +
/// the subagent's response.
pub async fn spawn(
    args: &Value,
    ctx: &EngineCtx,
    sink: &StreamSink,
    caller_zone_id: Option<&str>,
    parent_chat_id: &str,
) -> AppResult<String> {
    let zone_query = str_arg(args, "zone_id");
    let initial_message = str_arg(args, "initial_message");
    if zone_query.is_empty() || initial_message.is_empty() {
        return Ok(err("spawn_subagent requires 'zone_id' and 'initial_message'"));
    }
    let context_mode = args
        .get("context_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("task_only");

    let (target_zone_id, target_zone_name) = match resolve_zone(&ctx.db, &zone_query).await? {
        Some(z) => z,
        None => return Ok(err(&format!(
            "no zone matching '{zone_query}'. Call list_zones to see available zones."
        ))),
    };

    // Enforce the configured subchat nesting depth to prevent runaway recursion.
    let depth = subchat_depth(&ctx.db, parent_chat_id).await?;
    let limit = depth_limit(&ctx.db).await;
    if depth + 1 > limit {
        return Ok(err(&format!(
            "subchat depth limit reached ({limit}); cannot spawn deeper. This subchat is already {depth} level(s) deep."
        )));
    }

    // The subagent shares the parent's project so filesystem/knowledge tools
    // resolve against the same directory and index.
    let parent_project_id: Option<String> =
        sqlx::query_scalar("SELECT project_id FROM chats WHERE id = ?1")
            .bind(parent_chat_id)
            .fetch_optional(&ctx.db)
            .await?
            .flatten();

    // Owned by the calling zone (the orchestrator) so its prompts render with
    // that avatar; assigned to the target zone, which answers. The caller may be
    // a synthetic Quick-chat zone that isn't a real row — fall back to the target
    // (always real) so the initiated_by_zone_id foreign key holds.
    let owner_zone_id: &str = match caller_zone_id {
        Some(z) if zone_exists(&ctx.db, z).await? => z,
        _ => &target_zone_id,
    };
    let subchat_id = new_id();
    let now = now_ts();
    let title = format!("↳ {target_zone_name}");
    sqlx::query(
        "INSERT INTO chats (id, title, zone_id, project_id, parent_chat_id, initiated_by_zone_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
    )
    .bind(&subchat_id)
    .bind(&title)
    .bind(&target_zone_id)
    .bind(&parent_project_id)
    .bind(parent_chat_id)
    .bind(owner_zone_id)
    .bind(now)
    .execute(&ctx.db)
    .await?;

    // Tell any open GUI a new chat exists so the sidebar shows the subchat live.
    sink.notify_chats_changed();

    let parts = build_parts(&ctx.db, parent_chat_id, &initial_message, context_mode).await?;
    run_turn_boxed(ctx, sink, &subchat_id, parts).await?;

    let response = last_response(&ctx.db, &subchat_id).await?;
    Ok(json!({
        "status": "ok",
        "subchat_id": subchat_id,
        "zone": { "id": target_zone_id, "name": target_zone_name },
        "response": response,
    })
    .to_string())
}

/// `send_subchat_message` — send a follow-up to an existing subchat and return
/// the subagent's response.
pub async fn send(args: &Value, ctx: &EngineCtx, sink: &StreamSink) -> AppResult<String> {
    let subchat_id = str_arg(args, "subchat_id");
    let message = str_arg(args, "message");
    if subchat_id.is_empty() || message.is_empty() {
        return Ok(err("send_subchat_message requires 'subchat_id' and 'message'"));
    }
    if !is_subchat(&ctx.db, &subchat_id).await? {
        return Ok(err(&format!("'{subchat_id}' is not a subchat.")));
    }

    let parts = vec![InputPart::Text { text: message }];
    run_turn_boxed(ctx, sink, &subchat_id, parts).await?;

    let response = last_response(&ctx.db, &subchat_id).await?;
    Ok(json!({ "status": "ok", "subchat_id": subchat_id, "response": response }).to_string())
}

/// `read_subchat` — return the full user/assistant transcript of a subchat.
pub async fn read(args: &Value, db: &SqlitePool) -> AppResult<String> {
    let subchat_id = str_arg(args, "subchat_id");
    if subchat_id.is_empty() {
        return Ok(err("read_subchat requires 'subchat_id'"));
    }
    if !is_subchat(db, &subchat_id).await? {
        return Ok(err(&format!("'{subchat_id}' is not a subchat.")));
    }
    let transcript = transcript(db, &subchat_id).await?;
    Ok(json!({ "status": "ok", "subchat_id": subchat_id, "transcript": transcript }).to_string())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn str_arg(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

fn err(message: &str) -> String {
    json!({ "error": message }).to_string()
}

/// Resolve a zone by id or exact case-insensitive name. Returns None if there's
/// no unambiguous match.
async fn resolve_zone(db: &SqlitePool, query: &str) -> AppResult<Option<(String, String)>> {
    let matches: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM zones WHERE id = ?1 OR lower(name) = lower(?1)",
    )
    .bind(query)
    .fetch_all(db)
    .await?;
    Ok(match matches.as_slice() {
        [one] => Some(one.clone()),
        _ => None,
    })
}

/// True when a zone row with this id exists.
async fn zone_exists(db: &SqlitePool, zone_id: &str) -> AppResult<bool> {
    let row: Option<String> = sqlx::query_scalar("SELECT id FROM zones WHERE id = ?1")
        .bind(zone_id)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

/// True when the chat exists and is a subchat (owned by a zone).
async fn is_subchat(db: &SqlitePool, chat_id: &str) -> AppResult<bool> {
    let row: Option<Option<String>> =
        sqlx::query_scalar("SELECT initiated_by_zone_id FROM chats WHERE id = ?1")
            .bind(chat_id)
            .fetch_optional(db)
            .await?;
    Ok(matches!(row, Some(Some(_))))
}

/// How many subchat levels deep `chat_id` is (a root chat is 0). Walks the
/// `parent_chat_id` chain, counting each ancestor that is itself a subchat.
async fn subchat_depth(db: &SqlitePool, chat_id: &str) -> AppResult<i64> {
    let mut depth = 0i64;
    let mut cur = chat_id.to_string();
    // Bounded by a hard cap so a cyclic parent link can never loop forever.
    for _ in 0..64 {
        let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT parent_chat_id, initiated_by_zone_id FROM chats WHERE id = ?1",
        )
        .bind(&cur)
        .fetch_optional(db)
        .await?;
        match row {
            Some((Some(parent), Some(_owner))) => {
                depth += 1;
                cur = parent;
            }
            _ => break,
        }
    }
    Ok(depth)
}

/// Configured subchat depth limit from app settings, or the default.
async fn depth_limit(db: &SqlitePool) -> i64 {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("subchatDepthLimit").and_then(|n| n.as_i64()))
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_DEPTH_LIMIT)
}

/// Build the input parts for the subagent's first message based on context mode.
/// `full` prepends the parent transcript as hidden context (sent to the model,
/// invisible in the UI); `task_only`/`summary` send the message alone.
async fn build_parts(
    db: &SqlitePool,
    parent_chat_id: &str,
    initial_message: &str,
    context_mode: &str,
) -> AppResult<Vec<InputPart>> {
    let mut parts = Vec::new();
    if context_mode == "full" {
        let convo = transcript(db, parent_chat_id).await?;
        if !convo.trim().is_empty() {
            parts.push(InputPart::HiddenText {
                text: format!(
                    "Context — the conversation that led to this task:\n\n{convo}\n\n---\n"
                ),
            });
        }
    }
    parts.push(InputPart::Text { text: initial_message.to_string() });
    Ok(parts)
}

/// Plain-text transcript of a chat's primary user/assistant turns.
async fn transcript(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT role, content FROM messages
         WHERE chat_id = ?1 AND zone_id IS NULL AND role IN ('user', 'assistant')
         ORDER BY created_at ASC",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await?;
    let mut out = String::new();
    for (role, content) in rows {
        let text = extract_text(&content);
        if text.trim().is_empty() {
            continue;
        }
        let label = if role == "user" { "User" } else { "Assistant" };
        out.push_str(&format!("{label}: {text}\n\n"));
    }
    Ok(out.trim_end().to_string())
}

/// Last assistant turn's text for a chat (the subagent's response).
async fn last_response(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let content: Option<String> = sqlx::query_scalar(
        "SELECT content FROM messages
         WHERE chat_id = ?1 AND zone_id IS NULL AND role = 'assistant'
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await?;
    Ok(content.map(|c| extract_text(&c)).unwrap_or_default())
}

/// Pull the concatenated text from a stored message content JSON (an array of
/// content parts). Falls back to the raw string if it isn't the expected shape.
fn extract_text(content: &str) -> String {
    match serde_json::from_str::<Value>(content) {
        Ok(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| {
                if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                    p.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => content.to_string(),
    }
}
