//! `compact_context` — the model summarizes its own older turns so a long chat
//! stops silently shedding its beginning (0.9.3).
//!
//! Without this, a chat that outgrows the model's context window degrades
//! quietly: the provider truncates the oldest messages and the model starts
//! contradicting things it agreed to twenty turns ago, with no signal to anyone.
//! Here the model writes a summary of everything up to now, and from the next
//! turn on that summary *replaces* those turns in the history that gets sent.
//!
//! Nothing is destroyed. The messages stay in the DB and stay on screen — only
//! the request body changes. Re-compacting later simply moves the cutoff forward
//! and overwrites the summary (the model is told to fold the previous summary
//! into the new one, so nothing is lost across compactions).
//!
//! Moderate safety: it is a lossy rewrite of what the model can see, so the user
//! approves it rather than having it happen behind their back.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "compact_context".into(),
            description:
                "Condense the earlier part of this conversation into a summary, so a long chat \
                 keeps working instead of quietly losing its oldest messages as it outgrows your \
                 context window. Call this when the conversation has grown long — you will be \
                 told in the system prompt when it has.\n\n\
                 From your next turn on, the turns you are summarizing are replaced by your \
                 summary. So the summary must be able to stand in for them: carry over the user's \
                 goal, every decision and constraint agreed so far, key facts established, what \
                 has been done, and what is still outstanding. Prefer specifics over description \
                 — names, paths, numbers, exact wording of anything that must not drift. If a \
                 previous summary is already in the conversation, fold it into the new one rather \
                 than dropping it.\n\n\
                 The user still sees the full conversation; only your working context is condensed."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "The summary that will stand in for the earlier conversation. Markdown is fine. Be thorough — this is all you will retain of those turns."
                    }
                },
                "required": ["summary"]
            }),
        },
    }
}

/// Minimum length for a summary that is about to replace an entire conversation
/// history. A one-liner here would be a silent data loss.
const MIN_SUMMARY_CHARS: usize = 80;

pub async fn run(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if summary.len() < MIN_SUMMARY_CHARS {
        return Ok(json!({
            "error": "The summary is too short to replace the conversation. Write a full summary: \
                      the goal, decisions and constraints agreed, key facts, what is done, and \
                      what is outstanding."
        })
        .to_string());
    }

    // Cut off at the newest message that exists right now. Everything at or
    // before it is what the summary stands in for; this turn's own messages are
    // written after the tool call returns, so they survive into the next turn.
    let cutoff: Option<i64> =
        sqlx::query_scalar("SELECT MAX(created_at) FROM messages WHERE chat_id = ?1")
            .bind(chat_id)
            .fetch_one(db)
            .await
            .unwrap_or(None);
    let cutoff = match cutoff {
        Some(c) => c,
        None => return Ok(json!({ "error": "nothing to compact — this chat has no messages yet" }).to_string()),
    };

    let compacted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE chat_id = ?1 AND created_at <= ?2",
    )
    .bind(chat_id)
    .bind(cutoff)
    .fetch_one(db)
    .await
    .unwrap_or(0);

    sqlx::query(
        "UPDATE chats SET context_summary = ?1, context_summary_through = ?2, updated_at = ?3
         WHERE id = ?4",
    )
    .bind(summary)
    .bind(cutoff)
    .bind(chrono::Utc::now().timestamp())
    .bind(chat_id)
    .execute(db)
    .await?;

    Ok(json!({
        "rendered": "compact_context",
        "ok": true,
        "messages_compacted": compacted,
        "summary": summary,
        "note": "Done. From your next turn, the earlier messages are replaced by this summary in \
                 your context. The user still sees the full conversation.",
    })
    .to_string())
}

/// The `# Conversation so far` block that stands in for the compacted turns, and
/// the cutoff those turns are identified by. `None` when this chat has never been
/// compacted.
pub async fn compacted_prefix(db: &SqlitePool, chat_id: &str) -> Option<(String, i64)> {
    let row: Option<(Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT context_summary, context_summary_through FROM chats WHERE id = ?1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    match row {
        Some((Some(summary), Some(through))) if !summary.trim().is_empty() => Some((
            format!(
                "# Conversation so far\nThe earlier part of this conversation was condensed to \
                 keep it within your context window. This summary stands in for those turns — \
                 treat it as established fact, and do not tell the user their history is \
                 missing (they can still see all of it).\n\n{}",
                summary.trim()
            ),
            through,
        )),
        _ => None,
    }
}

/// Roughly how many characters of history to tolerate before nudging the model to
/// compact. ~4 chars/token puts this near 12k tokens — comfortably inside even a
/// small local model's window, so the nudge lands well before anything is lost.
pub const COMPACT_HINT_CHARS: usize = 48_000;

/// The nudge appended to the system prompt once the history is long and this zone
/// actually has the tool to do something about it.
pub fn compact_hint(approx_chars: usize) -> String {
    format!(
        "# Context length\nThis conversation is getting long (roughly {} thousand tokens of \
         history). Call `compact_context` with a thorough summary soon, before the oldest turns \
         start falling out of your context window.",
        approx_chars / 4 / 1000
    )
}
