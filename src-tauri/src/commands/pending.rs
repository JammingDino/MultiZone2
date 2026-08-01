//! Messages the user typed while a turn was already running (0.9.12).
//!
//! Until now the composer had exactly one state while the model worked: a Stop
//! button. Anything you noticed mid-turn — a wrong direction to correct, a
//! second bug you spotted while watching the first one being fixed — you had to
//! hold in your head until the turn ended, or throw the turn away to say it.
//!
//! Both are avoidable, and they are two different asks, so there are two modes:
//!
//! * **Steer** — hand it to the model *inside* the running turn. The agentic
//!   loop drains this at the top of each step, so the note lands at the next
//!   point where the model is choosing what to do rather than interrupting a
//!   half-written sentence. Not a cancel: everything it has done so far stands.
//! * **Next** — hold it until the turn is finished, then send it as an ordinary
//!   message. This is the "queue the follow-up while I think of it" case.
//!
//! A steer the model never got to (it finished the turn first) is not dropped —
//! it falls through to the same follow-up turn a `next` message gets, which is
//! what the user meant either way. A *cancelled* turn drops the queue instead:
//! stop means stop.
//!
//! The registry is process-global, like the background-subagent one in
//! `tools::subchat`, because the GUI and the HTTP API build their own
//! `EngineCtx` and both drive the same chats.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::State;

use crate::commands::new_id;
use crate::error::AppResult;
use crate::state::AppState;

/// When a queued message should reach the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// At the running turn's next step.
    Steer,
    /// As a fresh turn once this one has finished.
    Next,
}

#[derive(Debug, Clone)]
pub struct Pending {
    pub id: String,
    pub text: String,
    pub mode: Mode,
}

static QUEUES: OnceLock<Mutex<HashMap<String, Vec<Pending>>>> = OnceLock::new();

fn queues() -> &'static Mutex<HashMap<String, Vec<Pending>>> {
    QUEUES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Add a message to a chat's queue. Returns its id.
pub fn push(chat_id: &str, id: Option<String>, text: String, mode: Mode) -> String {
    let id = id.unwrap_or_else(new_id);
    let mut map = queues().lock().unwrap();
    map.entry(chat_id.to_string())
        .or_default()
        .push(Pending { id: id.clone(), text, mode });
    id
}

/// Take the `steer` entries for a chat, in the order they were queued, leaving
/// anything marked `next` for the follow-up turn. Called once per step of the
/// agentic loop, so it must stay cheap when the queue is empty — which is
/// almost always.
pub fn take_steers(chat_id: &str) -> Vec<Pending> {
    let mut map = queues().lock().unwrap();
    let Some(list) = map.get_mut(chat_id) else {
        return Vec::new();
    };
    let mut taken = Vec::new();
    list.retain(|p| {
        if p.mode == Mode::Steer {
            taken.push(p.clone());
            false
        } else {
            true
        }
    });
    if list.is_empty() {
        map.remove(chat_id);
    }
    taken
}

/// Take everything left for a chat — the `next` messages plus any steer the
/// turn ended before reaching.
pub fn take_all(chat_id: &str) -> Vec<Pending> {
    queues().lock().unwrap().remove(chat_id).unwrap_or_default()
}

/// Drop one queued message before it is delivered (the ✕ on its chip).
pub fn remove(chat_id: &str, id: &str) -> bool {
    let mut map = queues().lock().unwrap();
    let Some(list) = map.get_mut(chat_id) else {
        return false;
    };
    let before = list.len();
    list.retain(|p| p.id != id);
    let removed = list.len() != before;
    if list.is_empty() {
        map.remove(chat_id);
    }
    removed
}

/// Queue a message for a chat whose turn is already running.
///
/// Returns the id it was queued under and whether a turn is actually in flight.
/// `running: false` means the turn ended between the user pressing send and this
/// call — the message is *not* queued, and the caller should send it normally
/// rather than leave it sitting in a queue with nothing to drain it.
#[tauri::command]
pub async fn queue_chat_message(
    state: State<'_, AppState>,
    chat_id: String,
    id: Option<String>,
    text: String,
    mode: Mode,
) -> AppResult<serde_json::Value> {
    let running = state.active_streams.read().await.contains_key(&chat_id);
    if !running {
        return Ok(serde_json::json!({ "running": false, "id": serde_json::Value::Null }));
    }
    let id = push(&chat_id, id, text, mode);
    Ok(serde_json::json!({ "running": true, "id": id }))
}

/// Drop a queued message that hasn't been delivered yet.
#[tauri::command]
pub async fn cancel_pending_message(chat_id: String, id: String) -> AppResult<bool> {
    Ok(remove(&chat_id, &id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steers_drain_first_and_next_messages_survive() {
        let chat = format!("chat-{}", new_id());
        push(&chat, Some("a".into()), "steer one".into(), Mode::Steer);
        push(&chat, Some("b".into()), "after".into(), Mode::Next);
        push(&chat, Some("c".into()), "steer two".into(), Mode::Steer);

        let steers = take_steers(&chat);
        assert_eq!(
            steers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["a", "c"],
            "steers drain in queue order"
        );
        assert!(take_steers(&chat).is_empty(), "and only once");

        let rest = take_all(&chat);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, "b");
        assert!(take_all(&chat).is_empty());
    }

    #[test]
    fn removing_the_last_entry_clears_the_chat_key() {
        let chat = format!("chat-{}", new_id());
        push(&chat, Some("x".into()), "hi".into(), Mode::Next);
        assert!(remove(&chat, "x"));
        assert!(!remove(&chat, "x"), "a second removal is a no-op");
        assert!(!queues().lock().unwrap().contains_key(&chat));
    }
}
