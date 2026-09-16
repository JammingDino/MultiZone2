//! `read_context` — the model reads its own context meter (0.17.10).
//!
//! The workspace panel shows the user what the next request is made of, what
//! the chat has spent, and how close it is to the model's window. The model
//! could see none of it: it was told "this conversation is getting long" and
//! nothing else, so when a user asked it to work cheaper it had no figures to
//! work from. This hands it the same readout the panel draws — the same
//! functions, so the two never disagree — plus two things a human can't read
//! off a bar: the size of each tool schema, and which messages are the heavy
//! ones. Those are what an answer to "why is this expensive" is made of.
//!
//! Every figure is labelled as estimated or measured, the way the panel labels
//! them, because a model that reads an estimate as the provider's word will
//! confidently draw the wrong conclusion from it.
//!
//! Safe: it reads the app's own bookkeeping about this chat and changes nothing.

use crate::commands::usage::{
    content_chars, estimate_tokens, session_usage, tool_call_chars, IMAGE_TOKEN_ESTIMATE,
};
use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "read_context".into(),
            description:
                "Read this chat's context meter, as the user sees it: what the next request \
                 carries (system prompt by part, each tool schema's size, the conversation), how \
                 full the model's window is, what has been billed (requests, input, cached input, \
                 output), the session spend limit, and the heaviest messages. Use it when asked \
                 what a chat costs, why, or how to spend less. Context sizes are estimates (~4 \
                 chars/token); spend is measured. Every step re-sends the whole context, so spend \
                 runs far ahead of context size. Levers: `compact_context` when the conversation \
                 is the bulk; fewer tool groups when the schemas are; a stable system prompt so \
                 the prompt cache keeps hitting."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "largest_messages": {
                        "type": "integer",
                        "description": "Heaviest messages to list, largest first (default 8, max 30; 0 for none)."
                    }
                },
                "required": []
            }),
        },
    }
}

/// How much of a message to quote beside its size — enough to recognize it.
const PREVIEW_CHARS: usize = 90;

pub async fn run(args: &Value, db: &SqlitePool, chat_id: &str, http: &reqwest::Client) -> AppResult<String> {
    let want_largest = args
        .get("largest_messages")
        .and_then(|v| v.as_i64())
        .unwrap_or(8)
        .clamp(0, 30) as usize;

    let usage = session_usage(db, chat_id).await?;
    let Some(me) = usage.agents.iter().find(|a| a.is_current) else {
        return Ok(json!({ "error": "this chat is not in the session it was asked about" }).to_string());
    };

    // The model's ceiling, from whoever will answer. Only the current chat's —
    // a team's members may each be on a different model, and their windows are
    // theirs to ask about.
    let (model, window) =
        match crate::commands::messages::effective_zone_and_provider(db, chat_id).await {
            Ok((zone, provider)) => {
                let w = crate::llm::context_window::lookup_default(http, &provider, &zone.model).await;
                (Some(zone.model), w)
            }
            Err(_) => (None, None),
        };

    let overhead = crate::commands::messages::turn_overhead(db, chat_id).await?;
    let tool_schemas = schema_sizes(&overhead.tools_json);

    let conv = conversation(db, chat_id, want_largest).await?;
    let next_request = me.overhead_tokens + conv.input_tokens + conv.output_tokens;

    let spent = &me.spent;
    let spend_is_measured = spent.requests > 0 && spent.reported_requests >= spent.requests;
    let cache_hit_pct = if spent.input_tokens > 0 {
        Some(percent(spent.cached_input_tokens, spent.input_tokens))
    } else {
        None
    };

    // The session cap, which is the one figure here that can stop a run.
    let limit = crate::commands::messages::max_session_tokens(db, chat_id).await;
    let session_limit = if limit > 0 {
        let spent_total = usage.spent.total_tokens;
        json!({
            "limit_tokens": limit,
            "spent_tokens": spent_total,
            "used_pct": percent(spent_total, limit),
            "note": "Billed tokens across the whole session against the ceiling the user set. Reaching it stops every agent in the session.",
        })
    } else {
        Value::Null
    };

    let team = if usage.agents.len() > 1 {
        Some(json!({
            "agents": usage.agents.iter().map(|a| json!({
                "chat_id": a.chat_id,
                "title": a.title,
                "zone": a.zone_name,
                "is_this_chat": a.is_current,
                "depth": a.depth,
                "model": a.model,
                "messages": a.messages,
                "context_tokens_est": a.total_tokens,
                "baseline_tokens_est": a.overhead_tokens,
                "spent": spent_json(&a.spent),
            })).collect::<Vec<_>>(),
            "context_tokens_est": usage.total_tokens,
            "spent": spent_json(&usage.spent),
            "note": "Each agent carries its own system prompt and tool schemas, and pays them on every step of its own turns.",
        }))
    } else {
        None
    };

    let mut out = json!({
        "rendered": "read_context",
        "model": model,
        "context_window": window.as_ref().map(|w| json!({
            "tokens": w.tokens,
            "source": w.source,
            "used_pct": percent(next_request, w.tokens),
        })),
        "next_request": {
            "total_tokens_est": next_request,
            "system_prompt": {
                "tokens_est": me.system_tokens,
                "parts": me.overhead_parts.iter().map(|p| json!({ "label": p.label, "tokens_est": p.tokens })).collect::<Vec<_>>(),
            },
            "tool_schemas": {
                "tokens_est": me.tools_tokens,
                "count": me.tool_count,
                "by_tool": tool_schemas,
            },
            "conversation": {
                "tokens_est": conv.input_tokens + conv.output_tokens,
                "input_tokens_est": conv.input_tokens,
                "output_tokens_est": conv.output_tokens,
                "messages": conv.messages,
                "compacted": conv.compacted,
            },
            "last_request_measured_input_tokens": if spent.last_input_tokens > 0 { Some(spent.last_input_tokens) } else { None },
        },
        "spent_this_chat": {
            "requests": spent.requests,
            "measured": spend_is_measured,
            "reported_requests": spent.reported_requests,
            "input_tokens": spent.input_tokens,
            "cached_input_tokens": spent.cached_input_tokens,
            "cache_hit_pct": cache_hit_pct,
            "output_tokens": spent.output_tokens,
            "total_tokens": spent.total_tokens,
        },
        "session_limit": session_limit,
        "team": team,
        "notes": [
            "Sizes marked _est are estimated from text length at ~4 characters per token; the provider's tokenizer will differ by some percent.",
            "Spend is what the provider was actually sent and returned, summed over every request. A turn with N tool-call steps sends the whole context N times.",
            "The tool schemas and system prompt are re-sent on every request and are the fixed cost of this zone; the conversation grows with the chat.",
        ],
    });

    if want_largest > 0 {
        out["largest_messages"] = Value::Array(conv.largest);
    }

    Ok(out.to_string())
}

/// `(a / b) * 100`, rounded, for a JSON readout. 0 when `b` is 0.
fn percent(a: i64, b: i64) -> i64 {
    if b <= 0 {
        0
    } else {
        ((a as f64 / b as f64) * 100.0).round() as i64
    }
}

fn spent_json(s: &crate::commands::usage::SpentUsage) -> Value {
    json!({
        "requests": s.requests,
        "input_tokens": s.input_tokens,
        "cached_input_tokens": s.cached_input_tokens,
        "output_tokens": s.output_tokens,
        "total_tokens": s.total_tokens,
    })
}

/// Each tool definition's own size, largest first — the per-tool breakdown of
/// the one figure the panel shows only as a total.
fn schema_sizes(tools_json: &str) -> Vec<Value> {
    let Ok(Value::Array(defs)) = serde_json::from_str::<Value>(tools_json) else {
        return Vec::new();
    };
    let mut rows: Vec<(String, i64)> = defs
        .iter()
        .map(|d| {
            let name = d
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            let bytes = serde_json::to_string(d).map(|s| s.chars().count()).unwrap_or(0) as i64;
            (name, estimate_tokens(bytes))
        })
        .collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    rows.into_iter()
        .map(|(name, tokens)| json!({ "name": name, "tokens_est": tokens }))
        .collect()
}

struct Conversation {
    input_tokens: i64,
    output_tokens: i64,
    messages: i64,
    compacted: Value,
    largest: Vec<Value>,
}

/// The conversation half, message by message, with compaction applied the way
/// the turn builder applies it: primary-conversation messages at or before the
/// cutoff are replaced by the summary, so they weigh the summary's size and are
/// listed as compacted rather than as themselves.
async fn conversation(db: &SqlitePool, chat_id: &str, want_largest: usize) -> AppResult<Conversation> {
    let rows: Vec<(String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64)> =
        sqlx::query_as(
            "SELECT id, role, content, reasoning, tool_calls, tool_call_id, zone_id, created_at
               FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC",
        )
        .bind(chat_id)
        .fetch_all(db)
        .await?;

    let prefix = crate::tools::compact::compacted_prefix(db, chat_id).await;
    let cutoff = prefix.as_ref().map(|(_, through)| *through);

    // A tool result row carries only the call id; the name is on the assistant
    // message that made the call.
    let mut call_names: HashMap<String, String> = HashMap::new();
    for (_, _, _, _, tool_calls, _, _, _) in &rows {
        let Some(tc) = tool_calls else { continue };
        if let Ok(Value::Array(calls)) = serde_json::from_str::<Value>(tc) {
            for c in calls {
                if let (Some(id), Some(name)) = (
                    c.get("id").and_then(|v| v.as_str()),
                    c.pointer("/function/name").and_then(|v| v.as_str()),
                ) {
                    call_names.insert(id.to_string(), name.to_string());
                }
            }
        }
    }

    let mut input = 0i64;
    let mut output = 0i64;
    let mut kept = 0i64;
    let mut compacted_count = 0i64;
    let mut compacted_tokens = 0i64;
    let mut sized: Vec<(i64, Value)> = Vec::new();

    for (id, role, content, reasoning, tool_calls, tool_call_id, zone_id, created_at) in &rows {
        let (chars, images) = content_chars(content);
        let is_output = role == "assistant";
        let tokens = if is_output {
            estimate_tokens(
                chars
                    + reasoning.as_deref().map_or(0, |r| r.chars().count() as i64)
                    + tool_call_chars(tool_calls.as_deref()),
            )
        } else {
            estimate_tokens(chars) + images * IMAGE_TOKEN_ESTIMATE
        };

        let compacted_away = matches!(cutoff, Some(c) if zone_id.is_none() && *created_at <= c);
        if compacted_away {
            compacted_count += 1;
            compacted_tokens += tokens;
            continue;
        }
        kept += 1;
        if is_output { output += tokens } else { input += tokens }

        if want_largest > 0 {
            let tool = match role.as_str() {
                "tool" => tool_call_id.as_ref().and_then(|c| call_names.get(c)).cloned(),
                "assistant" => tool_calls.as_deref().and_then(first_call_name),
                _ => None,
            };
            sized.push((
                tokens,
                json!({
                    "id": id,
                    "role": role,
                    "tool": tool,
                    "tokens_est": tokens,
                    "images": images,
                    "preview": preview(content),
                }),
            ));
        }
    }

    let compacted = match prefix {
        Some((summary, _)) => {
            let summary_tokens = estimate_tokens(summary.chars().count() as i64);
            input += summary_tokens;
            json!({
                "messages": compacted_count,
                "were_tokens_est": compacted_tokens,
                "summary_tokens_est": summary_tokens,
                "saved_tokens_est": compacted_tokens - summary_tokens,
            })
        }
        None => Value::Null,
    };

    sized.sort_by(|a, b| b.0.cmp(&a.0));
    let largest = sized.into_iter().take(want_largest).map(|(_, v)| v).collect();

    Ok(Conversation {
        input_tokens: input,
        output_tokens: output,
        messages: kept,
        compacted,
        largest,
    })
}

fn first_call_name(tool_calls: &str) -> Option<String> {
    serde_json::from_str::<Value>(tool_calls)
        .ok()?
        .get(0)?
        .pointer("/function/name")?
        .as_str()
        .map(str::to_string)
}

/// The first line or so of a message's text, so a size in the list can be
/// recognized without re-reading the transcript.
fn preview(content: &str) -> String {
    let text: String = match serde_json::from_str::<Value>(content) {
        Ok(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => content.to_string(),
    };
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= PREVIEW_CHARS {
        one_line
    } else {
        let cut: String = one_line.chars().take(PREVIEW_CHARS).collect();
        format!("{cut}…")
    }
}
