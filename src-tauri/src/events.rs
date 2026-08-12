//! The session event log (0.12.2).
//!
//! What an agent did is currently only inspectable *while* it scrolls past. The
//! transcript keeps the tool calls, but not their order relative to anything
//! else, and the moments that matter most when something has gone wrong —
//! an approval denied, a zone switched mid-turn, plan mode entered, a turn that
//! ended in a provider error — leave no trace at all once the toast is gone.
//!
//! This is the record: one ordered row per thing that happened, written as it
//! happens, cheap enough that nothing has to decide whether an event is
//! important enough to keep.
//!
//! Two rules hold the design together:
//!
//! - **Recording never fails a turn.** Every writer here is best-effort and
//!   logs rather than propagates. A log that can break the thing it observes is
//!   worse than no log.
//! - **The label is written for a person, at write time.** Replaying a session
//!   months later must not depend on the zone, the file or the plan still
//!   existing — so the human-readable line is stored, not derived.

use crate::commands::{new_id, now_ts};
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub chat_id: String,
    pub turn_id: Option<String>,
    pub zone_id: Option<String>,
    pub kind: String,
    pub label: String,
    /// JSON blob, or `None`.
    pub detail: Option<String>,
    pub created_at: i64,
}

pub const EVENT_COLS: &str = "id, chat_id, turn_id, zone_id, kind, label, detail, created_at";

/// Append one event. Best-effort: a failure is logged and swallowed.
pub async fn record(
    db: &SqlitePool,
    chat_id: &str,
    turn_id: Option<&str>,
    zone_id: Option<&str>,
    kind: &str,
    label: impl Into<String>,
    detail: Option<Value>,
) {
    let label = label.into();
    let detail = detail.map(|d| d.to_string());
    if let Err(e) = sqlx::query(
        "INSERT INTO session_events (id, chat_id, turn_id, zone_id, kind, label, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(new_id())
    .bind(chat_id)
    .bind(turn_id)
    .bind(zone_id)
    .bind(kind)
    .bind(&label)
    .bind(detail)
    .bind(now_ts())
    .execute(db)
    .await
    {
        tracing::warn!("session event ({kind}) not recorded: {e}");
    }
}

/// A chat's log, oldest first. `limit` caps it from the *end* — a replay of a
/// long session wants the whole thing, but a preview wants the tail.
pub async fn list(db: &SqlitePool, chat_id: &str, limit: Option<i64>) -> AppResult<Vec<SessionEvent>> {
    let rows = match limit {
        Some(n) => {
            let mut rows = sqlx::query_as::<_, SessionEvent>(&format!(
                "SELECT {EVENT_COLS} FROM session_events WHERE chat_id = ?1
                 ORDER BY created_at DESC, rowid DESC LIMIT ?2"
            ))
            .bind(chat_id)
            .bind(n)
            .fetch_all(db)
            .await?;
            rows.reverse();
            rows
        }
        None => {
            sqlx::query_as::<_, SessionEvent>(&format!(
                "SELECT {EVENT_COLS} FROM session_events WHERE chat_id = ?1
                 ORDER BY created_at ASC, rowid ASC"
            ))
            .bind(chat_id)
            .fetch_all(db)
            .await?
        }
    };
    Ok(rows)
}

/// Delete a chat's log — used when the chat itself goes.
pub async fn clear(db: &SqlitePool, chat_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM session_events WHERE chat_id = ?1")
        .bind(chat_id)
        .execute(db)
        .await?;
    Ok(())
}

/// The tools whose calls count as a change to the user's machine, so the log can
/// say "this turn wrote three files" without the reader having to know which
/// tool names mean writing. Deliberately its own list rather than "not
/// read-only": plan mode's allowlist answers a different question (may this run
/// at all), and conflating the two would make one of them wrong the next time a
/// tool is added.
pub fn is_file_mutation(name: &str) -> bool {
    matches!(
        name,
        "create_file" | "edit_file" | "delete_file" | "move_file" | "copy_file" | "create_folder"
    )
}

/// A short, safe summary of a tool call's arguments for the log's detail blob.
/// Long arguments — a whole file's contents — are truncated, because the log is
/// a record of what happened and not a second copy of everything that happened.
pub fn summarize_args(args: &str) -> Value {
    const MAX: usize = 400;
    match serde_json::from_str::<Value>(args) {
        Ok(Value::Object(map)) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let short = match &v {
                    Value::String(s) if s.chars().count() > MAX => {
                        let head: String = s.chars().take(MAX).collect();
                        Value::String(format!("{head}… ({} characters)", s.chars().count()))
                    }
                    other => other.clone(),
                };
                out.insert(k, short);
            }
            Value::Object(out)
        }
        Ok(other) => other,
        Err(_) => Value::String(args.chars().take(MAX).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn long_arguments_are_truncated_not_copied() {
        let big = "x".repeat(5_000);
        let args = json!({ "path": "notes.md", "content": big }).to_string();
        let summary = summarize_args(&args);
        let content = summary["content"].as_str().unwrap();
        assert!(content.len() < 600, "content was copied whole into the log");
        assert!(content.contains("5000 characters"));
        // Short fields survive untouched — the point is to stay readable.
        assert_eq!(summary["path"], json!("notes.md"));
    }

    #[test]
    fn unparseable_arguments_still_summarize() {
        let summary = summarize_args("not json at all");
        assert_eq!(summary, json!("not json at all"));
    }

    #[test]
    fn file_mutations_are_named_explicitly() {
        assert!(is_file_mutation("edit_file"));
        assert!(is_file_mutation("delete_file"));
        assert!(!is_file_mutation("read_file"));
        assert!(!is_file_mutation("run_command"));
    }
}
