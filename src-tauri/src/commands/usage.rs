//! Context accounting across a whole sub-agent session (0.9.12).
//!
//! Two things were invisible to the header's context meter, and both of them
//! matter more than what it did show:
//!
//! * **The baseline.** The meter counted the visible conversation. A request
//!   also carries the zone's system prompt, the skills catalog, injected
//!   memories, project and tag context, and every enabled tool's JSON schema —
//!   and the schemas are typically the largest item of the lot. All of it is
//!   re-sent on *every step* of every turn, so a chat reporting a few hundred
//!   tokens could never send a request under fifteen thousand.
//! * **The rest of the team.** A leader that fanned six specialists out over a
//!   codebase might be carrying 20k itself while the session carries a million,
//!   and none of that showed up in the one pane the user actually watches.
//!
//! This walks the session — the root chat of the sub-agent family plus every
//! descendant subchat — and measures both halves for each member.
//!
//! The conversation estimate deliberately mirrors `src/lib/tokens.ts` character
//! for character: same ~4 chars/token rule, same flat per-image cost, same
//! input/output split. Two estimators that disagree would make the popover's
//! "this chat" row contradict the button right above it. The baseline is built
//! from the same functions the turn builder uses, for the same reason.

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
    std::cmp::max(1, (chars as f64 / 4.0).round() as i64)
}

/// One labelled component of a chat's fixed per-turn cost.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverheadPart {
    pub label: String,
    pub tokens: i64,
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
    /// Conversation only: `input_tokens + output_tokens`.
    pub message_tokens: i64,
    /// The system prompt this chat's turns carry — zone prompt, skills catalog,
    /// memories, project and tag context, preambles.
    pub system_tokens: i64,
    /// The tool schemas sent alongside it.
    pub tools_tokens: i64,
    pub tool_count: i64,
    /// `system_tokens + tools_tokens` — what a turn costs before anyone speaks.
    pub overhead_tokens: i64,
    /// The system prompt broken down by what put each piece there, largest
    /// first. Empty pieces are dropped.
    pub overhead_parts: Vec<OverheadPart>,
    /// Everything: conversation plus baseline.
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
    /// Every agent's system prompt and tool schemas added up. A team pays this
    /// once per member, which is most of why a six-agent session is expensive
    /// before it has done anything.
    pub overhead_tokens: i64,
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

/// Estimate one chat's conversation from its stored messages.
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

/// What one chat carries before a word is typed: its system prompt (zone
/// prompt, skills catalog, memories, project and tag context, preambles) and
/// the tool schemas offered with it.
///
/// Returns `(system_tokens, tools_tokens, tool_count, parts)`.
async fn chat_overhead(
    db: &SqlitePool,
    chat_id: &str,
) -> AppResult<(i64, i64, i64, Vec<OverheadPart>)> {
    let overhead = crate::commands::messages::turn_overhead(db, chat_id).await?;

    let mut parts: Vec<OverheadPart> = Vec::new();
    let mut system_tokens = 0i64;
    for (kind, text) in &overhead.snippets {
        let tokens = estimate_tokens(text.chars().count() as i64);
        if tokens == 0 {
            continue;
        }
        system_tokens += tokens;
        // Several tags each contribute their own snippet; they read as one line.
        match parts.iter_mut().find(|p| p.label == kind.label()) {
            Some(existing) => existing.tokens += tokens,
            None => parts.push(OverheadPart { label: kind.label().to_string(), tokens }),
        }
    }
    // Largest first, so the reason a chat is expensive is the first line of the
    // breakdown rather than something to hunt for.
    parts.sort_by(|a, b| b.tokens.cmp(&a.tokens));

    let tools_tokens = estimate_tokens(overhead.tools_json.chars().count() as i64);
    Ok((system_tokens, tools_tokens, overhead.tool_count as i64, parts))
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
    session_usage(&state.db, &chat_id).await
}

/// The command's body, over a plain pool so it can be exercised without an
/// `AppState`.
pub async fn session_usage(db: &SqlitePool, chat_id: &str) -> AppResult<SessionUsage> {
    let root = crate::tools::teamwork::session_root(db, chat_id).await?;

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
    let mut overhead_total = 0i64;

    for (id, title, _, zone_name) in &rows {
        let (input, output, messages) = chat_usage(db, id).await?;
        let (system_tokens, tools_tokens, tool_count, overhead_parts) =
            chat_overhead(db, id).await?;
        let overhead_tokens = system_tokens + tools_tokens;
        input_tokens += input;
        output_tokens += output;
        overhead_total += overhead_tokens;

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
            is_current: id == chat_id,
            depth,
            messages,
            input_tokens: input,
            output_tokens: output,
            message_tokens: input + output,
            system_tokens,
            tools_tokens,
            tool_count,
            overhead_tokens,
            overhead_parts,
            total_tokens: input + output + overhead_tokens,
        });
    }

    Ok(SessionUsage {
        root_chat_id: root,
        agents,
        input_tokens,
        output_tokens,
        overhead_tokens: overhead_total,
        total_tokens: input_tokens + output_tokens + overhead_total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::MIGRATOR.run(&pool).await.unwrap();
        pool
    }

    /// A chat whose zone has a real system prompt, a toolset, and a memory to
    /// inject — i.e. a chat that costs something before anyone types.
    async fn fixture() -> SqlitePool {
        let db = pool().await;
        sqlx::query(
            "INSERT INTO providers (id, name, base_url, api_key, default_model, created_at)
             VALUES ('p1', 'local', 'http://localhost:1234/v1', NULL, 'test-model', 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO zones (id, name, provider_id, model, system_prompt, temperature,
                                tools_enabled, tool_config, thinking_enabled,
                                include_thinking_in_context, is_leader, created_at, updated_at)
             VALUES ('z1', 'Coder', 'p1', 'test-model', ?1, 0.2,
                     '[\"file_system\",\"memory\",\"shell_exec\"]', '{}', 0, 0, 0, 1, 1)",
        )
        .bind("You are a careful engineer. ".repeat(40))
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chats (id, title, zone_id, created_at, updated_at)
             VALUES ('c1', 'Chat', 'z1', 1, 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO memories (id, scope, scope_id, content, created_at, updated_at)
             VALUES ('m1', 'global', NULL, ?1, 1, 1)",
        )
        .bind("The test suite is run with `cargo test`. ".repeat(10))
        .execute(&db)
        .await
        .unwrap();
        db
    }

    async fn add_message(db: &SqlitePool, id: &str, role: &str, text: &str) {
        let content = json!([{ "type": "text", "text": text }]).to_string();
        sqlx::query(
            "INSERT INTO messages (id, chat_id, role, content, created_at)
             VALUES (?1, 'c1', ?2, ?3, 1)",
        )
        .bind(id)
        .bind(role)
        .bind(content)
        .execute(db)
        .await
        .unwrap();
    }

    /// The regression this exists for: the meter counted the visible
    /// conversation and nothing else, so a chat that never sends a request under
    /// 10k reported a few hundred tokens. The system prompt, the injected
    /// memories and the tool schemas are all part of what is sent.
    #[tokio::test]
    async fn baseline_counts_the_prompt_the_memories_and_the_tool_schemas() {
        let db = fixture().await;
        let usage = session_usage(&db, "c1").await.unwrap();
        let me = &usage.agents[0];

        assert!(me.system_tokens > 0, "system prompt must be counted");
        assert!(me.tools_tokens > 0, "tool schemas must be counted");
        assert!(me.tool_count >= 3, "file_system alone defines several tools");
        assert_eq!(me.overhead_tokens, me.system_tokens + me.tools_tokens);

        let labels: Vec<&str> = me.overhead_parts.iter().map(|p| p.label.as_str()).collect();
        assert!(labels.contains(&"Zone prompt"), "{labels:?}");
        assert!(labels.contains(&"Memories"), "{labels:?}");
        assert!(me.overhead_parts.iter().all(|p| p.tokens > 0), "{labels:?}");
        assert_eq!(
            me.overhead_parts.iter().map(|p| p.tokens).sum::<i64>(),
            me.system_tokens,
            "the breakdown has to add up to the total it breaks down",
        );
        assert!(me.overhead_parts.windows(2).all(|w| w[0].tokens >= w[1].tokens));

        // Sanity on magnitude, not just non-zero: schemas for three tool groups
        // run to four figures, which is the whole point — this is the item that
        // dwarfs a short conversation, not a rounding error on it.
        assert!(
            me.tools_tokens > 500,
            "eight tool schemas should be four figures, got {}",
            me.tools_tokens,
        );
    }

    /// Conversation and baseline are separate halves of one total — a chat with
    /// no messages still costs its baseline, and messages add on top.
    #[tokio::test]
    async fn conversation_adds_to_the_baseline_rather_than_replacing_it() {
        let db = fixture().await;
        let empty = session_usage(&db, "c1").await.unwrap();
        assert_eq!(empty.agents[0].message_tokens, 0);
        assert!(empty.total_tokens > 0, "an empty chat still carries its baseline");

        add_message(&db, "u1", "user", &"how does this work? ".repeat(50)).await;
        add_message(&db, "a1", "assistant", &"like so. ".repeat(50)).await;

        let after = session_usage(&db, "c1").await.unwrap();
        let me = &after.agents[0];
        assert_eq!(me.messages, 2);
        assert!(me.input_tokens > 0 && me.output_tokens > 0);
        assert_eq!(me.message_tokens, me.input_tokens + me.output_tokens);
        assert_eq!(me.total_tokens, me.message_tokens + me.overhead_tokens);
        assert_eq!(
            me.overhead_tokens, empty.agents[0].overhead_tokens,
            "talking does not change the baseline",
        );
    }

    /// Each sub-agent pays its own baseline, which is most of why a team is
    /// expensive before it has done anything. The session total has to include
    /// every member's, not just the leader's.
    #[tokio::test]
    async fn every_subagent_carries_its_own_baseline() {
        let db = fixture().await;
        sqlx::query(
            "INSERT INTO chats (id, title, zone_id, parent_chat_id, initiated_by_zone_id,
                                created_at, updated_at)
             VALUES ('c2', 'sub', 'z1', 'c1', 'z1', 2, 2)",
        )
        .execute(&db)
        .await
        .unwrap();

        let usage = session_usage(&db, "c1").await.unwrap();
        assert_eq!(usage.agents.len(), 2);
        let leader = &usage.agents[0];
        let sub = &usage.agents[1];
        assert!(sub.overhead_tokens > 0, "a sub-agent pays the same baseline");
        assert_eq!(usage.overhead_tokens, leader.overhead_tokens + sub.overhead_tokens);
        assert_eq!(
            usage.total_tokens,
            usage.input_tokens + usage.output_tokens + usage.overhead_tokens,
        );

        // Asking from inside the subchat answers for the same session.
        let from_sub = session_usage(&db, "c2").await.unwrap();
        assert_eq!(from_sub.root_chat_id, "c1");
        assert_eq!(from_sub.total_tokens, usage.total_tokens);
        assert!(from_sub.agents.iter().find(|a| a.chat_id == "c2").unwrap().is_current);
    }

    /// The frontend estimator is the reference: ~4 chars a token, never zero for
    /// non-empty text. A drift here shows up as the popover's conversation row
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
