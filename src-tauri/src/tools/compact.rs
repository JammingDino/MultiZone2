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

    // Cut off at the newest message that isn't an assistant turn holding tool
    // calls. That message and everything before it is what the summary stands in
    // for.
    //
    // The cutoff must never land *on* a message with `tool_calls`, because the
    // tool results answering it are written later and would survive into the
    // next turn without the call they answer — which every provider rejects
    // outright ("Messages with role 'tool' must be a response to a preceding
    // message with 'tool_calls'"), permanently, since the cutoff is stored.
    //
    // This call is the live example: the assistant message carrying it is
    // already on disk (it is written before its tools run), so it is the newest
    // row right now, and its own result lands a few milliseconds after this
    // returns. Skipping past it keeps the pair together above the cutoff.
    //
    // Scoped to the primary conversation, because that is the only history the
    // cutoff is ever applied to (`build_message_history` filters perspective
    // messages out first, and a multi-model chat never sees the cutoff at all).
    let cutoff: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(created_at) FROM messages
         WHERE chat_id = ?1 AND zone_id IS NULL
           AND NOT (role = 'assistant' AND tool_calls IS NOT NULL)",
    )
    .bind(chat_id)
    .fetch_one(db)
    .await
    .unwrap_or(None);
    let cutoff = match cutoff {
        Some(c) => c,
        None => return Ok(json!({ "error": "nothing to compact — this chat has no messages yet" }).to_string()),
    };

    let compacted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE chat_id = ?1 AND zone_id IS NULL AND created_at <= ?2",
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
///
/// The size is deliberately *not* stated precisely. This string lives in the
/// system prompt, which is the front of the request, and prefix caches match on
/// a byte-exact prefix — so a number that ticks up every turn invalidates the
/// cache for the entire conversation behind it, on exactly the long chats where
/// the cache is worth the most. Bucketing to the nearest 25% of the window keeps
/// the string stable across most turns while still telling the model whether
/// this is "soon" or "now". `approx_chars` is a ~4 chars/token estimate.
pub fn compact_hint(approx_chars: usize) -> String {
    // Buckets, not a reading. Each only changes when the history crosses a
    // threshold, so a typical turn leaves the prompt byte-identical.
    let urgency = if approx_chars >= COMPACT_HINT_CHARS * 2 {
        "very long"
    } else if approx_chars >= COMPACT_HINT_CHARS * 3 / 2 {
        "long"
    } else {
        "getting long"
    };
    format!(
        "# Context length\nThis conversation is {urgency}. Call `compact_context` with a \
         thorough summary soon, before the oldest turns start falling out of your context window."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// The hint sits in the system prompt, so any per-turn churn in it costs the
    /// prefix cache for the whole conversation behind it. Growing the history
    /// without crossing a bucket boundary must leave the string untouched.
    #[test]
    fn the_hint_does_not_change_as_the_history_grows_within_a_bucket() {
        let baseline = compact_hint(COMPACT_HINT_CHARS);
        for extra in [1, 500, 5_000, COMPACT_HINT_CHARS / 2 - 1] {
            assert_eq!(
                baseline,
                compact_hint(COMPACT_HINT_CHARS + extra),
                "hint changed at +{extra} chars without crossing a bucket"
            );
        }
        // It still has to say something different once things get serious,
        // otherwise the bucketing has flattened the signal away entirely.
        assert_ne!(baseline, compact_hint(COMPACT_HINT_CHARS * 2));
    }

    async fn pool_with_chat() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c1','t',0,0)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn insert(pool: &sqlx::SqlitePool, id: &str, role: &str, calls: Option<&str>, at: i64) {
        sqlx::query(
            "INSERT INTO messages (id, chat_id, role, content, tool_calls, created_at)
             VALUES (?1, 'c1', ?2, '[]', ?3, ?4)",
        )
        .bind(id)
        .bind(role)
        .bind(calls)
        .bind(at)
        .execute(pool)
        .await
        .unwrap();
    }

    /// The cutoff must not land on the assistant message carrying this very
    /// call. That message is already on disk when the tool runs — it is written
    /// before its tools execute — while the result answering it is written a few
    /// milliseconds later. A cutoff of "the newest message right now" therefore
    /// dropped the call and kept its answer, and the provider rejected every
    /// later turn in the chat with "Messages with role 'tool' must be a response
    /// to a preceding message with 'tool_calls'".
    #[tokio::test]
    async fn the_cutoff_never_splits_the_turn_that_compacts() {
        let pool = pool_with_chat().await;
        let calls = r#"[{"id":"call_1","type":"function","function":{"name":"compact_context","arguments":"{}"}}]"#;
        insert(&pool, "m1", "user", None, 100).await;
        insert(&pool, "m2", "assistant", Some(calls), 200).await;
        insert(&pool, "m3", "tool", None, 300).await;
        insert(&pool, "m4", "assistant", None, 400).await;
        insert(&pool, "m5", "user", None, 500).await;
        // …and the turn now in flight: its result does not exist yet.
        insert(&pool, "m6", "assistant", Some(calls), 600).await;

        let summary = "x".repeat(super::MIN_SUMMARY_CHARS + 1);
        let out = super::run(&serde_json::json!({ "summary": summary }), &pool, "c1")
            .await
            .unwrap();
        assert!(out.contains("\"ok\":true"), "{out}");

        let cutoff: i64 =
            sqlx::query_scalar("SELECT context_summary_through FROM chats WHERE id = 'c1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cutoff, 500, "the cutoff must stop at the last message before the live turn");

        // What the next turn's history keeps: the compacting turn, whole.
        let kept: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM messages WHERE created_at > ?1 ORDER BY created_at",
        )
        .bind(cutoff)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(kept, ["m6"], "the call that compacted must survive to answer its own result");
    }
}
