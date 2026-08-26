//! `GET /api/events` — the app's own event bus, as SSE (0.17.1).
//!
//! The frontend has exactly one seam: every backend call goes through
//! `src/lib/tauri.ts`, which is `invoke` for commands and `listen` for events.
//! 0.11.0 gave the first half a route for everything. The second half had
//! nothing — the only SSE on the surface was the one
//! `POST /api/chats/:id/messages` opens for its own turn, which streams *that*
//! turn and ends with it.
//!
//! That is enough to write a chat client and not enough to run the real app
//! remotely. A window that never hears `chats-changed` shows a stale sidebar
//! after a sub-agent spawns; one that never hears `settings-updated` overwrites
//! a preference changed elsewhere. Those are exactly the bugs the desktop does
//! not have *because* it listens.
//!
//! So: one long-lived stream carrying every event the window would have
//! received, named, with its payload. Two rules shape it.
//!
//! - **Bridge, don't reimplement.** Each event is forwarded from the same
//!   `app.listen` the window uses, so there is no second place that decides
//!   what an event means, and an emitter that gains a field gains it here too.
//! - **The list is explicit.** Tauri has no "every event" subscription and
//!   should not: `pdf-read-request` asks the *window* to do work and answers
//!   through a command, so forwarding it to a phone would hand the request to
//!   something that cannot serve it.

use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
};
use futures_util::StreamExt;
use serde_json::json;
use std::convert::Infallible;
use tauri::{AppHandle, Listener};
use tokio::sync::broadcast;

use super::ApiState;

/// The events a remote window needs to behave like a local one.
///
/// Deliberately a list rather than a wildcard. Everything here is a *fact about
/// the app* that a second window should know; what is left out is anything that
/// asks the window to do something only a window can do.
pub const FORWARDED: &[&str] = &[
    // The turn itself: tokens, tool calls, approval prompts.
    "stream",
    // The sidebar and the chat header.
    "chats-changed",
    "chat-title-updated",
    "chat-tags-updated",
    "chat-zone-updated",
    "chat-file-synced",
    "memory-updated",
    "knowledge-updated",
    // Preferences changed by another window, a script, or a model.
    "settings-updated",
    // Any write that went through the API, by route — what the window reads to
    // decide what to re-fetch.
    "app-data-changed",
    // A device paired or was revoked.
    "devices-changed",
];

/// How many events a slow client may fall behind before it is told it has.
///
/// A streaming turn emits fast, so this is generous — but bounded, because the
/// alternative to dropping is holding every token of a long run in memory for a
/// phone that went into a tunnel. A lagging receiver is told, and the client
/// re-fetches rather than silently missing a chat.
const CHANNEL_CAPACITY: usize = 1024;

/// One forwarded event.
#[derive(Clone, Debug)]
pub struct BusEvent {
    pub name: &'static str,
    /// The payload as the emitter sent it, still JSON text.
    pub payload: String,
}

/// The broadcast side of the bridge, plus the Tauri listeners feeding it.
///
/// Held by the running server: dropping it unregisters every listener, so a
/// server that has been switched off is not still doing work on every token of
/// every turn.
pub struct EventBridge {
    tx: broadcast::Sender<BusEvent>,
    app: AppHandle,
    handlers: Vec<tauri::EventId>,
}

impl EventBridge {
    pub fn start(app: AppHandle) -> Self {
        let (tx, _rx) = broadcast::channel(CHANNEL_CAPACITY);
        let mut handlers = Vec::with_capacity(FORWARDED.len());

        for name in FORWARDED {
            let tx = tx.clone();
            let name = *name;
            handlers.push(app.listen(name, move |event| {
                // `send` fails only when nobody is subscribed, which is the
                // common case — no remote client is connected. Not an error.
                let _ = tx.send(BusEvent { name, payload: event.payload().to_string() });
            }));
        }

        EventBridge { tx, app, handlers }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BusEvent> {
        self.tx.subscribe()
    }
}

impl Drop for EventBridge {
    fn drop(&mut self) {
        for id in self.handlers.drain(..) {
            self.app.unlisten(id);
        }
    }
}

/// Subscribe to everything the window hears.
///
/// The keep-alive is not optional here. This stream is silent whenever nobody
/// is using the app, which is most of the time, and a silent socket is what a
/// home router reaps after a few minutes — so a phone left on a chat screen
/// would go quiet with no error and no reconnect.
pub async fn events(State(st): State<ApiState>) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let mut rx = st.events.subscribe();

    let stream = async_stream::stream! {
        // Named `ready` rather than left to the first real event: a client needs
        // to know the subscription is live before it starts fetching, or it
        // races its own initial load against the events it just missed.
        yield Ok(Event::default().event("ready").data(json!({ "events": FORWARDED }).to_string()));

        loop {
            match rx.recv().await {
                Ok(ev) => {
                    yield Ok(Event::default().event(ev.name).data(ev.payload));
                }
                // The client fell behind. Say so, rather than resuming mid-gap
                // and letting it believe it saw everything.
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    yield Ok(Event::default()
                        .event("lagged")
                        .data(json!({ "missed": missed }).to_string()));
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Sse::new(stream.boxed()).keep_alive(KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window asks the *window* to read a PDF and answers through a
    /// command. Forwarding it to a phone would hand the job to something that
    /// cannot do it, and the desktop would wait for an answer that never comes.
    #[test]
    fn window_only_requests_are_not_forwarded() {
        assert!(!FORWARDED.contains(&"pdf-read-request"));
    }

    #[test]
    fn the_forwarded_list_has_no_duplicates() {
        let mut sorted = FORWARDED.to_vec();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(before, sorted.len(), "a duplicate would deliver an event twice");
    }

    /// The turn itself is the one that must never be left out — it is the whole
    /// reason a remote window is worth having.
    #[test]
    fn the_stream_event_is_forwarded() {
        assert!(FORWARDED.contains(&"stream"));
    }
}
