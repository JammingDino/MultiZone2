//! `schedule_run` and friends (0.18) — an agent putting work on the clock.
//!
//! Dangerous by classification: a scheduled run is a turn that starts later
//! with nobody having typed it, with whatever tools its zone has. The user
//! approves each one, and every run is listed (and deletable) in Settings →
//! Schedules. See `crate::schedule` for how runs fire.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use crate::schedule::{self, ScheduleInput};
use chrono::{Local, NaiveDateTime, TimeZone};
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub fn definitions() -> Vec<Tool> {
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "schedule_run".into(),
                description: "Schedule a prompt to run later, once by default or on a repeat: \
                              a reminder to yourself in this chat, a daily sweep in a fresh chat, \
                              a progress report on this chat's work. The user can see and delete \
                              every scheduled run."
                    .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "description": "What the run is asked to do, written for whoever reads it then." },
                        "name": { "type": "string", "description": "Short label." },
                        "at": { "type": "string", "description": "Local time, YYYY-MM-DD HH:MM. For a one-time run; or give in_minutes." },
                        "in_minutes": { "type": "integer" },
                        "repeat": { "type": "string", "enum": ["none", "every", "daily", "weekly"], "default": "none" },
                        "every_minutes": { "type": "integer", "description": "For repeat=every." },
                        "time": { "type": "string", "description": "HH:MM, for daily or weekly." },
                        "weekdays": { "type": "array", "items": { "type": "integer" }, "description": "For weekly: 0=Sunday … 6=Saturday." },
                        "target": { "type": "string", "enum": ["this_chat", "new_chat"], "default": "this_chat", "description": "Append to this chat, or start a new chat each time." },
                        "watch_this_chat": { "type": "boolean", "description": "new_chat only: give each run the latest of this chat, for progress reports." }
                    },
                    "required": ["prompt"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "list_scheduled_runs".into(),
                description: "Every scheduled run, with its id and next time.".into(),
                parameters: json!({ "type": "object", "properties": {} }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "cancel_scheduled_run".into(),
                description: "Delete a scheduled run by id.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": { "id": { "type": "string" } },
                    "required": ["id"]
                }),
            },
        },
    ]
}

fn err(m: impl Into<String>) -> String {
    json!({ "error": m.into() }).to_string()
}

/// A local wall-clock time as the model writes it.
fn parse_local(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(t.timestamp_millis());
    }
    ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"]
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(s, f).ok())
        .and_then(|n| Local.from_local_datetime(&n).earliest())
        .map(|t| t.timestamp_millis())
}

pub async fn schedule(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    caller_zone_id: Option<&str>,
) -> AppResult<String> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    let Some(prompt) = s("prompt").filter(|p| !p.trim().is_empty()) else {
        return Ok(err("schedule_run needs a prompt"));
    };
    let run_at = match (s("at"), args.get("in_minutes").and_then(Value::as_i64)) {
        (Some(at), _) => match parse_local(&at) {
            Some(t) => Some(t),
            None => return Ok(err(format!("Could not read the time '{at}'; use YYYY-MM-DD HH:MM."))),
        },
        (None, Some(m)) => Some(crate::commands::now_ts() + m.max(0) * 60_000),
        (None, None) => None,
    };
    let repeat = match s("repeat").as_deref().unwrap_or("none") {
        "none" | "once" => "once",
        "every" | "interval" => "interval",
        "daily" => "daily",
        "weekly" => "weekly",
        other => return Ok(err(format!("Unknown repeat '{other}'."))),
    };
    let new_chat = s("target").as_deref() == Some("new_chat");
    let project_id: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT project_id FROM chats WHERE id = ?1")
            .bind(chat_id)
            .fetch_optional(db)
            .await?
            .flatten();
    let input = ScheduleInput {
        name: s("name").unwrap_or_default(),
        prompt,
        target: Some(if new_chat { "new_chat" } else { "chat" }.into()),
        chat_id: (!new_chat).then(|| chat_id.to_string()),
        // A new chat is answered by the zone that scheduled it.
        zone_id: caller_zone_id.filter(|z| !z.starts_with("__")).map(str::to_string),
        project_id,
        watch_chat_id: (new_chat && args.get("watch_this_chat").and_then(Value::as_bool) == Some(true))
            .then(|| chat_id.to_string()),
        repeat: Some(repeat.into()),
        interval_minutes: args.get("every_minutes").and_then(Value::as_i64),
        time_of_day: s("time"),
        weekdays: args.get("weekdays").and_then(|v| serde_json::from_value(v.clone()).ok()),
        run_at,
        created_by_chat_id: Some(chat_id.to_string()),
        ..Default::default()
    };
    match schedule::upsert(db, input).await {
        Ok(run) => Ok(json!({
            "ok": true,
            "id": run.id,
            "name": run.name,
            "next_run": run.next_run_at.and_then(|t| Local.timestamp_millis_opt(t).single())
                .map(|t| t.format("%Y-%m-%d %H:%M (%A)").to_string()),
            "repeat": run.repeat,
        })
        .to_string()),
        Err(e) => Ok(err(e.to_string())),
    }
}

pub async fn list(db: &SqlitePool) -> AppResult<String> {
    let runs = schedule::list(db).await?;
    let rows: Vec<Value> = runs
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "name": r.name,
                "repeat": r.repeat,
                "enabled": r.enabled,
                "next_run": r.next_run_at.and_then(|t| Local.timestamp_millis_opt(t).single())
                    .map(|t| t.format("%Y-%m-%d %H:%M").to_string()),
                "prompt": r.prompt.chars().take(200).collect::<String>(),
            })
        })
        .collect();
    Ok(json!({ "runs": rows }).to_string())
}

pub async fn cancel(args: &Value, db: &SqlitePool) -> AppResult<String> {
    let id = args.get("id").and_then(Value::as_str).unwrap_or("");
    Ok(if schedule::delete(db, id).await? {
        json!({ "ok": true }).to_string()
    } else {
        err(format!("No scheduled run with id '{id}'."))
    })
}
