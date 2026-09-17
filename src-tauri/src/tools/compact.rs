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
                 context window. Call this when the user asks you to, or when the conversation \
                 has clearly grown long.\n\n\
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

    let compacted = match store_summary(db, chat_id, summary).await? {
        Some(n) => n,
        None => return Ok(json!({ "error": "nothing to compact — this chat has no messages yet" }).to_string()),
    };

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

/// Write `summary` as the chat's compacted prefix and move the cutoff to the
/// newest message it can stand in for. Returns how many messages that is, or
/// `None` for a chat with nothing to compact. Shared by the tool and by the
/// harness-driven compaction in [`auto_compact`].
pub async fn store_summary(db: &SqlitePool, chat_id: &str, summary: &str) -> AppResult<Option<i64>> {
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
        None => return Ok(None),
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

    Ok(Some(compacted))
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

/// Tokens kept free below the window for the next turn's output and tool
/// results. pi's figure.
pub const RESERVE_TOKENS: i64 = 16_384;

/// The model's context window, found the way the meter finds it (0.17.9):
/// the provider's model entry, a local server's native API, the models.dev
/// catalogue, a family table. `None` when nothing knows — then only a
/// provider's overflow error can trigger compaction.
pub async fn context_window_tokens(
    http: &reqwest::Client,
    provider: &crate::db::models::Provider,
    model: &str,
) -> Option<i64> {
    crate::llm::context_window::lookup_default(http, provider, model)
        .await
        .map(|w| w.tokens)
}

/// Whether `context_tokens` — the last request's measured or estimated prompt
/// size — is past the point where the next turn risks overflowing.
pub fn should_compact(context_tokens: i64, window: Option<i64>) -> bool {
    let Some(window) = window else { return false };
    window > RESERVE_TOKENS * 2 && context_tokens >= window - RESERVE_TOKENS
}

/// Whether a provider error is the request being too long for the model.
/// Wording varies by server — OpenAI, vLLM, llama.cpp, LM Studio, Ollama and
/// Anthropic-compatible shims all say it differently — so this is a phrase
/// list, kept short and lower-case.
pub fn is_context_overflow(error: &str) -> bool {
    let e = error.to_lowercase();
    [
        "context length",
        "context_length",
        "context window",
        "maximum context",
        "too many tokens",
        "prompt is too long",
        "prompt too long",
        "input is too long",
        "reduce the length",
        "exceeds the limit",
        "request too large",
    ]
    .iter()
    .any(|p| e.contains(p))
}

/// The summarisation instruction. pi's template: structured, and explicit that
/// exact names, paths and error text must survive.
const SUMMARY_INSTRUCTION: &str = "The conversation above is being condensed so it fits in your \
context window. Write the summary that will stand in for it from the next turn on. Use these \
sections:\n\n\
## Goal\nWhat the user is trying to get done, in their terms.\n\n\
## Decisions and constraints\nEverything agreed or ruled out, with the reason.\n\n\
## Established facts\nWhat has been found out — exact file paths, function names, commands, \
version numbers, error messages, verbatim.\n\n\
## Done\nWhat has been changed or produced, and where.\n\n\
## Outstanding\nWhat is still to do, in order, and any open questions.\n\n\
If the conversation already opens with a summary from an earlier condensation, fold it in \
rather than dropping it. Be thorough — this is all you will retain. Reply with the summary \
only.";

/// Harness-driven compaction (0.18): condense the chat from outside the turn,
/// the way pi and opencode do, rather than waiting for the model to decide to
/// call `compact_context`. Runs after a turn whose last request was within
/// [`RESERVE_TOKENS`] of the window. One extra request, no tools, plain text.
///
/// Returns how many messages the summary now stands in for, or `None` when
/// nothing was stored (the model produced nothing usable).
pub async fn auto_compact(
    db: &SqlitePool,
    http: &reqwest::Client,
    chat_id: &str,
    zone: &crate::db::models::Zone,
    provider: &crate::db::models::Provider,
) -> AppResult<Option<i64>> {
    use crate::llm::types::{ChatMessage, ChatRequest, MessageContent};

    let mut messages =
        crate::commands::messages::build_message_history(db, chat_id, zone, false).await?;
    messages.push(ChatMessage {
        role: "user".into(),
        content: Some(MessageContent::Text(SUMMARY_INSTRUCTION.into())),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    });
    let req = ChatRequest {
        model: zone.model.clone(),
        messages,
        temperature: Some(0.2),
        max_tokens: Some(4000),
        top_p: None,
        tools: None,
        tool_choice: None,
        reasoning_effort: None,
        chat_template_kwargs: None,
        stream_options: None,
        stream: false,
    };
    let measure = {
        let cpt = crate::llm::tokens::chars_per_token(db, &req.model).await;
        crate::llm::tokens::measure_request(&req, cpt)
    };
    let client = crate::llm::client::LlmClient::new(http, &provider.base_url, provider.api_key.as_deref());
    let resp = client.chat_completion(&req).await?;
    crate::llm::tokens::record_request(db, chat_id, &zone.model, &measure, resp.usage.as_ref()).await;

    let text = resp
        .choices
        .first()
        .and_then(|c| match &c.message.content {
            Some(MessageContent::Text(s)) => Some(s.clone()),
            Some(MessageContent::Parts(parts)) => Some(
                parts
                    .iter()
                    .filter_map(|p| match p {
                        crate::llm::types::ContentPart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\\n"),
            ),
            None => None,
        })
        .unwrap_or_default();
    let summary = crate::llm::thinking::strip_thinking_blocks(&text);
    let summary = summary.trim();
    if summary.len() < MIN_SUMMARY_CHARS {
        tracing::warn!("auto-compaction of {chat_id} produced no usable summary");
        return Ok(None);
    }
    store_summary(db, chat_id, summary).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

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

    #[test]
    fn compaction_triggers_inside_the_reserve_and_never_with_the_window_off() {
        assert!(!should_compact(200_000, None));
        assert!(!should_compact(100_000, Some(128_000)));
        assert!(should_compact(128_000 - RESERVE_TOKENS, Some(128_000)));
        assert!(should_compact(140_000, Some(128_000)));
        // A window smaller than two reserves cannot be compacted into.
        assert!(!should_compact(30_000, Some(20_000)));
    }

    #[test]
    fn overflow_errors_are_recognised_and_ordinary_ones_are_not() {
        assert!(is_context_overflow("This model's maximum context length is 32768 tokens. However, you requested 40011 tokens"));
        assert!(is_context_overflow("400: prompt is too long: 210000 tokens > 200000 maximum"));
        assert!(is_context_overflow("the request exceeds the model's context window"));
        assert!(!is_context_overflow("401 Unauthorized"));
        assert!(!is_context_overflow("connection refused"));
    }
}
