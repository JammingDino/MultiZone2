//! Context accounting across a whole sub-agent session (0.9.12).
//!
//! The header's context meter measures the chat you are looking at, which is the
//! right number for "am I about to overflow this model's window". It is the
//! wrong number for "what is this costing me": a leader that fanned six
//! specialists out over a codebase might be carrying 20k tokens itself while the
//! session as a whole is carrying a million, and none of that shows up anywhere
//! the user actually looks.
//!
//! This walks the session — the root chat of the sub-agent family plus every
//! descendant subchat — and estimates each one's context, so the meter can show
//! the team total next to the local one.
//!
//! The estimate deliberately mirrors `src/lib/tokens.ts` character for
//! character: same ~4 chars/token rule, same flat per-image cost, same
//! input/output split. Two estimators that disagree would make the popover's
//! "this chat" row contradict the button right above it.

use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

/// Flat per-image cost, matching `IMAGE_TOKEN_ESTIMATE` in the frontend.
const IMAGE_TOKEN_ESTIMATE: i64 = 1000;

/// Chars → tokens, matching `estimateTokens` in the frontend.
fn estimate_tokens(chars: i64) -> i64 {
    if chars <= 0 {
        return 0;
    }
    // `.round()` on a half is away-from-zero in Rust and to-even in JS's
    // Math.round only for negatives — both round .5 up for positive input.
    std::cmp::max(1, (chars as f64 / 4.0).round() as i64)
}

/// One chat's share of the session's context.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub chat_id: String,
    pub title: String,
    /// The zone answering in this chat, when it has one.
    pub zone_name: Option<String>,
    /// True for the chat the meter is being shown in.
    pub is_current: bool,
    /// How many subchat levels below the session root, 0 for the root itself.
    pub depth: i64,
    pub messages: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
}

/// Every chat in one sub-agent family, plus the totals across them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub root_chat_id: String,
    /// Root first, then descendants in creation order.
    pub agents: Vec<AgentUsage>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
}

/// Text and image content of one stored message, split the way the meter
/// reports it. `chars` counts characters rather than bytes so the number tracks
/// the frontend's UTF-16 `String.length` on ordinary prose.
fn content_chars(json: &str) -> (i64, i64) {
    let Ok(Value::Array(parts)) = serde_json::from_str::<Value>(json) else {
        return (json.chars().count() as i64, 0);
    };
    let mut chars = 0i64;
    let mut images = 0i64;
    for p in &parts {
        match p.get("type").and_then(|t| t.as_str()) {
            Some("text") | Some("hidden_text") => {
                chars += p.get("text").and_then(|t| t.as_str()).map_or(0, |t| t.chars().count() as i64);
            }
            Some("image_url") | Some("hidden_image") => images += 1,
            _ => {}
        }
    }
    (chars, images)
}

/// Name + argument characters of a message's tool calls — what the model
/// generated to make them, which is output, not input.
fn tool_call_chars(json: Option<&str>) -> i64 {
    let Some(json) = json else { return 0 };
    let Ok(Value::Array(calls)) = serde_json::from_str::<Value>(json) else {
        return json.chars().count() as i64;
    };
    calls
        .iter()
        .map(|c| {
            let f = c.get("function");
            let name = f.and_then(|f| f.get("name")).and_then(|v| v.as_str());
            let args = f.and_then(|f| f.get("arguments")).and_then(|v| v.as_str());
            name.map_or(0, |s| s.chars().count() as i64) + args.map_or(0, |s| s.chars().count() as i64)
        })
        .sum()
}

/// Estimate one chat's context from its stored messages.
async fn chat_usage(db: &SqlitePool, chat_id: &str) -> AppResult<(i64, i64, i64)> {
    let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT role, content, reasoning, tool_calls FROM messages WHERE chat_id = ?1",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await?;

    let messages = rows.len() as i64;
    let mut input_chars = 0i64;
    let mut output_chars = 0i64;
    let mut images = 0i64;

    for (role, content, reasoning, tool_calls) in &rows {
        let (chars, imgs) = content_chars(content);
        images += imgs;
        if role == "assistant" {
            output_chars += chars
                + reasoning.as_deref().map_or(0, |r| r.chars().count() as i64)
                + tool_call_chars(tool_calls.as_deref());
        } else {
            // user, tool results and system are all read by the model as input.
            input_chars += chars;
        }
    }

    let input = estimate_tokens(input_chars) + images * IMAGE_TOKEN_ESTIMATE;
    let output = estimate_tokens(output_chars);
    Ok((input, output, messages))
}

/// Context carried by every chat in `chat_id`'s sub-agent session.
///
/// Answers the same thing from anywhere in the family — asking from a subchat
/// walks up to the session root first — so the total doesn't change depending on
/// which pane you happen to have open.
#[tauri::command]
pub async fn session_context_usage(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<SessionUsage> {
    let db = &state.db;
    let root = crate::tools::teamwork::session_root(db, &chat_id).await?;

    // The root plus every descendant subchat. Branches share the
    // `parent_chat_id` link but have no owning zone, so they are their own
    // sessions and are excluded — same rule `get_subchat_tree` uses.
    let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "WITH RECURSIVE descendants(id) AS (
            SELECT id FROM chats
              WHERE parent_chat_id = ?1 AND initiated_by_zone_id IS NOT NULL
            UNION ALL
            SELECT c.id FROM chats c
              JOIN descendants d ON c.parent_chat_id = d.id
              WHERE c.initiated_by_zone_id IS NOT NULL
         )
         SELECT c.id, c.title, c.parent_chat_id, z.name
           FROM chats c LEFT JOIN zones z ON z.id = c.zone_id
          WHERE c.id = ?1 OR c.id IN (SELECT id FROM descendants)
          ORDER BY CASE WHEN c.id = ?1 THEN 0 ELSE 1 END, c.created_at ASC",
    )
    .bind(&root)
    .fetch_all(db)
    .await?;

    let parents: HashMap<&str, Option<&str>> = rows
        .iter()
        .map(|(id, _, parent, _)| (id.as_str(), parent.as_deref()))
        .collect();

    let mut agents = Vec::with_capacity(rows.len());
    let mut input_tokens = 0i64;
    let mut output_tokens = 0i64;

    for (id, title, _, zone_name) in &rows {
        let (input, output, messages) = chat_usage(db, id).await?;
        input_tokens += input;
        output_tokens += output;

        // Hops from this chat up to the root. Bounded so a cyclic parent link
        // can't spin here, the same guard the other tree walks use.
        let mut depth = 0i64;
        let mut cur = id.as_str();
        for _ in 0..64 {
            if cur == root {
                break;
            }
            match parents.get(cur).copied().flatten() {
                Some(p) => {
                    depth += 1;
                    cur = p;
                }
                None => break,
            }
        }

        agents.push(AgentUsage {
            chat_id: id.clone(),
            title: title.clone(),
            zone_name: zone_name.clone(),
            is_current: *id == chat_id,
            depth,
            messages,
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + output,
        });
    }

    Ok(SessionUsage {
        root_chat_id: root,
        agents,
        input_tokens,
        output_tokens,
        total_tokens: input_tokens + output_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The frontend estimator is the reference: ~4 chars a token, never zero for
    /// non-empty text. A drift here shows up as the popover's "this chat" row
    /// disagreeing with the button directly above it.
    #[test]
    fn token_estimate_matches_the_frontend_rule() {
        assert_eq!(estimate_tokens(0), 0);
        assert_eq!(estimate_tokens(-5), 0);
        assert_eq!(estimate_tokens(1), 1, "non-empty text is never zero tokens");
        assert_eq!(estimate_tokens(2), 1);
        assert_eq!(estimate_tokens(4), 1);
        assert_eq!(estimate_tokens(400), 100);
        assert_eq!(estimate_tokens(402), 101, "rounds, not truncates");
    }

    #[test]
    fn only_text_parts_are_measured_and_images_are_counted() {
        let content = json!([
            { "type": "text", "text": "hello" },
            { "type": "hidden_text", "text": "hidden" },
            // A data URL is megabytes of base64 that the model never reads as
            // text — counting its length would swamp the whole estimate.
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
            { "type": "hidden_image", "image_url": { "url": "data:image/png;base64,BBBB" } },
        ])
        .to_string();
        assert_eq!(content_chars(&content), (11, 2));
    }

    #[test]
    fn tool_calls_measure_name_and_arguments_only() {
        let calls = json!([
            { "id": "call_1", "type": "function",
              "function": { "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" } },
        ])
        .to_string();
        assert_eq!(tool_call_chars(Some(&calls)), 9 + 15);
        assert_eq!(tool_call_chars(None), 0);
    }

    /// Content that isn't the expected parts array still has to produce a
    /// number — a stored message the meter can't parse is not a reason to
    /// report zero for the whole session.
    #[test]
    fn unparseable_content_falls_back_to_its_length() {
        assert_eq!(content_chars("not json at all"), (15, 0));
        assert_eq!(tool_call_chars(Some("not json")), 8);
    }
}
