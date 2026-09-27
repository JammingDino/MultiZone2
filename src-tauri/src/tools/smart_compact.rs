//! Smart compaction (0.18) — shrinking a chat's context without asking a model.
//!
//! `compact_context` has the model write a summary, which costs a full-context
//! request and loses whatever the summary leaves out. Most of a long agentic
//! chat is not conversation, though: it is tool traffic, and tool traffic has a
//! shape that can be shrunk by rule. Four rules, applied to everything at or
//! before the chat's `smart_compact_through` cutoff:
//!
//! 1. **Superseded results go.** A call repeated later with identical arguments
//!    — the same file read twice, the same `git status` — keeps only its newest
//!    result. The older one is replaced by a line saying where the newer is.
//! 2. **Tool outputs are trimmed** to their head and tail. The middle of a
//!    2,000-line file or a test log is rarely what the model came back for.
//! 3. **Tool inputs are hidden.** Long argument values — the whole file a
//!    `write` carried, a heredoc — are replaced by their length. Short ones
//!    (paths, commands, patterns) stay, since they are what makes the trimmed
//!    output readable.
//! 4. **Thinking goes.** Inline `<think>` blocks are stripped from old answers
//!    whatever the zone's setting — they were for the step that produced them.
//!
//! Like the summary cutoff, this only changes the request body. The messages on
//! screen and in the database are untouched, and moving the cutoff is the only
//! state, so the rewrite is deterministic — the same history compacts the same
//! way every time, which keeps a provider's prefix cache warm between steps.

use crate::db::models::Message;
use crate::error::AppResult;
use crate::llm::types::{ContentPart, Tool, ToolCall, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "smart_compact".into(),
            description: "Shrink your own context without summarizing: older tool results are \
                          trimmed to their head and tail, results of calls you later repeated with \
                          the same arguments are dropped, long tool inputs are hidden and old \
                          thinking is removed. Free and instant. Use it when the conversation is \
                          long and mostly tool output; the user still sees everything."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "keep_recent": {
                        "type": "integer",
                        "description": "Newest messages to leave untouched (default 6)."
                    }
                }
            }),
        },
    }
}

pub const DEFAULT_KEEP_RECENT: i64 = 6;

/// The user's knobs, from `app_settings.smartCompact`.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// A compacted tool result keeps this many characters, head and tail.
    pub output_chars: usize,
    /// A tool-call argument longer than this is replaced by its length.
    pub input_chars: usize,
    pub dedupe: bool,
    pub strip_thinking: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { output_chars: 1_500, input_chars: 300, dedupe: true, strip_thinking: true }
    }
}

pub async fn options(db: &SqlitePool) -> Options {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    let v = raw
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("smartCompact").cloned())
        .unwrap_or(Value::Null);
    let d = Options::default();
    let num = |k: &str, dflt: usize| {
        v.get(k).and_then(Value::as_u64).map(|n| (n as usize).max(100)).unwrap_or(dflt)
    };
    let flag = |k: &str, dflt: bool| v.get(k).and_then(Value::as_bool).unwrap_or(dflt);
    Options {
        output_chars: num("outputChars", d.output_chars),
        input_chars: num("inputChars", d.input_chars),
        dedupe: flag("dedupe", d.dedupe),
        strip_thinking: flag("stripThinking", d.strip_thinking),
    }
}

/// The chat's cutoff, or `None` when it has never been smart-compacted.
pub async fn cutoff(db: &SqlitePool, chat_id: &str) -> Option<i64> {
    sqlx::query_scalar::<_, Option<i64>>("SELECT smart_compact_through FROM chats WHERE id = ?1")
        .bind(chat_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .flatten()
}

/// Move the cutoff to just before the newest `keep_recent` primary messages.
/// Returns how many messages now sit at or before it, or `None` when there is
/// nothing old enough to compact.
pub async fn compact(db: &SqlitePool, chat_id: &str, keep_recent: i64) -> AppResult<Option<i64>> {
    let through: Option<i64> = sqlx::query_scalar(
        "SELECT created_at FROM messages WHERE chat_id = ?1 AND zone_id IS NULL
         ORDER BY created_at DESC LIMIT 1 OFFSET ?2",
    )
    .bind(chat_id)
    .bind(keep_recent.max(0))
    .fetch_optional(db)
    .await?;
    let Some(through) = through else { return Ok(None) };
    sqlx::query("UPDATE chats SET smart_compact_through = ?1 WHERE id = ?2")
        .bind(through)
        .bind(chat_id)
        .execute(db)
        .await?;
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE chat_id = ?1 AND zone_id IS NULL AND created_at <= ?2",
    )
    .bind(chat_id)
    .bind(through)
    .fetch_one(db)
    .await?;
    Ok(Some(n))
}

pub async fn run(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let keep = args.get("keep_recent").and_then(Value::as_i64).unwrap_or(DEFAULT_KEEP_RECENT);
    Ok(match compact(db, chat_id, keep).await? {
        Some(n) => json!({
            "ok": true,
            "messages_compacted": n,
            "note": "Done. From your next step, older tool results are trimmed and repeated \
                     calls collapsed in your context. Re-run a tool if you need its full \
                     output again.",
        }),
        None => json!({ "ok": false, "note": "Nothing old enough to compact yet." }),
    }
    .to_string())
}

/// The primary conversation as the request would start from it: past any
/// summary cutoff, before any rewriting.
pub(crate) async fn primary_rows(db: &SqlitePool, chat_id: &str) -> Vec<Message> {
    let mut rows: Vec<Message> = sqlx::query_as(
        "SELECT id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id,
                active_zone_id, edited, created_at
           FROM messages WHERE chat_id = ?1 AND zone_id IS NULL ORDER BY created_at ASC",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    if let Some((_, through)) = crate::tools::compact::compacted_prefix(db, chat_id).await {
        rows.retain(|m| m.created_at > through);
    }
    rows
}

/// Rough token weight of some rows, the way the meter counts them.
pub(crate) fn weight(rows: &[Message], chars_per_token: f64) -> i64 {
    let (mut chars, mut images) = (0i64, 0i64);
    for m in rows {
        let (c, i) = crate::commands::usage::content_chars(&m.content);
        chars += c + crate::commands::usage::tool_call_chars(m.tool_calls.as_deref());
        images += i;
    }
    (chars as f64 / chars_per_token.max(1.0)).round() as i64
        + images * crate::llm::tokens::IMAGE_TOKENS
}

/// Tokens the chat's current cutoff takes out of the next request.
pub async fn saved_tokens(db: &SqlitePool, chat_id: &str, chars_per_token: f64) -> i64 {
    let Some(through) = cutoff(db, chat_id).await else { return 0 };
    let rows = primary_rows(db, chat_id).await;
    let before = weight(&rows, chars_per_token);
    let mut after = rows;
    apply(&mut after, through, &options(db).await);
    (before - weight(&after, chars_per_token)).max(0)
}

/// A call's identity for de-duplication: its name and its arguments with the
/// keys in a stable order, so `{"a":1,"b":2}` and `{"b":2,"a":1}` match.
fn call_key(tc: &ToolCall) -> String {
    let args = serde_json::from_str::<Value>(&tc.function.arguments)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| tc.function.arguments.clone());
    format!("{}\u{0}{args}", crate::tools::canonical_name(&tc.function.name))
}

/// Keep the head and tail of `text`, `budget` characters in all.
fn trim_middle(text: &str, budget: usize) -> String {
    let total = text.chars().count();
    if total <= budget {
        return text.to_string();
    }
    let head = budget * 2 / 3;
    let tail = budget - head;
    let start: String = text.chars().take(head).collect();
    let end: String = text.chars().skip(total - tail).collect();
    format!("{start}\n[… {} characters trimmed by smart compaction …]\n{end}", total - budget)
}

/// Replace every string in an argument tree longer than `limit` with its length.
fn hide_long_strings(v: &mut Value, limit: usize) {
    match v {
        Value::String(s) if s.chars().count() > limit => {
            *s = format!("[{} characters hidden by smart compaction]", s.chars().count());
        }
        Value::Array(items) => items.iter_mut().for_each(|i| hide_long_strings(i, limit)),
        Value::Object(map) => map.values_mut().for_each(|i| hide_long_strings(i, limit)),
        _ => {}
    }
}

/// Rewrite `rows` (a primary conversation, oldest first) as the model should
/// see it. Only rows at or before `through` change.
pub fn apply(rows: &mut [Message], through: i64, opts: &Options) {
    // Which calls are superseded: every occurrence of a key but the last.
    let mut latest: HashMap<String, String> = HashMap::new();
    let mut key_of: HashMap<String, (String, String)> = HashMap::new();
    for m in rows.iter() {
        let Some(raw) = m.tool_calls.as_deref() else { continue };
        let Ok(calls) = serde_json::from_str::<Vec<ToolCall>>(raw) else { continue };
        for tc in calls {
            let key = call_key(&tc);
            latest.insert(key.clone(), tc.id.clone());
            key_of.insert(tc.id.clone(), (key, tc.function.name.clone()));
        }
    }

    for m in rows.iter_mut().filter(|m| m.created_at <= through) {
        match m.role.as_str() {
            "tool" => {
                let entry = m.tool_call_id.as_ref().and_then(|id| {
                    key_of.get(id).map(|(key, name)| (latest.get(key) != Some(id), name.clone()))
                });
                let superseded = opts.dedupe && entry.as_ref().is_some_and(|(s, _)| *s);
                let parts: Vec<ContentPart> = serde_json::from_str(&m.content).unwrap_or_default();
                let new_parts: Vec<ContentPart> = if superseded {
                    let name = entry.map(|(_, n)| n).unwrap_or_default();
                    vec![ContentPart::Text {
                        text: format!(
                            "[Result omitted: `{name}` was called again later with the same                              arguments — the newer result is the current one.]"
                        ),
                    }]
                } else {
                    parts
                        .into_iter()
                        .map(|p| match p {
                            ContentPart::Text { text } | ContentPart::HiddenText { text } => {
                                ContentPart::Text { text: trim_middle(&text, opts.output_chars) }
                            }
                            ContentPart::ImageUrl { .. } | ContentPart::HiddenImage { .. } => {
                                ContentPart::Text {
                                    text: "[Image removed by smart compaction.]".into(),
                                }
                            }
                        })
                        .collect()
                };
                if let Ok(s) = serde_json::to_string(&new_parts) {
                    m.content = s;
                }
            }
            "assistant" => {
                if opts.strip_thinking {
                    let mut parts: Vec<ContentPart> =
                        serde_json::from_str(&m.content).unwrap_or_default();
                    for p in &mut parts {
                        if let ContentPart::Text { text } = p {
                            *text = crate::llm::thinking::strip_thinking_blocks(text);
                        }
                    }
                    if let Ok(s) = serde_json::to_string(&parts) {
                        m.content = s;
                    }
                }
                if let Some(raw) = m.tool_calls.as_deref() {
                    if let Ok(mut calls) = serde_json::from_str::<Vec<ToolCall>>(raw) {
                        for tc in &mut calls {
                            // Unparseable arguments become `{}` rather than
                            // staying huge: some local chat templates parse them.
                            let mut v = serde_json::from_str::<Value>(&tc.function.arguments)
                                .unwrap_or_else(|_| json!({}));
                            hide_long_strings(&mut v, opts.input_chars);
                            tc.function.arguments = v.to_string();
                        }
                        if let Ok(s) = serde_json::to_string(&calls) {
                            m.tool_calls = Some(s);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, role: &str, content: &str, calls: Option<String>, call_id: Option<&str>, at: i64) -> Message {
        Message {
            id: id.into(),
            chat_id: "c".into(),
            role: role.into(),
            content: content.into(),
            tool_calls: calls,
            tool_call_id: call_id.map(str::to_string),
            reasoning: None,
            zone_id: None,
            active_zone_id: None,
            edited: false,
            created_at: at,
        }
    }

    fn call(id: &str, name: &str, args: Value) -> String {
        json!([{ "id": id, "type": "function", "function": { "name": name, "arguments": args.to_string() } }])
            .to_string()
    }

    fn text(t: &str) -> String {
        json!([{ "type": "text", "text": t }]).to_string()
    }

    #[test]
    fn compaction_trims_dedupes_hides_and_strips_only_before_the_cutoff() {
        let big = "x".repeat(5_000);
        let mut rows = vec![
            msg("a1", "assistant", &text("<think>hmm</think>reading"), Some(call("c1", "read", json!({"path":"a.rs"}))), None, 1),
            msg("t1", "tool", &text(&big), None, Some("c1"), 2),
            msg("a2", "assistant", &text(""), Some(call("c2", "write", json!({"path":"b.rs","content":big}))), None, 3),
            msg("t2", "tool", &text(&big), None, Some("c2"), 4),
            // The same read again, after the cutoff: supersedes t1.
            msg("a3", "assistant", &text(""), Some(call("c3", "read", json!({"path":"a.rs"}))), None, 5),
            msg("t3", "tool", &text(&big), None, Some("c3"), 6),
        ];
        apply(&mut rows, 4, &Options::default());

        assert!(rows[0].content.contains("reading") && !rows[0].content.contains("hmm"));
        assert!(rows[1].content.contains("called again later"), "{}", rows[1].content);
        assert!(rows[2].tool_calls.as_ref().unwrap().contains("characters hidden"));
        assert!(rows[2].tool_calls.as_ref().unwrap().contains("b.rs"), "short args stay");
        assert!(rows[3].content.contains("trimmed by smart compaction"));
        assert!(rows[3].content.len() < 2_000);
        // After the cutoff nothing changes, even the call that did the superseding.
        assert_eq!(rows[5].content, text(&big));
    }

    #[test]
    fn a_small_result_and_short_arguments_pass_through() {
        let mut rows = vec![
            msg("a1", "assistant", &text("ok"), Some(call("c1", "bash", json!({"command":"ls"}))), None, 1),
            msg("t1", "tool", &text("one\ntwo"), None, Some("c1"), 2),
        ];
        let before: Value = serde_json::from_str(&rows[1].content).unwrap();
        apply(&mut rows, 10, &Options::default());
        assert_eq!(serde_json::from_str::<Value>(&rows[1].content).unwrap(), before);
        assert!(rows[0].tool_calls.as_ref().unwrap().contains("ls"));
    }
}
