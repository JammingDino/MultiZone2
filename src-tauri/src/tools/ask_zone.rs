//! `ask_zone`: one zone in a multi-zone chat asks another zone in the same chat
//! directly — to look over its work, or to check an idea — without making it a
//! sub-agent.
//!
//! The asked zone answers in its own lane (`<zone id>~<consult id>`), beside
//! whatever reply of its own it may be writing, so the same zone can be busy
//! twice at once. Its answer is saved in the chat like any other reply and is
//! also handed back to the asker as the tool result. A zone that is answering
//! is not offered the tool itself, so zones cannot ask each other in circles.
//!
//! The app setting `zoneAsk` decides how: `concurrent` (default) answers at
//! once; `wait` lets the asked zone finish its own reply first; `off` withholds
//! the tool.

use crate::commands::messages::{run_consult, EngineCtx, StreamSink};
use crate::commands::new_id;
use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// `chat::zone` keys: zones writing their own reply, and zones blocked on an ask.
static BUSY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static WAITING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn set(s: &'static OnceLock<Mutex<HashSet<String>>>) -> &'static Mutex<HashSet<String>> {
    s.get_or_init(Default::default)
}

/// Holds a key in one of the sets for as long as it lives.
pub struct Mark(&'static OnceLock<Mutex<HashSet<String>>>, String);

impl Drop for Mark {
    fn drop(&mut self) {
        set(self.0).lock().unwrap().remove(&self.1);
    }
}

fn mark(s: &'static OnceLock<Mutex<HashSet<String>>>, chat_id: &str, zone_id: &str) -> Mark {
    let key = format!("{chat_id}::{zone_id}");
    set(s).lock().unwrap().insert(key.clone());
    Mark(s, key)
}

fn marked(s: &'static OnceLock<Mutex<HashSet<String>>>, chat_id: &str, zone_id: &str) -> bool {
    set(s).lock().unwrap().contains(&format!("{chat_id}::{zone_id}"))
}

/// Marks a zone as writing its own reply in this chat, for `wait` mode.
pub fn busy(chat_id: &str, zone_id: &str) -> Mark {
    mark(&BUSY, chat_id, zone_id)
}

/// `concurrent` | `wait` | `off`, from the app settings.
async fn mode(db: &SqlitePool) -> String {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'app_settings'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("zoneAsk")?.as_str().map(String::from))
        .filter(|m| m == "wait" || m == "off")
        .unwrap_or_else(|| "concurrent".into())
}

/// The chat's zones other than `self_zone_id`: its own zone and every one
/// added to it, as `(id, name)`.
async fn others(db: &SqlitePool, chat_id: &str, self_zone_id: &str) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT z.id, z.name FROM zones z
          WHERE z.id != ?2
            AND (z.id = (SELECT zone_id FROM chats WHERE id = ?1)
                 OR z.id IN (SELECT zone_id FROM chat_zones WHERE chat_id = ?1))
          ORDER BY z.name",
    )
    .bind(chat_id)
    .bind(self_zone_id)
    .fetch_all(db)
    .await
    .unwrap_or_default()
}

/// The tool, when this zone has anyone to ask and asking is switched on.
pub async fn offer(db: &SqlitePool, chat_id: &str, self_zone_id: &str) -> Option<Tool> {
    let names: Vec<String> = others(db, chat_id, self_zone_id).await.into_iter().map(|(_, n)| n).collect();
    if names.is_empty() || mode(db).await == "off" {
        return None;
    }
    Some(Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "ask_zone".into(),
            description: "Ask another zone in this chat directly and wait for its answer — \
                          to have it look over what you are doing, or to check an idea with \
                          it. Its answer appears in the chat and comes back to you here. It \
                          sees the chat, not your tool calls, so put what it needs in the \
                          message."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "zone": { "type": "string", "enum": names },
                    "message": { "type": "string", "description": "What you are asking." }
                },
                "required": ["zone", "message"]
            }),
        },
    })
}

pub async fn run(
    args: &Value,
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    asker_zone_id: Option<&str>,
) -> AppResult<String> {
    let err = |e: String| Ok(json!({ "error": e }).to_string());
    let Some(asker) = asker_zone_id else { return err("no zone to ask from".into()) };
    let mode = mode(&ctx.db).await;
    if mode == "off" {
        return err("Asking other zones is switched off in settings.".into());
    }
    let wanted = args.get("zone").and_then(Value::as_str).unwrap_or("").trim();
    let Some(question) = args.get("message").and_then(Value::as_str).filter(|m| !m.trim().is_empty())
    else {
        return err("`message` is required".into());
    };
    let others = others(&ctx.db, chat_id, asker).await;
    let Some((target, target_name)) = others
        .iter()
        .find(|(id, name)| name.eq_ignore_ascii_case(wanted) || id == wanted)
        .cloned()
    else {
        let names: Vec<&str> = others.iter().map(|(_, n)| n.as_str()).collect();
        return err(format!("No zone \"{wanted}\" in this chat. You can ask: {}", names.join(", ")));
    };
    let asker_name: String = sqlx::query_scalar("SELECT name FROM zones WHERE id = ?1")
        .bind(asker)
        .fetch_optional(&ctx.db)
        .await?
        .unwrap_or_else(|| "Another zone".into());

    let cancel = ctx
        .active_streams
        .read()
        .await
        .get(chat_id)
        .cloned()
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));

    // `wait`: let the asked zone finish its own reply first — unless it is
    // itself waiting on an ask, which is how two zones asking each other would
    // otherwise wait forever.
    let _waiting = mark(&WAITING, chat_id, asker);
    if mode == "wait" {
        // ponytail: polls every 250ms; a Notify per zone if that ever shows up.
        while marked(&BUSY, chat_id, &target)
            && !marked(&WAITING, chat_id, &target)
            && !cancel.load(Ordering::Relaxed)
        {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    let consult_id = format!("{asker}.{}", new_id());
    let note = format!(
        "{asker_name} is asking you directly, in the middle of its own reply:\n\n{question}\n\n\
         Answer {asker_name}. Your answer is shown in the chat and handed back to it."
    );
    run_consult(ctx, sink, chat_id, &target, &consult_id, note, cancel).await?;

    let texts: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM messages WHERE chat_id = ?1 AND consult_id = ?2 AND role = 'assistant'
          ORDER BY created_at ASC",
    )
    .bind(chat_id)
    .bind(&consult_id)
    .fetch_all(&ctx.db)
    .await?;
    let reply = texts
        .iter()
        .map(|c| crate::llm::thinking::strip_thinking_blocks(&crate::commands::messages::assistant_text(c)))
        .filter(|t| !t.trim().is_empty())
        .last();
    Ok(match reply {
        Some(r) => json!({ "zone": target_name, "reply": r }).to_string(),
        None => json!({ "zone": target_name, "error": format!("{target_name} gave no answer.") }).to_string(),
    })
}
