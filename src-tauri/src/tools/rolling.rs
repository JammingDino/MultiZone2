//! Rolling context (0.18) — a conversation kept under a fixed size by
//! forgetting its oldest part, except what the model marked important.
//!
//! Compaction condenses a chat once it is nearly full. A rolling chat never
//! gets there: past its limit, the history builder moves a cutoff forward and
//! everything before it drops out of the request. The cutoff jumps to 70% of
//! the limit rather than creeping one message at a time, so the request prefix
//! — and the provider's cache of it — holds still for a while between moves.
//!
//! What survives is what the model chose to keep. `mark_important` writes a
//! note (and can pin the last tool result itself); every note is shown at the
//! top of the kept history, whatever has been forgotten. The standing prompt
//! for a rolling chat is mostly about using that well — above all, not
//! re-reading and re-testing work a note already records as done, which is
//! the loop a forgetting agent otherwise falls into.
//!
//! Like compaction, nothing is deleted: the messages stay in the database and
//! on screen. The latest user message is never forgotten — in a long agentic
//! turn it is the task.

use crate::db::models::Message;
use crate::error::AppResult;
use crate::llm::types::{ChatMessage, ContentPart, MessageContent, Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub fn definitions() -> Vec<Tool> {
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "mark_important".into(),
                description: "Keep something through rolling context. Your oldest messages are \
                              forgotten as the conversation grows; notes made here are always \
                              shown to you. Use it for decisions, findings, and work you have \
                              finished and verified."
                    .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "note": {
                            "type": "string",
                            "description": "One specific fact, e.g. \"Verified: login flow works, tests in auth.test.ts pass\"."
                        },
                        "keep_last_result": {
                            "type": "boolean",
                            "description": "Also keep the full text of your most recent tool result with the note."
                        }
                    },
                    "required": ["note"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "forget_important".into(),
                description: "Remove a note you marked important once it is no longer true."
                    .into(),
                parameters: json!({
                    "type": "object",
                    "properties": { "id": { "type": "string", "description": "The note's id, as shown beside it." } },
                    "required": ["id"]
                }),
            },
        },
    ]
}

/// The standing instructions for a rolling chat.
pub const INSTRUCTIONS: &str = "# Rolling context\n\
This conversation is kept under a fixed size. As it grows, its oldest messages — including old \
tool results — are forgotten automatically, and you will not see them again. Work with that:\n\
- When you establish something you will need later, call `mark_important` with a short, \
specific note: a decision and its reason, what a file is for, a command that works, that a \
feature is implemented and verified. Use `keep_last_result` when the exact output matters.\n\
- Notes you marked important are always shown to you. Treat them as done and true. Do not \
re-read files, re-run tests or re-verify work a note records as complete unless something has \
changed since — exploring, then testing, then forgetting and exploring again is how a rolling \
context goes in circles.\n\
- Before exploring or testing, check your notes first.\n\
- Remove a note with `forget_important` once it stops being true.";

/// This chat's limit in tokens, or 0 when rolling is off: the chat's own value
/// when it has one, otherwise the `rollingContextTokens` default.
pub async fn limit(db: &SqlitePool, chat_id: &str) -> i64 {
    let own: Option<Option<i64>> =
        sqlx::query_scalar("SELECT rolling_context_tokens FROM chats WHERE id = ?1")
            .bind(chat_id)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    if let Some(n) = own.flatten() {
        return n.max(0);
    }
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("rollingContextTokens").and_then(Value::as_i64))
        .unwrap_or(0)
        .max(0)
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub id: String,
    pub note: String,
    pub message_id: Option<String>,
    pub created_at: i64,
}

pub async fn pins(db: &SqlitePool, chat_id: &str) -> Vec<Pin> {
    sqlx::query_as(
        "SELECT id, note, message_id, created_at FROM context_pins
          WHERE chat_id = ?1 ORDER BY created_at ASC",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await
    .unwrap_or_default()
}

/// The short form of a pin id the model is shown and may answer with.
fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

pub async fn mark(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let note: String = args
        .get("note")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(1_000)
        .collect();
    if note.is_empty() {
        return Ok(json!({ "error": "Write the note: one specific fact worth keeping." }).to_string());
    }
    // The newest result on disk is the previous call's: this call's own result
    // is written after it returns.
    let message_id: Option<String> = if args.get("keep_last_result").and_then(Value::as_bool) == Some(true) {
        sqlx::query_scalar(
            "SELECT id FROM messages WHERE chat_id = ?1 AND zone_id IS NULL AND role = 'tool'
              ORDER BY created_at DESC LIMIT 1",
        )
        .bind(chat_id)
        .fetch_optional(db)
        .await?
    } else {
        None
    };
    let id = crate::commands::new_id();
    sqlx::query(
        "INSERT INTO context_pins (id, chat_id, note, message_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(&id)
    .bind(chat_id)
    .bind(&note)
    .bind(&message_id)
    .bind(crate::commands::now_ts())
    .execute(db)
    .await?;
    Ok(json!({ "ok": true, "id": short(&id), "kept_result": message_id.is_some() }).to_string())
}

pub async fn forget(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let id = args.get("id").and_then(Value::as_str).unwrap_or("").trim();
    if id.is_empty() {
        return Ok(json!({ "error": "Give the id shown beside the note." }).to_string());
    }
    let n = delete(db, chat_id, id).await?;
    Ok(if n > 0 {
        json!({ "ok": true })
    } else {
        json!({ "error": format!("No note with id {id} in this chat.") })
    }
    .to_string())
}

/// Delete a pin by its full id or the short form. Returns rows removed.
pub async fn delete(db: &SqlitePool, chat_id: &str, id: &str) -> AppResult<u64> {
    // An empty prefix would match every pin.
    if id.is_empty() {
        return Ok(0);
    }
    let r = sqlx::query("DELETE FROM context_pins WHERE chat_id = ?1 AND (id = ?2 OR id LIKE ?2 || '%')")
        .bind(chat_id)
        .bind(id)
        .execute(db)
        .await?;
    Ok(r.rows_affected())
}

/// Where the cutoff has to move so the rows after it fit, or `None` when they
/// already do. Pure, so the arithmetic is testable without a database.
///
/// Cuts only at a unit boundary — never between a call and its results — and
/// aims for 70% of the limit so it does not move again on the next step. The
/// latest user message is exempt (it is kept wherever the cut lands) and so
/// does not count toward what a cut removes. The final row is never cut: it is
/// the work in progress, however large.
pub fn advance(rows: &[Message], through: Option<i64>, limit: i64, cpt: f64) -> Option<i64> {
    let kept: Vec<&Message> = rows.iter().filter(|m| through.map_or(true, |t| m.created_at > t)).collect();
    let w = |m: &Message| crate::tools::smart_compact::weight(std::slice::from_ref(m), cpt);
    let total: i64 = kept.iter().map(|m| w(m)).sum();
    if total <= limit {
        return None;
    }
    let task = rows.iter().rposition(|m| m.role == "user").map(|i| rows[i].id.as_str());
    let target = limit * 7 / 10;
    let mut removed = 0i64;
    let mut best = None;
    for i in 0..kept.len().saturating_sub(1) {
        if Some(kept[i].id.as_str()) != task {
            removed += w(kept[i]);
        }
        if kept[i + 1].role == "tool" {
            continue;
        }
        best = Some(kept[i].created_at);
        if total - removed <= target {
            break;
        }
    }
    best
}

pub async fn stored_through(db: &SqlitePool, chat_id: &str) -> Option<i64> {
    sqlx::query_scalar::<_, Option<i64>>("SELECT rolling_through FROM chats WHERE id = ?1")
        .bind(chat_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .flatten()
}

/// Take the forgotten rows out of `rows` and return them: everything at or
/// before `through` except the latest user message.
pub fn split(rows: &mut Vec<Message>, through: Option<i64>) -> Vec<Message> {
    let Some(t) = through else { return Vec::new() };
    let task = rows.iter().rposition(|m| m.role == "user").map(|i| rows[i].id.clone());
    let (forgotten, kept): (Vec<Message>, Vec<Message>) = std::mem::take(rows)
        .into_iter()
        .partition(|m| m.created_at <= t && Some(&m.id) != task.as_ref());
    *rows = kept;
    forgotten
}

fn text_of(content_json: &str) -> String {
    let parts: Vec<ContentPart> = serde_json::from_str(content_json).unwrap_or_default();
    parts
        .into_iter()
        .filter_map(|p| match p {
            ContentPart::Text { text } | ContentPart::HiddenText { text } => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Apply the chat's rolling limit to `rows` (the primary conversation, already
/// past any summary and smart-compacted), moving and saving the cutoff when
/// they have outgrown it. Returns the block to put in front of what is left:
/// how much was forgotten, and the notes marked important. `None` when rolling
/// is off, or when nothing is forgotten and nothing is marked.
pub async fn apply(db: &SqlitePool, chat_id: &str, rows: &mut Vec<Message>) -> Option<ChatMessage> {
    let limit = limit(db, chat_id).await;
    if limit <= 0 {
        return None;
    }
    let cpt = crate::llm::tokens::DEFAULT_CHARS_PER_TOKEN;
    let mut through = stored_through(db, chat_id).await;
    if let Some(next) = advance(rows, through, limit, cpt) {
        through = Some(next);
        let _ = sqlx::query("UPDATE chats SET rolling_through = ?1 WHERE id = ?2")
            .bind(next)
            .bind(chat_id)
            .execute(db)
            .await;
    }

    let forgotten = split(rows, through);

    let pins = pins(db, chat_id).await;
    if forgotten.is_empty() && pins.is_empty() {
        return None;
    }
    let mut block = format!(
        "# Rolling context\nThis conversation is kept under about {limit} tokens."
    );
    if !forgotten.is_empty() {
        block.push_str(&format!(
            " {} earlier messages have been forgotten and are no longer visible to you (the user \
             can still see them).",
            forgotten.len()
        ));
    }
    if pins.is_empty() {
        block.push_str("\n\nNothing is marked important yet.");
    } else {
        block.push_str(
            "\n\n## Marked important\nYour own notes, kept whatever is forgotten. Treat them as \
             established — do not redo or re-verify what they record as done.\n",
        );
        for p in &pins {
            block.push_str(&format!("- [{}] {}\n", short(&p.id), p.note));
            // A pinned result that has been forgotten comes back as text: the
            // call it answered is gone, and a bare tool message would be
            // rejected by every provider.
            if let Some(m) = p.message_id.as_ref().and_then(|id| forgotten.iter().find(|m| &m.id == id)) {
                let text: String = text_of(&m.content).chars().take(4_000).collect();
                block.push_str(&format!("  Kept result:\n  ```\n{text}\n  ```\n"));
            }
        }
    }
    Some(ChatMessage {
        role: "system".into(),
        content: Some(MessageContent::Text(block)),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    })
}

/// Rough size of a request's conversation, for deciding mid-turn whether it
/// has outgrown the limit. The system prompt is not the conversation.
pub fn request_weight(msgs: &[ChatMessage], cpt: f64) -> i64 {
    let mut chars = 0usize;
    let mut images = 0i64;
    for m in msgs.iter().filter(|m| m.role != "system") {
        match &m.content {
            Some(MessageContent::Text(t)) => chars += t.chars().count(),
            Some(MessageContent::Parts(parts)) => {
                for p in parts {
                    match p {
                        ContentPart::Text { text } | ContentPart::HiddenText { text } => {
                            chars += text.chars().count()
                        }
                        _ => images += 1,
                    }
                }
            }
            None => {}
        }
        for tc in m.tool_calls.iter().flatten() {
            chars += tc.function.name.len() + tc.function.arguments.chars().count();
        }
    }
    (chars as f64 / cpt.max(1.0)).round() as i64 + images * crate::llm::tokens::IMAGE_TOKENS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, role: &str, chars: usize, at: i64) -> Message {
        Message {
            id: id.into(),
            chat_id: "c".into(),
            role: role.into(),
            content: json!([{ "type": "text", "text": "x".repeat(chars) }]).to_string(),
            tool_calls: None,
            tool_call_id: None,
            reasoning: None,
            zone_id: None,
            active_zone_id: None,
            edited: false,
            created_at: at,
        }
    }

    #[test]
    fn nothing_moves_under_the_limit() {
        let rows = vec![msg("u", "user", 400, 1), msg("a", "assistant", 400, 2)];
        assert_eq!(advance(&rows, None, 1_000, 4.0), None);
    }

    #[test]
    fn the_cut_aims_below_the_limit_and_never_splits_a_call_from_its_result() {
        // 100 tokens each; limit 500 → target 350.
        let rows = vec![
            msg("u", "user", 400, 1),
            msg("a1", "assistant", 400, 2),
            msg("t1", "tool", 400, 3),
            msg("a2", "assistant", 400, 4),
            msg("t2", "tool", 400, 5),
            msg("a3", "assistant", 400, 6),
            msg("t3", "tool", 400, 7),
            msg("a4", "assistant", 400, 8),
        ];
        let cut = advance(&rows, None, 500, 4.0).unwrap();
        // The user message is exempt, so removing a1..t2 leaves u + a3 t3 a4 = 400,
        // then a3/t3 go too: u + a4 = 200 ≤ 350. The cut lands after t3, not
        // between a call and its result.
        assert_eq!(cut, 7);
        assert!(rows.iter().find(|m| m.created_at == cut + 1).unwrap().role != "tool");
    }

    /// The whole pass against a real database: the cutoff is saved, the task
    /// survives it, and a pinned result that was forgotten comes back as text.
    #[tokio::test]
    async fn apply_forgets_keeps_the_task_and_restores_pinned_results() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO chats (id, title, created_at, updated_at, rolling_context_tokens)
             VALUES ('c','t',0,0,500)",
        )
        .execute(&db)
        .await
        .unwrap();
        let mut rows: Vec<Message> = vec![msg("u", "user", 40, 1)];
        rows.extend((2..10).map(|i| msg(&format!("m{i}"), "assistant", 400, i)));
        rows[3].content = json!([{ "type": "text", "text": "THE-PINNED-OUTPUT" }]).to_string();
        sqlx::query("INSERT INTO context_pins (id, chat_id, note, message_id, created_at) VALUES ('p1','c','tests pass','m4',0)")
            .execute(&db)
            .await
            .unwrap();

        let block = apply(&db, "c", &mut rows).await.expect("a notice block");
        let MessageContent::Text(text) = block.content.unwrap() else { panic!() };
        assert!(text.contains("tests pass") && text.contains("THE-PINNED-OUTPUT"), "{text}");
        assert!(text.contains("earlier messages have been forgotten"));
        assert_eq!(rows[0].id, "u", "the task is never forgotten");
        assert!(rows.len() < 9);
        assert!(stored_through(&db, "c").await.is_some(), "the cutoff is saved");
    }

    #[test]
    fn a_later_cut_starts_from_the_existing_one() {
        let rows: Vec<Message> = (0..10).map(|i| msg(&format!("m{i}"), "assistant", 400, i)).collect();
        assert_eq!(advance(&rows, Some(6), 1_000, 4.0), None, "only 3 rows left, 300 tokens");
        let cut = advance(&rows, Some(2), 500, 4.0).unwrap();
        assert!(cut > 2);
    }
}
