use crate::commands::{new_id, now_ts};
use crate::db::models::{Chat, Message, Provider, Zone};
use sqlx::SqlitePool;
use crate::error::{AppError, AppResult};
use crate::llm::client::LlmClient;
use crate::llm::streaming::{consume_stream, StreamEvent};
use crate::llm::types::{
    ChatMessage, ChatRequest, ContentPart, ImageUrl, MessageContent, Tool, ToolCall,
};
use crate::state::AppState;
use crate::llm::continuity::{self, Stall};
use crate::llm::thinking::strip_thinking_blocks;
use crate::tools::{self, ThemePalette, ToolContext, ToolId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, RwLock};

/// Per-turn tool-step budget, from the user's `maxToolSteps` setting. Falls back
/// to the default when unset, and is clamped to the supported range either way.
async fn max_tool_steps(db: &SqlitePool) -> usize {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .flatten();
    let configured = raw
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("maxToolSteps").and_then(|n| n.as_u64()))
        .map(|n| n as usize)
        .unwrap_or(continuity::DEFAULT_MAX_STEPS);
    continuity::clamp_steps(configured)
}

/// Whether a project's own `AGENTS.md` / `CLAUDE.md` is read into the system
/// prompt (0.14.5). On unless the user says otherwise: a file written to tell
/// an agent how to work in this repository is the cheapest context there is,
/// and an install that has never opened the setting should get it.
async fn project_instructions_enabled(db: &SqlitePool) -> bool {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("projectInstructions").and_then(Value::as_bool))
        .unwrap_or(true)
}

/// Tokens of repository map injected at session start (0.14.5). `0` is off.
async fn repo_map_tokens(db: &SqlitePool) -> usize {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("repoMapTokens").and_then(Value::as_u64))
        .map(|n| n as usize)
        .unwrap_or(crate::repomap::DEFAULT_TOKEN_BUDGET)
        // A map is a map. Past a few thousand tokens it stops being one and
        // becomes an inventory competing with the conversation for room.
        .min(8_000)
}

/// The spend ceiling for this chat's session, in billed tokens. `0` means none.
///
/// **This session's own limit first, the global setting as the default**
/// (0.14.4). Raising the ceiling from the card in one chat used to raise it
/// everywhere, which is the opposite of what lifting a limit to let *this*
/// piece of work finish is supposed to mean.
///
/// Resolved against the session root, since spend is counted across a chat and
/// every sub-agent under it — a sub-agent with a ceiling of its own would be a
/// limit inside a limit, and whichever was smaller would silently win.
///
/// Off by default, deliberately. This is a local-first app where the usual case
/// is a model on the same machine, where a long session costs nothing but time;
/// a cap that stops legitimate work by default would be the wrong trade for the
/// people running Ollama. It exists for the case where tokens are money and a
/// seven-member panel is spending it unattended, and the number belongs to
/// whoever is paying. Loop detection, which is on for everyone, is what catches
/// the runaway *shape*.
pub(crate) async fn max_session_tokens(db: &SqlitePool, chat_id: &str) -> i64 {
    // `Some(0)` is a real answer — "this session runs unmetered" — so it has to
    // beat the global default rather than read as unset.
    if let Ok(root) = crate::tools::teamwork::session_root(db, chat_id).await {
        let own: Option<Option<i64>> =
            sqlx::query_scalar("SELECT spend_limit FROM chats WHERE id = ?1")
                .bind(&root)
                .fetch_optional(db)
                .await
                .ok()
                .flatten();
        if let Some(limit) = own.flatten() {
            return limit.max(0);
        }
    }

    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("maxSessionTokens").and_then(|n| n.as_i64()))
        .filter(|n| *n > 0)
        .unwrap_or(0)
}

/// Set (or clear, with `None`) a session's own spend limit (0.14.4).
///
/// Always written to the session root: raising the limit from inside a
/// sub-agent's chat is still a statement about the whole session, which is the
/// thing being measured.
#[tauri::command]
pub async fn set_chat_spend_limit(
    state: State<'_, AppState>,
    chat_id: String,
    limit: Option<i64>,
) -> AppResult<()> {
    let root = crate::tools::teamwork::session_root(&state.db, &chat_id).await?;
    sqlx::query("UPDATE chats SET spend_limit = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(limit.map(|n| n.max(0)))
        .bind(now_ts())
        .bind(&root)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// One-shot overrides for a single send, chosen from the input bar's advanced
/// menu. They affect only the turn they're passed to — the chat's stored zone
/// is never modified.
#[derive(Clone, Default)]
pub struct TurnOverride {
    /// Zone to answer as for this turn. `Some(SIMPLE_ZONE_ID)` forces a Quick
    /// (no-zone) turn even when the chat has a zone bound. `None` = use the
    /// chat's own zone.
    pub zone_id: Option<String>,
    /// Model to use for this turn, overriding the resolved zone's model.
    pub model: Option<String>,
    /// True when another *agent* drove this turn rather than a person — a leader
    /// spawning or messaging a sub-agent.
    ///
    /// It decides whether `ask_user` survives in a subchat. A sub-agent a leader
    /// is driving has nobody to ask: its question would render in a chat nobody
    /// is looking at and the turn would wait forever, which is why the tool is
    /// stripped. When the *user* sends into that same subchat directly (0.9.11),
    /// they are by definition right there, and taking the question away just
    /// makes the sub-agent guess at something it could have asked.
    ///
    /// Defaults to false, so the seam is opt-in: the subchat tools set it, and
    /// every user-facing path gets the honest answer by doing nothing.
    pub agent_driven: bool,
}

impl TurnOverride {
    fn is_active(&self) -> bool {
        self.zone_id.is_some() || self.model.is_some()
    }
}

use crate::db::models::ZONE_COLS;
// One list, shared with `commands::chats`. It used to be duplicated here, and a
// column added to `Chat` was only added to the other copy — every `send_message`
// then failed to decode a Chat row and the send silently did nothing.
use crate::commands::chats::CHAT_COLS;
const MSG_COLS: &str =
    "id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, edited, created_at";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputPart {
    Text { text: String },
    Image { data_url: String },
    /// Text sent to the model but hidden from the chat UI.
    HiddenText { text: String },
    /// Image sent to the model but hidden from the chat UI.
    HiddenImage { data_url: String },
}

/// One event of a streamed turn, as the frontend receives it.
///
/// `rename_all_fields` was missing until 0.14.3, and the container-level
/// `rename_all` only renames *variants* — so `message_id` and `zone_id` went
/// out as snake_case while [types.ts](../../../src/lib/types.ts) declared, and
/// every reader used, `messageId` and `zoneName`. Those reads were quietly
/// `undefined`: the routing chip named no zone, and the streaming state carried
/// no message id. Nothing threw, which is why it survived — a wrong field name
/// across this boundary is not a type error on either side of it.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StreamPayload<'a> {
    UserMessageSaved { message: &'a Message },
    AssistantStart { message_id: String },
    Token { delta: String },
    ThinkingToken { delta: String },
    ToolCallStart { index: usize, id: String, name: String },
    ToolCallArgsDelta { index: usize, delta: String },
    /// Emitted at the start of a Smart-chat routing call (before the LLM picks a zone).
    RoutingStarted,
    /// Emitted once the router has resolved a zone for this turn.
    RoutingDone { zone_id: String, zone_name: String },
    /// Emitted when a tool requires user approval before it can run.
    ///
    /// `diff` carries the change a file-writing tool proposes (0.10.2), so the
    /// prompt can show a reviewable diff instead of a wall of proposed content.
    /// `None` for every other tool, and for a proposal with nothing to show.
    ToolApprovalRequired {
        index: usize,
        name: String,
        arguments: String,
        diff: Option<crate::diffs::FileDiff>,
    },
    ToolCallExecuting { index: usize, name: String },
    ToolCallResult { index: usize, name: String, result: String },
    ToolMessageSaved { message: &'a Message },
    AssistantSaved { message: &'a Message },
    /// A message the user queued mid-turn reached the model at a step boundary
    /// (see `commands::pending`). Distinct from `UserMessageSaved` because this
    /// one lands *inside* a turn: it appends to the thread without resetting the
    /// turn's live token/timing counters, which belong to the turn already
    /// running.
    SteerDelivered { id: String, message: &'a Message },
    /// Queued messages that are no longer pending — consumed into the follow-up
    /// turn, or dropped because the turn was cancelled.
    PendingCleared { ids: Vec<String> },
    /// A send that arrived while this chat's turn was still running was held
    /// back as a queued follow-up instead (see [`run_send_entry`]). The chip
    /// the composer shows for it comes from this event, since the composer
    /// thought it was sending, not queueing.
    PendingQueued { id: String, text: String },
    Cancelled,
    /// Loop detection stopped the turn (0.14.1). The turn does not end here —
    /// one tool-free step follows so the model can report — but the reason is
    /// surfaced now, while the repeated calls are still on screen.
    Runaway { kind: &'static str, label: String },
    /// The session spend limit stopped the run (0.14.3). Unlike every other
    /// ending this one is a *decision waiting on the user*: nothing more will
    /// run, in this chat or any other in the session, until the limit is raised
    /// or turned off. The numbers travel with it so the prompt can offer a
    /// specific new limit rather than a text box.
    SpendLimit { spent: i64, cap: i64, mid_turn: bool },
    Done,
    Error { message: String },
}

/// Lightweight, cloneable bundle of everything the message engine needs from
/// the app state. Both the Tauri `State<AppState>` path and the HTTP API build
/// one of these so the same core loop drives the GUI and the API.
#[derive(Clone)]
pub struct EngineCtx {
    pub db: SqlitePool,
    pub http: reqwest::Client,
    pub active_streams: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    pub tool_approvals: ApprovalGate,
}

/// How long a tool call waits for an answer before denying itself.
///
/// Named rather than inlined because the pending queue reports a countdown
/// against it: a client showing "expires in 40s" and an engine giving up at
/// some other number would be worse than showing nothing.
pub const APPROVAL_TIMEOUT_SECS: u64 = 300;

/// The pending-approval map: approval key → the call waiting on an answer.
///
/// Named, because it is threaded through `AppState`, `EngineCtx` and the API's
/// own state, and spelling the type out in three places is how the three drift.
pub type ApprovalGate = Arc<tokio::sync::Mutex<HashMap<String, PendingApproval>>>;

/// A tool call blocked on the user, and enough about it to describe it to
/// somebody who is not standing in front of the desktop (0.17.0).
///
/// This used to be a bare `oneshot::Sender` — which is all the *desktop* needs,
/// because the dialog asking the question is the same window that will answer
/// it. From a phone the question and the answer are in different places, and a
/// run that reaches an approval with nobody at the machine simply stalls for
/// five minutes and then denies. The metadata is what makes the queue readable
/// over the API, and therefore what makes leaving a run unattended a decision
/// rather than a gamble.
pub struct PendingApproval {
    pub chat_id: String,
    /// The perspective zone this participant is, or `None` for the primary.
    pub zone_id: Option<String>,
    pub tool: String,
    /// The call's arguments as the model wrote them, JSON.
    pub arguments: String,
    /// What the call would do to a file, when that is a thing it does.
    pub diff: Option<crate::diffs::FileDiff>,
    pub requested_at: i64,
    /// Where the answer goes. Consumed by whoever answers first.
    pub responder: oneshot::Sender<ApprovalAnswer>,
}

/// One pending approval as the API and the GUI see it — the same thing without
/// the channel, which does not serialise and would not mean anything remotely.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApprovalView {
    /// The map key: the chat id, or `chatId::zoneId` for a perspective zone.
    /// Handed back so a client can answer without reconstructing the rule.
    pub key: String,
    pub chat_id: String,
    pub zone_id: Option<String>,
    pub tool: String,
    pub arguments: String,
    pub diff: Option<crate::diffs::FileDiff>,
    pub requested_at: i64,
    /// Seconds until the five-minute wait gives up and denies this call. A
    /// phone showing a queue needs to say which of these is about to expire —
    /// "denied because nobody answered" is a real outcome and reads like a bug
    /// unless the countdown was visible.
    pub expires_in_secs: i64,
}

/// What the user said when asked to approve a tool call.
///
/// `hunks` is the 0.10.2 addition: a subset of the previewed diff's hunks the
/// user is willing to take. `None` means the call runs as the model wrote it —
/// the answer every non-file tool gives, and the one "Approve" gives when the
/// user didn't narrow anything.
#[derive(Debug, Clone, Default)]
pub struct ApprovalAnswer {
    pub approved: bool,
    pub hunks: Option<Vec<usize>>,
}

impl ApprovalAnswer {
    fn denied() -> Self {
        Self { approved: false, hunks: None }
    }
}

impl EngineCtx {
    pub fn from_state(state: &AppState) -> Self {
        Self {
            db: state.db.clone(),
            http: state.http.clone(),
            active_streams: state.active_streams.clone(),
            tool_approvals: state.tool_approvals.clone(),
        }
    }
}

/// Where streamed events go. Always mirrors to the Tauri app (so a chat open in
/// the GUI updates live), and optionally fans the same JSON envelopes out to an
/// SSE channel for an HTTP API caller.
#[derive(Clone)]
pub struct StreamSink {
    app: AppHandle,
    tx: Option<mpsc::UnboundedSender<String>>,
}

impl StreamSink {
    pub fn tauri(app: AppHandle) -> Self {
        Self { app, tx: None }
    }

    pub fn api(app: AppHandle, tx: mpsc::UnboundedSender<String>) -> Self {
        Self { app, tx: Some(tx) }
    }

    fn dispatch(&self, env: Value) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(env.to_string());
        }
        let _ = self.app.emit("stream", env);
    }

    fn emit(&self, chat_id: &str, payload: StreamPayload) {
        self.dispatch(serde_json::json!({ "chatId": chat_id, "event": payload }));
    }

    fn emit_persp(&self, chat_id: &str, zone_id: &str, payload: StreamPayload) {
        self.dispatch(serde_json::json!({
            "chatId": chat_id,
            "perspectiveZoneId": zone_id,
            "event": payload,
        }));
    }

    /// Emit on the primary channel when `persp` is `None`, or on a perspective
    /// zone's channel when `Some`. Lets one code path drive both kinds of turn.
    fn emit_for(&self, chat_id: &str, persp: Option<&str>, payload: StreamPayload) {
        match persp {
            Some(z) => self.emit_persp(chat_id, z, payload),
            None => self.emit(chat_id, payload),
        }
    }

    /// The window handle behind this sink. Tools that need the frontend to do
    /// something the backend can't (rasterizing a PDF page — see `pdf_bridge`)
    /// emit their own request/response events on it.
    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    /// Side-channel app events (tag/title/zone refreshes). GUI-only; no SSE.
    fn emit_event(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }

    /// Tell an open GUI the chat list changed (e.g. a subchat was created) so
    /// the sidebar refreshes. GUI-only; no SSE.
    pub fn notify_chats_changed(&self) {
        self.emit_event("chats-changed", serde_json::json!({}));
    }
}

#[tauri::command]
pub async fn cancel_stream(state: State<'_, AppState>, chat_id: String) -> AppResult<()> {
    // Background sub-agents (0.9.10) outlive the tool call that started them, so
    // stopping the chat that spawned them has to stop them too — otherwise Stop
    // looks like it did nothing while five detached turns keep streaming tokens
    // into subchats the user can't cancel from anywhere.
    let mut targets = vec![chat_id.clone()];
    let mut frontier = vec![chat_id.clone()];
    // Bounded so a cyclic parent link can't spin here.
    for _ in 0..crate::tools::subchat::MAX_CANCEL_DEPTH {
        let mut next = Vec::new();
        for parent in frontier.drain(..) {
            next.extend(crate::tools::subchat::running_children(&parent));
        }
        if next.is_empty() {
            break;
        }
        targets.extend(next.iter().cloned());
        frontier = next;
    }

    {
        let map = state.active_streams.read().await;
        for id in &targets {
            if let Some(flag) = map.get(id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
    // Deny every pending tool approval for the cancelled chats — the primary
    // (keyed by chat id) and any perspective zones (keyed `chat_id::zone_id`) —
    // so no participant's loop is left blocked waiting on the user.
    let mut approvals = state.tool_approvals.lock().await;
    let keys: Vec<String> = approvals
        .keys()
        .filter(|k| targets.iter().any(|id| approval_key_belongs_to_chat(k, id)))
        .cloned()
        .collect();
    for k in keys {
        if let Some(pending) = approvals.remove(&k) {
            let _ = pending.responder.send(ApprovalAnswer::denied());
        }
    }
    Ok(())
}

/// Rewrite a file-writing call's arguments to only the hunks the user took.
///
/// Best-effort by design: if the proposal can no longer be computed (the file
/// moved under us between the prompt and the answer), the original arguments
/// are returned and the tool reports the problem in its own words — which is a
/// better failure than silently writing a partial file built from stale state.
async fn narrowed_arguments(
    db: &SqlitePool,
    chat_id: &str,
    name: &str,
    arguments: &str,
    project_dir: Option<&str>,
    hunks: &[usize],
) -> String {
    let args: serde_json::Value = match serde_json::from_str(arguments) {
        Ok(v) => v,
        Err(_) => return arguments.to_string(),
    };
    match crate::review::proposal(db, chat_id, name, &args, project_dir).await {
        Some(Ok(p)) => crate::review::narrow_arguments(name, &args, &p, hunks).to_string(),
        _ => arguments.to_string(),
    }
}

/// The approval-map key for a participant: the chat id for the primary, or
/// `chat_id::zone_id` for a perspective zone.
fn approval_key(chat_id: &str, persp_zone_id: Option<&str>) -> String {
    match persp_zone_id {
        Some(z) => format!("{chat_id}::{z}"),
        None => chat_id.to_string(),
    }
}

/// True when an approval key targets the given chat (primary or any of its
/// perspective zones).
fn approval_key_belongs_to_chat(key: &str, chat_id: &str) -> bool {
    key == chat_id || key.starts_with(&format!("{chat_id}::"))
}

/// Called by the frontend to approve or deny a pending tool execution. A
/// `zone_id` targets a specific perspective zone's pending approval; `None`
/// targets the primary turn.
#[tauri::command]
/// `hunks` (0.10.2) approves only part of a previewed file change: the call
/// still runs, with its arguments rewritten to exactly the content the user
/// agreed to. Omitted, the call runs as the model wrote it.
pub async fn respond_tool_approval(
    state: State<'_, AppState>,
    chat_id: String,
    zone_id: Option<String>,
    approved: bool,
    hunks: Option<Vec<usize>>,
) -> AppResult<()> {
    let key = approval_key(&chat_id, zone_id.as_deref());
    let mut map = state.tool_approvals.lock().await;
    if let Some(pending) = map.remove(&key) {
        let _ = pending.responder.send(ApprovalAnswer { approved, hunks });
    }
    Ok(())
}

/// Every tool call currently blocked on the user, newest request last.
///
/// The queue exists so a run can be left alone: a phone (or a second window, or
/// a script) can see what is waiting and answer it, instead of the run stalling
/// for five minutes at a dialog nobody is standing in front of and then denying
/// itself. Per-category auto-approval (0.14.2) decides what reaches this queue
/// at all; this decides whether reaching it is the end of the run.
#[tauri::command]
pub async fn pending_approvals(
    state: State<'_, AppState>,
) -> AppResult<Vec<PendingApprovalView>> {
    let map = state.tool_approvals.lock().await;
    let now = now_ts();
    let mut out: Vec<PendingApprovalView> = map
        .iter()
        .map(|(key, p)| PendingApprovalView {
            key: key.clone(),
            chat_id: p.chat_id.clone(),
            zone_id: p.zone_id.clone(),
            tool: p.tool.clone(),
            arguments: p.arguments.clone(),
            diff: p.diff.clone(),
            requested_at: p.requested_at,
            expires_in_secs: ((p.requested_at + APPROVAL_TIMEOUT_SECS as i64 * 1000 - now) / 1000).max(0),
        })
        .collect();
    out.sort_by_key(|v| v.requested_at);
    Ok(out)
}

/// Replace a message's text content in place and flag it as user-edited.
/// Used by "edit AI response": the new text becomes the message's sole text
/// part, `edited` is set so the UI can show the marker, and the chat's
/// `updated_at` bumps. Returns the updated message. History/order is untouched,
/// so a later branch from this message copies the edited content verbatim.
#[tauri::command]
pub async fn update_message(
    state: State<'_, AppState>,
    chat_id: String,
    message_id: String,
    text: String,
) -> AppResult<Message> {
    // Confirm the message belongs to this chat before mutating it.
    sqlx::query_scalar::<_, String>("SELECT id FROM messages WHERE id = ?1 AND chat_id = ?2")
        .bind(&message_id)
        .bind(&chat_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("message {message_id}")))?;

    let content_json = serde_json::to_string(&vec![ContentPart::Text { text }])?;
    let now = now_ts();
    sqlx::query("UPDATE messages SET content = ?1, edited = 1 WHERE id = ?2")
        .bind(&content_json)
        .bind(&message_id)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
        .bind(now)
        .bind(&chat_id)
        .execute(&state.db)
        .await?;

    let updated = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
    ))
    .bind(&message_id)
    .fetch_one(&state.db)
    .await?;
    // Edited content changes the mirrored file (0.7.2).
    crate::commands::mirror::mirror_chat_best_effort(&state.db, &chat_id).await;
    Ok(updated)
}

/// Read the OCR language hint from persisted app_settings (0.4.0). Defaults to
/// "eng". Passed to the OCR engine when falling back for vision-incapable models.
async fn ocr_language(db: &SqlitePool) -> String {
    let raw: Option<Option<String>> = sqlx::query_scalar(
        "SELECT value FROM settings WHERE key = 'app_settings'",
    )
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    raw.flatten()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("ocrLanguage").and_then(|v| v.as_str()).map(String::from))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "eng".to_string())
}

/// Layer the settings a tool needs but a zone doesn't store onto a zone's own
/// `tool_config`, so every zone reaches the tools with the same global state.
///
/// Re-applied on a zone switch, because both entries depend on which zone (and
/// so which model) is now answering.
async fn inject_global_tool_config(zone_config: &mut Value, db: &SqlitePool, model: &str) {
    // A PDF read returns page images by default, which is only useful to a model
    // that can see them. For a vision-incapable one the tool extracts text
    // instead — the same call attachments make, and for the same reason:
    // extracting a PDF's own text beats OCR'ing a picture of the page.
    let vision_capable = model_vision_capable(db, model).await;
    let Some(obj) = zone_config.as_object_mut() else { return };
    obj.insert("vision_capable".to_string(), Value::Bool(vision_capable));
    // The language an image read falls back to OCR in, for the same zones.
    if !vision_capable {
        obj.insert("ocr_language".to_string(), Value::String(ocr_language(db).await));
    }
}

/// Can this model accept image input? The user's manual `visionOverrides` entry
/// beats the name heuristic in both directions. One helper because the answer
/// decides three separate things — whether images survive into the history,
/// whether a PDF comes back as pages or text, and whether the tools even offer
/// the model an image (see [`crate::tools::ToolContext::vision_capable`]) — and
/// they must not disagree.
pub(crate) async fn model_vision_capable(db: &SqlitePool, model: &str) -> bool {
    match vision_override(db, model).await.as_deref() {
        Some("on") => true,
        Some("off") => false,
        _ => crate::ocr::is_vision_capable(model),
    }
}

/// Look up the user's manual vision override for a model, from the
/// `visionOverrides` map in app settings: `Some("on")` = always send images,
/// `Some("off")` = always OCR to text, `None` = auto (use the name heuristic).
pub(crate) async fn vision_override(db: &SqlitePool, model: &str) -> Option<String> {
    let raw: Option<Option<String>> = sqlx::query_scalar(
        "SELECT value FROM settings WHERE key = 'app_settings'",
    )
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    raw.flatten()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("visionOverrides")?
                .get(model)?
                .as_str()
                .map(String::from)
        })
        .filter(|s| s == "on" || s == "off")
}

/// Run the agentic loop against the chat's existing history without inserting
/// a new user message. Used by "regenerate" after we've trimmed previous responses.
#[tauri::command]
pub async fn regenerate_response(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<()> {
    let ctx = EngineCtx::from_state(&state);
    let sink = StreamSink::tauri(app);
    run_regenerate_entry(&ctx, &sink, &chat_id).await
}

/// Shared entry point for "regenerate" used by both the Tauri command and the
/// HTTP API: registers a cancel flag, runs the loop + perspectives, cleans up.
pub async fn run_regenerate_entry(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
) -> AppResult<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    ctx.active_streams
        .write()
        .await
        .insert(chat_id.to_string(), cancel.clone());

    let result = run_regenerate(ctx, sink, chat_id, cancel.clone()).await;

    ctx.active_streams.write().await.remove(chat_id);

    if let Err(e) = &result {
        sink.emit(chat_id, StreamPayload::Error { message: e.to_string() });
    }
    flush_pending_after(ctx, sink, chat_id, cancel.load(Ordering::Relaxed)).await;
    result
}

async fn run_regenerate(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    run_turn(ctx, sink, chat_id, &TurnOverride::default(), cancel).await;
    Ok(())
}

/// Re-runs a single participant for the latest round — the primary
/// (`zone_id = None`) or one perspective zone (`Some(z)`) — leaving every other
/// participant's answer untouched. The caller deletes that participant's old
/// messages first (via `delete_participant_messages`).
#[tauri::command]
pub async fn regenerate_participant(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    zone_id: Option<String>,
) -> AppResult<()> {
    let ctx = EngineCtx::from_state(&state);
    let sink = StreamSink::tauri(app);
    run_regenerate_participant_entry(&ctx, &sink, &chat_id, zone_id).await
}

/// Shared entry for per-participant regenerate (Tauri + HTTP API): registers a
/// cancel flag, runs just the one participant, cleans up.
pub async fn run_regenerate_participant_entry(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    zone_id: Option<String>,
) -> AppResult<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    ctx.active_streams
        .write()
        .await
        .insert(chat_id.to_string(), cancel.clone());

    let result = match &zone_id {
        Some(z) => run_perspective(ctx, sink, chat_id, z, cancel.clone()).await,
        None => run_agentic_loop(ctx, sink, chat_id, &TurnOverride::default(), cancel.clone()).await,
    };

    ctx.active_streams.write().await.remove(chat_id);

    if let Err(e) = &result {
        sink.emit_for(chat_id, zone_id.as_deref(), StreamPayload::Error { message: e.to_string() });
    }
    // This path bypasses run_turn, so mirror here too (0.7.2).
    crate::commands::mirror::mirror_chat_best_effort(&ctx.db, chat_id).await;
    flush_pending_after(ctx, sink, chat_id, cancel.load(Ordering::Relaxed)).await;
    result
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    parts: Vec<InputPart>,
    override_zone_id: Option<String>,
    override_model: Option<String>,
) -> AppResult<()> {
    let ctx = EngineCtx::from_state(&state);
    let sink = StreamSink::tauri(app);
    let ov = TurnOverride {
        zone_id: override_zone_id.filter(|s| !s.is_empty()),
        model: override_model.filter(|s| !s.trim().is_empty()),
        // A person is on the other end of this one, including when they send
        // into a subchat a leader started.
        agent_driven: false,
    };
    run_send_entry(&ctx, &sink, &chat_id, parts, ov).await
}

/// Shared entry point for "send" used by both the Tauri command and the HTTP
/// API: registers a cancel flag, runs the send, cleans up.
///
/// Runs again for anything the user queued while the turn was in flight (see
/// `commands::pending`) — the `next`-mode messages plus any steer the model
/// finished before reaching. That is a loop rather than recursion so a user who
/// keeps typing can't grow the stack, and it is here rather than in the Tauri
/// command so the HTTP API and sub-agent turns behave the same way.
pub async fn run_send_entry(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    mut parts: Vec<InputPart>,
    ov: TurnOverride,
) -> AppResult<()> {
    // The one-shot zone/model override belongs to the message it was set for.
    // A queued follow-up is a plain user turn against the chat's own zone.
    let mut ov = ov;
    loop {
        // One turn per chat at a time — enforced here, where every sender
        // (GUI, HTTP API, sub-agents) passes, rather than trusted to the
        // composer's idea of whether the chat is busy. The window this closes
        // is a real one: between the model asking for a tool and the tool
        // answering, the transcript ends on an assistant message with
        // `tool_calls`, and a user message persisted there splits the call
        // from its result. Every provider then rejects the next request
        // ("assistant message with 'tool_calls' must be followed by tool
        // messages"), and the chat is wedged until someone deletes the
        // message. So a send into a running turn is held as a `next` follow-up
        // — the same thing the composer does on purpose — and delivered when
        // the turn ends. Only text can be held (the queue carries text), so a
        // send with attachments is refused with a reason instead.
        {
            let held = ctx.active_streams.write().await;
            if held.contains_key(chat_id) {
                drop(held);
                let (text, has_media) = parts.iter().fold(
                    (Vec::new(), false),
                    |(mut t, media), p| match p {
                        InputPart::Text { text } | InputPart::HiddenText { text } => {
                            t.push(text.as_str());
                            (t, media)
                        }
                        _ => (t, true),
                    },
                );
                if has_media {
                    return Err(AppError::Other(
                        "This chat is still working on the previous message. Wait for it to finish before sending attachments."
                            .into(),
                    ));
                }
                let text = text.join("

");
                if text.trim().is_empty() {
                    return Ok(());
                }
                let id = crate::commands::pending::push(
                    chat_id,
                    None,
                    text.clone(),
                    crate::commands::pending::Mode::Next,
                );
                sink.emit(chat_id, StreamPayload::PendingQueued { id, text });
                return Ok(());
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        ctx.active_streams
            .write()
            .await
            .insert(chat_id.to_string(), cancel.clone());

        let result = run_send(ctx, sink, chat_id, parts, &ov, cancel.clone()).await;

        ctx.active_streams.write().await.remove(chat_id);

        if let Err(e) = &result {
            sink.emit(chat_id, StreamPayload::Error { message: e.to_string() });
        }

        // A failed turn still leaves the user's queued message theirs to send;
        // a *cancelled* one does not — stop means stop, including whatever they
        // lined up behind it.
        let queued = crate::commands::pending::take_all(chat_id);
        if queued.is_empty() {
            return result;
        }
        let ids: Vec<String> = queued.iter().map(|p| p.id.clone()).collect();
        sink.emit(chat_id, StreamPayload::PendingCleared { ids });
        if cancel.load(Ordering::Relaxed) || result.is_err() {
            return result;
        }

        let text = queued
            .iter()
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        parts = vec![InputPart::Text { text }];
        ov = TurnOverride::default();
    }
}

/// Send anything the user queued during a turn that did not go through
/// [`run_send_entry`] (regenerate, and per-participant regenerate). Same rule:
/// a cancelled turn drops the queue, anything else delivers it as a new turn.
async fn flush_pending_after(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    cancelled: bool,
) {
    let queued = crate::commands::pending::take_all(chat_id);
    if queued.is_empty() {
        return;
    }
    let ids: Vec<String> = queued.iter().map(|p| p.id.clone()).collect();
    sink.emit(chat_id, StreamPayload::PendingCleared { ids });
    if cancelled {
        return;
    }
    let text = queued
        .iter()
        .map(|p| p.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let parts = vec![InputPart::Text { text }];
    if let Err(e) = run_send_entry(ctx, sink, chat_id, parts, TurnOverride::default()).await {
        tracing::warn!("queued follow-up for {chat_id} failed: {e}");
    }
}

async fn run_send(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    parts: Vec<InputPart>,
    ov: &TurnOverride,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    // Validate the chat exists before persisting anything. A missing zone is
    // fine — the chat runs in "simple" mode against the default provider — but
    // we resolve it now so we fail fast if no model can be determined.
    sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(chat_id)
    .fetch_optional(&ctx.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("chat {chat_id}")))?;

    // Resolve the mode now (honouring any override) so we fail fast before
    // persisting. Smart/Simple both just need a usable default provider+model
    // (Smart uses it as the router); a fixed zone must load.
    match resolve_turn_mode(&ctx.db, chat_id, ov).await? {
        TurnMode::Zone(z) => {
            load_zone_and_provider(&ctx.db, &z).await?;
        }
        TurnMode::Simple | TurnMode::Smart => {
            let p = default_provider(&ctx.db).await?;
            simple_zone(&p)?;
        }
    }

    // Convert input parts to ContentParts and save user message
    let content_parts: Vec<ContentPart> = parts
        .into_iter()
        .map(|p| match p {
            InputPart::Text { text } => ContentPart::Text { text },
            InputPart::Image { data_url } => ContentPart::ImageUrl {
                image_url: ImageUrl { url: data_url, detail: None },
            },
            InputPart::HiddenText { text } => ContentPart::HiddenText { text },
            InputPart::HiddenImage { data_url } => ContentPart::HiddenImage {
                image_url: ImageUrl { url: data_url, detail: None },
            },
        })
        .collect();
    let content_json = serde_json::to_string(&content_parts)?;

    let user_msg_id = new_id();
    let user_now = now_ts();
    sqlx::query(
        "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, created_at)
         VALUES (?1, ?2, 'user', ?3, NULL, NULL, NULL, ?4)",
    )
    .bind(&user_msg_id)
    .bind(chat_id)
    .bind(&content_json)
    .bind(user_now)
    .execute(&ctx.db)
    .await?;
    sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
        .bind(user_now)
        .bind(chat_id)
        .execute(&ctx.db)
        .await?;

    let user_msg = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
    ))
    .bind(&user_msg_id)
    .fetch_one(&ctx.db)
    .await?;
    sink.emit(chat_id, StreamPayload::UserMessageSaved { message: &user_msg });

    run_turn(ctx, sink, chat_id, ov, cancel).await;
    Ok(())
}

/// Load a zone and its provider by zone id. Shared by the agentic loop (initial
/// load + reload after a mid-turn zone switch).
async fn load_zone_and_provider(
    db: &SqlitePool,
    zone_id: &str,
) -> AppResult<(Zone, Provider)> {
    let zone = sqlx::query_as::<_, Zone>(&format!(
        "SELECT {ZONE_COLS} FROM zones WHERE id = ?1"
    ))
    .bind(zone_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("zone {zone_id}")))?;

    let provider_id = zone
        .provider_id
        .clone()
        .ok_or_else(|| AppError::Invalid("zone has no provider".into()))?;
    let provider = sqlx::query_as::<_, Provider>(
        "SELECT id, name, base_url, api_key, default_model, created_at FROM providers WHERE id = ?1",
    )
    .bind(&provider_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("provider {provider_id}")))?;

    Ok((zone, provider))
}

/// Synthetic zone id used for "quick"/simple chats that aren't bound to a zone.
pub const SIMPLE_ZONE_ID: &str = "__simple__";
/// Sentinel zone id meaning "Smart chat" — route to a zone per turn.
pub const SMART_ZONE_ID: &str = "__smart__";

/// Read the `baseZoneId` from app_settings, if one has been configured.
async fn base_zone_id(db: &SqlitePool) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT value FROM settings WHERE key = 'app_settings'",
    )
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .flatten()
    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    .and_then(|v| {
        v.get("baseZoneId")
            .and_then(|d| d.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
    })
}

/// Resolve the provider used for simple (no-zone) chats when no base zone is
/// configured: the oldest provider.
///
/// This used to consult a separate `defaultProviderId` app setting, which sat
/// alongside the base zone answering the same question ("what runs a Quick
/// chat?") one rung lower. The base zone is now the single answer, and this is
/// only the floor under it (0.9.9).
async fn default_provider(db: &SqlitePool) -> AppResult<Provider> {
    sqlx::query_as::<_, Provider>(
        "SELECT id, name, base_url, api_key, default_model, created_at FROM providers ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::Invalid("no provider configured for quick chat".into()))
}

/// Build the in-memory synthetic zone for a simple chat from its provider's
/// default model. No system prompt, no tools — fast, approximate answers.
fn simple_zone(provider: &Provider) -> AppResult<Zone> {
    let model = provider
        .default_model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .ok_or_else(|| {
            AppError::Invalid("the quick-chat provider has no default model set".into())
        })?;
    Ok(Zone {
        id: SIMPLE_ZONE_ID.to_string(),
        name: "Quick chat".to_string(),
        provider_id: Some(provider.id.clone()),
        model,
        system_prompt: None,
        temperature: Some(0.7),
        max_tokens: None,
        top_p: None,
        // Quick chat gets every safe tool by default (date/time, ask-user,
        // tagging, graphs/diagrams) so the default model is useful immediately.
        tools_enabled: serde_json::to_string(&tools::safe_tool_ids())
            .unwrap_or_else(|_| "[]".to_string()),
        tool_config: "{}".to_string(),
        thinking_enabled: false,
        thinking_effort: "medium".to_string(),
        include_thinking_in_context: false,
        icon: None,
        accent_color: None,
        is_leader: false,
        // Nothing to fall back to: quick chat *is* the fallback — one provider,
        // its own default model, chosen in settings.
        fallback_zone_id: None,
        // No overrides: quick chat answers under the global approval policy.
        approvals: None,
        created_at: 0,
        updated_at: 0,
    })
}

/// Resolve a chat's effective zone + provider. When the chat has a zone bound,
/// that zone is loaded as usual. When it doesn't (simple/quick chat), a
/// synthetic zone is built from the default provider's default model.
pub async fn effective_zone_and_provider(
    db: &SqlitePool,
    chat_id: &str,
) -> AppResult<(Zone, Provider)> {
    let zone_id: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT zone_id FROM chats WHERE id = ?1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await?
    .flatten();

    match zone_id {
        Some(zid) => load_zone_and_provider(db, &zid).await,
        None => {
            if let Some(zid) = base_zone_id(db).await {
                if let Ok(zp) = load_zone_and_provider(db, &zid).await {
                    return Ok(zp);
                }
            }
            let provider = default_provider(db).await?;
            let zone = simple_zone(&provider)?;
            Ok((zone, provider))
        }
    }
}

/// How a single turn picks its zone.
#[derive(Clone)]
enum TurnMode {
    /// A specific zone id.
    Zone(String),
    /// Quick chat — synthetic zone from the default provider's model.
    Simple,
    /// Smart chat — a router model picks the zone for this turn.
    Smart,
}

/// Decide the turn's mode from any one-shot override, falling back to the
/// chat's stored state (smart flag → zone → quick).
async fn resolve_turn_mode(
    db: &SqlitePool,
    chat_id: &str,
    ov: &TurnOverride,
) -> AppResult<TurnMode> {
    match ov.zone_id.as_deref() {
        Some(SMART_ZONE_ID) => Ok(TurnMode::Smart),
        Some(SIMPLE_ZONE_ID) => Ok(TurnMode::Simple),
        Some(z) => Ok(TurnMode::Zone(z.to_string())),
        None => {
            let row: Option<(Option<String>, bool)> = sqlx::query_as(
                "SELECT zone_id, smart_routing FROM chats WHERE id = ?1",
            )
            .bind(chat_id)
            .fetch_optional(db)
            .await?;
            Ok(match row {
                Some((_, true)) => TurnMode::Smart,
                Some((Some(z), false)) => TurnMode::Zone(z),
                _ => TurnMode::Simple,
            })
        }
    }
}

/// Materialise a turn mode into a concrete zone + provider, applying any model
/// override. Smart mode runs the router; if it can't pick (no zones, no router
/// model, or the pick fails to load) it falls back to a Quick/simple zone.
async fn zone_for_mode(
    db: &SqlitePool,
    http: &reqwest::Client,
    chat_id: &str,
    mode: &TurnMode,
    model_override: Option<&str>,
) -> AppResult<(Zone, Provider)> {
    let (mut zone, provider) = match mode {
        TurnMode::Zone(z) => load_zone_and_provider(db, z).await?,
        TurnMode::Simple => {
            // Try the configured base zone first; fall back to the legacy
            // default-provider + synthetic zone when none is set.
            if let Some(zid) = base_zone_id(db).await {
                if let Ok(zp) = load_zone_and_provider(db, &zid).await {
                    zp
                } else {
                    let p = default_provider(db).await?;
                    (simple_zone(&p)?, p)
                }
            } else {
                let p = default_provider(db).await?;
                (simple_zone(&p)?, p)
            }
        }
        TurnMode::Smart => match route_zone_id(db, http, chat_id).await.ok().flatten() {
            Some(zid) => match load_zone_and_provider(db, &zid).await {
                Ok(zp) => zp,
                Err(_) => {
                    let p = default_provider(db).await?;
                    (simple_zone(&p)?, p)
                }
            },
            None => {
                let p = default_provider(db).await?;
                (simple_zone(&p)?, p)
            }
        },
    };
    if let Some(m) = model_override {
        zone.model = m.to_string();
    }
    Ok((zone, provider))
}

/// Smart-chat router: ask the default model to pick the best zone for the
/// latest user message. Returns the chosen zone id, or `None` to fall back.
async fn route_zone_id(
    db: &SqlitePool,
    http: &reqwest::Client,
    chat_id: &str,
) -> AppResult<Option<String>> {
    let zones = sqlx::query_as::<_, Zone>(&format!("SELECT {ZONE_COLS} FROM zones ORDER BY name"))
        .fetch_all(db)
        .await?;
    if zones.is_empty() {
        return Ok(None);
    }

    let provider = default_provider(db).await?;
    let model = match provider.default_model.clone().filter(|m| !m.trim().is_empty()) {
        Some(m) => m,
        None => return Ok(None),
    };

    // Latest user message text drives the routing decision.
    let user_text = sqlx::query_scalar::<_, String>(
        "SELECT content FROM messages WHERE chat_id = ?1 AND role = 'user' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await?
    .map(|c| extract_text_parts(&c))
    .unwrap_or_default();
    if user_text.trim().is_empty() {
        return Ok(None);
    }

    let mut list = String::new();
    for (i, z) in zones.iter().enumerate() {
        let blurb = z
            .system_prompt
            .as_deref()
            .map(first_line)
            .filter(|s| !s.is_empty())
            .unwrap_or("general assistant");
        list.push_str(&format!("{}. {} — {}\n", i + 1, z.name, blurb));
    }

    let prompt = format!(
        "You are a router that picks the single best assistant to handle a user's message. \
         The available assistants are:\n\n{list}\nUser message:\n\"\"\"\n{user}\n\"\"\"\n\n\
         Reply with ONLY the number of the best assistant — nothing else.",
        list = list,
        user = user_text.trim(),
    );

    let req = ChatRequest {
        model,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: Some(MessageContent::Text(prompt)),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }],
        temperature: Some(0.0),
        max_tokens: Some(2048),
        top_p: None,
        tools: None,
        tool_choice: None,
        reasoning_effort: None,
        chat_template_kwargs: None,
        stream_options: None,
        stream: false,
    };

    // Routing is a real request against a real model, once per turn. Booking it
    // here is the difference between a spend figure that matches the provider's
    // dashboard and one that quietly runs under it.
    let measure = {
        let cpt = crate::llm::tokens::chars_per_token(db, &req.model).await;
        crate::llm::tokens::measure_request(&req, cpt)
    };

    let client =
        LlmClient::new(http, &provider.base_url, provider.api_key.as_deref()).for_chat(chat_id);
    let resp = client.chat_completion(&req).await?;
    crate::llm::tokens::record_request(db, chat_id, &req.model, &measure, resp.usage.as_ref()).await;
    let raw = resp
        .choices
        .first()
        .and_then(|c| match &c.message.content {
            Some(MessageContent::Text(s)) => Some(s.clone()),
            Some(MessageContent::Parts(parts)) => Some(
                parts
                    .iter()
                    .filter_map(|p| match p {
                        ContentPart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            None => None,
        })
        .unwrap_or_default();
    let answer = strip_thinking_blocks(&raw);

    // Prefer the first number in the reply (1-based index into `zones`).
    if let Some(idx) = first_number(&answer) {
        if idx >= 1 && idx <= zones.len() {
            return Ok(Some(zones[idx - 1].id.clone()));
        }
    }
    // Fall back to a case-insensitive name match.
    let lower = answer.to_lowercase();
    if let Some(z) = zones.iter().find(|z| lower.contains(&z.name.to_lowercase())) {
        return Ok(Some(z.id.clone()));
    }
    Ok(None)
}

/// First line of a string, trimmed.
fn first_line(s: &str) -> &str {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

/// First base-10 integer appearing in `s`, if any.
fn first_number(s: &str) -> Option<usize> {
    let mut digits = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if !digits.is_empty() {
            break;
        }
    }
    digits.parse().ok()
}

/// Join the text parts of a stored message's content JSON.
fn extract_text_parts(content_json: &str) -> String {
    let parts: Vec<ContentPart> = serde_json::from_str(content_json).unwrap_or_default();
    parts
        .iter()
        .filter_map(|p| match p {
            ContentPart::Text { text } | ContentPart::HiddenText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Drives a full turn: the primary zone plus any perspective zones. In
/// `parallel` mode they all stream concurrently as equal participants; in
/// `sequential` mode the primary runs first, then each perspective in turn.
/// Every participant shares the one cancel flag, so cancelling stops them all.
async fn run_turn(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    ov: &TurnOverride,
    cancel: Arc<AtomicBool>,
) {
    run_turn_inner(ctx, sink, chat_id, ov, cancel).await;
    // After the turn (primary + any perspectives have all completed), refresh
    // the on-disk markdown mirror if the user has it enabled (0.7.2).
    crate::commands::mirror::mirror_chat_best_effort(&ctx.db, chat_id).await;
}

async fn run_turn_inner(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    ov: &TurnOverride,
    cancel: Arc<AtomicBool>,
) {
    let persp_ids: Vec<String> =
        sqlx::query_scalar("SELECT zone_id FROM chat_zones WHERE chat_id = ?1")
            .bind(chat_id)
            .fetch_all(&ctx.db)
            .await
            .unwrap_or_default();

    // No perspective zones → ordinary single-zone turn.
    if persp_ids.is_empty() {
        if let Err(e) = run_agentic_loop(ctx, sink, chat_id, ov, cancel).await {
            sink.emit(chat_id, StreamPayload::Error { message: e.to_string() });
        }
        return;
    }

    let mode = resolve_perspective_mode(&ctx.db, chat_id).await;

    if mode == "parallel" {
        // Primary + every perspective stream at once. They're all blind to the
        // current round's sibling answers (history is snapshotted before any of
        // this round's assistant turns are saved).
        let mut handles = Vec::new();
        {
            let ctx = ctx.clone();
            let sink = sink.clone();
            let chat_id = chat_id.to_string();
            let ov = ov.clone();
            let cancel = cancel.clone();
            handles.push(tokio::spawn(async move {
                if let Err(e) = run_agentic_loop(&ctx, &sink, &chat_id, &ov, cancel).await {
                    sink.emit(&chat_id, StreamPayload::Error { message: e.to_string() });
                }
            }));
        }
        for zone_id in persp_ids {
            let ctx = ctx.clone();
            let sink = sink.clone();
            let chat_id = chat_id.to_string();
            let cancel = cancel.clone();
            handles.push(tokio::spawn(async move {
                if let Err(e) = run_perspective(&ctx, &sink, &chat_id, &zone_id, cancel).await {
                    tracing::warn!("perspective zone {zone_id} error: {e}");
                    sink.emit_persp(
                        &chat_id,
                        &zone_id,
                        StreamPayload::Error { message: e.to_string() },
                    );
                }
            }));
        }
        for h in handles {
            let _ = h.await;
        }
    } else {
        // Sequential: primary first, then one perspective at a time (gentler on
        // local model VRAM). Each still only sees prior rounds.
        if let Err(e) = run_agentic_loop(ctx, sink, chat_id, ov, cancel.clone()).await {
            sink.emit(chat_id, StreamPayload::Error { message: e.to_string() });
        }
        for zone_id in persp_ids {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if let Err(e) = run_perspective(ctx, sink, chat_id, &zone_id, cancel.clone()).await {
                tracing::warn!("perspective zone {zone_id} error: {e}");
                sink.emit_persp(
                    chat_id,
                    &zone_id,
                    StreamPayload::Error { message: e.to_string() },
                );
            }
        }
    }
}

/// Distinguishes a participant in a turn: the primary zone or a perspective.
struct TurnParticipant {
    zone: Zone,
    provider: Provider,
    /// `None` = primary turn (events on the main channel; assistant messages
    /// stored with `active_zone_id`, `zone_id` NULL). `Some(id)` = perspective
    /// turn (events on the per-zone channel; messages stored with `zone_id`).
    persp_zone_id: Option<String>,
    /// Honour a mid-turn `change_zone` switch (primary, zone mode, no override).
    allow_zone_switch: bool,
    /// Carried from [`TurnOverride::agent_driven`]: whether a leader drove this
    /// turn rather than a person. Decides whether `ask_user` survives in a
    /// subchat — see the strip site below.
    agent_driven: bool,
}

/// Primary-zone wrapper: resolves the turn's mode (override → chat state →
/// smart/simple/zone), emits routing events, then runs the shared loop.
async fn run_agentic_loop(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    ov: &TurnOverride,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    // Resolve the turn's mode (override → chat state) and materialise its zone.
    // Smart mode routes here via the default model.
    let mode = resolve_turn_mode(&ctx.db, chat_id, ov).await?;
    let is_zone_mode = matches!(mode, TurnMode::Zone(_));
    let is_smart = matches!(mode, TurnMode::Smart);
    if is_smart {
        sink.emit(chat_id, StreamPayload::RoutingStarted);
    }
    let (zone, provider) =
        zone_for_mode(&ctx.db, &ctx.http, chat_id, &mode, ov.model.as_deref()).await?;
    if is_smart {
        sink.emit(chat_id, StreamPayload::RoutingDone {
            zone_id: zone.id.clone(),
            zone_name: zone.name.clone(),
        });
    }
    let participant = TurnParticipant {
        zone,
        provider,
        persp_zone_id: None,
        allow_zone_switch: !ov.is_active() && is_zone_mode,
        agent_driven: ov.agent_driven,
    };
    run_participant_turn(ctx, sink, chat_id, participant, cancel).await
}

/// Appends an out-of-band instruction (step budget, stall recovery) to the
/// request being built for this step.
///
/// Sent as `user` rather than `system` on purpose. A mid-conversation system
/// message is fine on the big hosted APIs but is rejected outright by the strict
/// chat templates some local servers apply (Gemma's, notably, allows a system
/// turn only as the very first message) — and a note the model never receives is
/// worse than a slightly odd-looking role. Nothing here is persisted: these live
/// only in this turn's request body, so the stored conversation is untouched and
/// the next turn rebuilds cleanly from the database.
/// The text of the last user message in a built history — what this turn is
/// actually answering. Attachments and images are skipped; only prose can carry
/// an instruction like "plan this first".
fn last_user_text(api_messages: &[ChatMessage]) -> Option<String> {
    let msg = api_messages.iter().rev().find(|m| m.role == "user")?;
    match msg.content.as_ref()? {
        MessageContent::Text(t) => Some(t.clone()),
        MessageContent::Parts(parts) => {
            let joined = parts
                .iter()
                .filter_map(|p| match p {
                    ContentPart::Text { text } | ContentPart::HiddenText { text } => {
                        Some(text.as_str())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.trim().is_empty()).then_some(joined)
        }
    }
}

fn push_system_note(api_messages: &mut Vec<ChatMessage>, text: String) {
    api_messages.push(ChatMessage {
        role: "user".into(),
        content: Some(MessageContent::Text(text)),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    });
}

/// The chat that spawned this one, when it is a sub-agent's subchat rather than
/// a branch. Branches share the `parent_chat_id` link and have no owning zone,
/// which is what `initiated_by_zone_id` distinguishes.
async fn subchat_parent(db: &SqlitePool, chat_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT parent_chat_id FROM chats
          WHERE id = ?1 AND initiated_by_zone_id IS NOT NULL",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .flatten()
}

/// Hand the model anything the user queued as a *steer* while this turn was
/// running (see `commands::pending`).
///
/// Called at the top of each step, which is the whole point: a step boundary is
/// where the model is deciding what to do next, so a correction lands where it
/// can still change the plan instead of interrupting a half-written sentence.
///
/// Unlike the out-of-band notes above, this *is* persisted — the user really did
/// say it, and it has to be in the transcript and in the next turn's history.
/// Only the copy in this request body carries the "sent while you were working"
/// framing; the stored message is exactly what they typed.
async fn deliver_steers(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    api_messages: &mut Vec<ChatMessage>,
) -> AppResult<()> {
    let queued = crate::commands::pending::take_steers(chat_id);
    if queued.is_empty() {
        return Ok(());
    }
    for p in queued {
        let content_json = serde_json::to_string(&vec![ContentPart::Text { text: p.text.clone() }])?;
        let msg_id = new_id();
        let now = now_ts();
        sqlx::query(
            "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, created_at)
             VALUES (?1, ?2, 'user', ?3, NULL, NULL, NULL, ?4)",
        )
        .bind(&msg_id)
        .bind(chat_id)
        .bind(&content_json)
        .bind(now)
        .execute(&ctx.db)
        .await?;
        sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
            .bind(now)
            .bind(chat_id)
            .execute(&ctx.db)
            .await?;
        let msg = sqlx::query_as::<_, Message>(&format!(
            "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
        ))
        .bind(&msg_id)
        .fetch_one(&ctx.db)
        .await?;
        sink.emit(chat_id, StreamPayload::SteerDelivered { id: p.id.clone(), message: &msg });
        push_system_note(
            api_messages,
            format!(
                "The user sent this just now, while you were working. It is more recent than \
                 anything above and it is not a new task — take it into account before you decide \
                 your next step:\n\n{}",
                p.text
            ),
        );
    }
    Ok(())
}

/// The shared agentic loop run by both the primary zone and each perspective
/// zone. Streams tokens/tools, executes tool calls (with per-participant
/// approval), and persists messages tagged for the right participant.
async fn run_participant_turn(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    participant: TurnParticipant,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let TurnParticipant {
        mut zone,
        mut provider,
        persp_zone_id,
        allow_zone_switch,
        agent_driven,
    } = participant;
    let persp = persp_zone_id.as_deref();
    // Rebuilt on a zone switch below: the new zone's model may not see images,
    // and the tools it is offered have to match the model that will answer.
    let mut tool_ctx = load_tool_context(&ctx.db, Some(chat_id), Some(&zone.model)).await;

    // The chat's stored primary zone, tracked so the `change_zone` tool can
    // switch zones mid-turn. Only the primary in plain Zone mode can switch.
    let mut current_zone_id: Option<String> = if allow_zone_switch {
        Some(zone.id.clone())
    } else {
        None
    };
    // Project knowledge (RAG) is offered as the read-only `search_knowledge`
    // tool when this chat opted in AND its project has a non-empty index. It's
    // independent of the zone's `tools_enabled`, so it's appended after every
    // (re)build of the toolset below rather than going through `build_tools_for_zone`.
    let knowledge_available = {
        let enabled: bool = sqlx::query_scalar("SELECT knowledge_enabled FROM chats WHERE id = ?1")
            .bind(chat_id)
            .fetch_optional(&ctx.db)
            .await?
            .unwrap_or(false);
        if enabled {
            let pid: Option<String> =
                sqlx::query_scalar("SELECT project_id FROM chats WHERE id = ?1")
                    .bind(chat_id)
                    .fetch_optional(&ctx.db)
                    .await?
                    .flatten();
            // No project → the global KB (default-directory index), if any.
            let scope = pid.unwrap_or_else(|| crate::knowledge::GLOBAL_KB_ID.to_string());
            crate::knowledge::has_index(&ctx.db, &scope).await
        } else {
            false
        }
    };

    // A sub-agent turn that a *leader* is driving suppresses `ask_user`: the
    // question would render in a chat nobody is watching, and the turn would
    // wait on an answer that can never come. A turn the user sent into that same
    // subchat themselves (0.9.11) keeps it — they are right there, and making
    // the sub-agent guess instead of ask would be the worse outcome.
    //
    // Computed once here; the flag also gates the tool rebuild after a mid-turn
    // zone switch below.
    let suppress_ask_user: bool = agent_driven
        && sqlx::query_scalar::<_, Option<String>>(
            "SELECT initiated_by_zone_id FROM chats WHERE id = ?1",
        )
        .bind(chat_id)
        .fetch_optional(&ctx.db)
        .await?
        .flatten()
        .is_some();

    let mut tools = build_tools_for_zone(&ctx.db, &zone, &tool_ctx).await;
    if knowledge_available {
        tools.push(crate::tools::knowledge::definition());
    }
    if suppress_ask_user {
        strip_ask_user(&mut tools);
    }
    // Plan mode (0.12.0). Re-evaluated after every tool batch below, because the
    // model can move the chat in or out of it mid-turn.
    let mut planning = apply_plan_mode(&ctx.db, chat_id, &mut tools, persp.is_some()).await;
    // Per-zone MCP tool danger levels, refreshed on zone switch, consulted by the
    // approval gate alongside built-in `tool_safety_by_name`.
    let mut mcp_danger = {
        let ids: Vec<String> = serde_json::from_str(&zone.tools_enabled).unwrap_or_default();
        crate::mcp::danger_for_ids(&ctx.db, &ids).await
    };
    let mut zone_config: Value =
        serde_json::from_str(&zone.tool_config).unwrap_or(Value::Object(Default::default()));

    inject_global_tool_config(&mut zone_config, &ctx.db, &zone.model).await;

    // The directory that scopes the filesystem tools. Resolved with the tool
    // context above, so the descriptions the model sees and the roots the tools
    // enforce can't disagree about which directory a path resolves against.
    let project_dir: Option<String> = tool_ctx.project_dir.clone();

    // Build initial messages array (full history)
    let mut api_messages = build_message_history(&ctx.db, chat_id, &zone, persp.is_some()).await?;

    // "Plan this out first" should reach the tool without the user having to
    // name it (0.14.6). The standing snippet says planning exists; this says the
    // message you just received is probably asking for it — which is what the
    // snippet alone was not enough for, since a general instruction about when
    // to plan competes with everything else in a long system prompt at exactly
    // the moment it matters.
    //
    // A note appended to the messages rather than another system snippet: it
    // varies per message, and a volatile snippet at the front of the system
    // prompt costs the prefix cache for the whole conversation behind it. It
    // only ever reminds — the mode is still the model's to enter, so a false
    // positive is one wasted sentence rather than a plan nobody asked for.
    if !planning && !tools.is_empty() {
        if let Some(text) = last_user_text(&api_messages) {
            if crate::plans::reads_as_plan_request(&text) {
                push_system_note(&mut api_messages, crate::plans::plan_request_nudge());
            }
        }
    }

    let mut client = LlmClient::new(&ctx.http, &provider.base_url, provider.api_key.as_deref())
        .for_chat(chat_id);

    // Agentic loop. The budget is a user setting rather than a constant, and its
    // last two steps are spent finishing: one warned step, then a final step with
    // tools switched off so the turn always ends in an answer instead of falling
    // silently off the end of a tool result (see `llm::continuity`).
    // A planning turn gets a larger budget: its whole output is reading, none of
    // it can change anything, and a plan filed because the loop ran out mid-
    // research is the thin plan 0.14.6 exists to stop. Fixed for the turn — the
    // loop bound is evaluated once — so a chat that enters plan mode *mid*-turn
    // keeps the ordinary budget and is caught instead by the final-step
    // exception below, which leaves `exit_plan_mode` reachable.
    let max_steps = {
        let base = max_tool_steps(&ctx.db).await;
        if planning { continuity::plan_mode_steps(base) } else { base }
    };
    // 0 = no ceiling, which is the default (see `max_session_tokens`).
    let spend_cap = max_session_tokens(&ctx.db, chat_id).await;
    // Path-triggered rules (0.14.5): the directories whose own instructions this
    // turn has already answered for, carrying the ones that turned out to hold
    // nothing as well — a model working through twenty files in one folder pays
    // for the lookup once. Per turn, because the note lives only in this turn's
    // request body; the next turn rebuilds from the database, where it was
    // deliberately never stored.
    let project_instructions = project_instructions_enabled(&ctx.db).await;
    let mut instructions_seen: std::collections::HashSet<std::path::PathBuf> =
        std::collections::HashSet::new();
    // Project checks (0.14.5): did this turn actually change any files, and
    // have the checks already had their one run? Both per turn — a turn that
    // only read things has nothing to check, and a suite that runs after every
    // repair attempt spends the whole step budget on the same tests.
    let mut edits_landed = false;
    let mut checks_ran = false;
    // Stall recovery state, tracked across the whole turn.
    let mut used_tools_this_turn = false;
    let mut nudges_used = 0usize;
    // Did any step of this turn yield something the user can see? Drives the
    // empty-response check after the loop.
    let mut produced_output = false;
    // A turn the user stopped is an empty result on purpose, not a failure.
    let mut cancelled_turn = false;
    // The size of the last request this turn sent, as the provider counted it
    // (or as we estimated it, for providers that report nothing). What decides
    // whether the chat is condensed before the next turn (0.18).
    let mut last_context_tokens: i64 = 0;
    // Set when the user asked the run to stop after the step in flight (0.12.1).
    // The next step runs with no tools, so it can only answer.
    let mut stop_after_step = false;
    // Loop detection (0.14.1), per turn — a call repeated across two turns is
    // the user asking twice, not an agent stuck.
    let mut loop_guard = crate::llm::runaway::LoopGuard::new();
    // Whether this turn has already spent its one fallback zone (0.14.1).
    let mut used_fallback = false;
    // Overflow recovery (0.18): a provider refusing the request as too long is
    // compacted and retried once per turn, whatever the configured window says.
    let mut compacted_for_overflow = false;
    // Citation numbering for this turn. Every citing tool numbers its own
    // results from 1, so without a shared counter a search and a `read` in
    // the same turn would both tell the model to write `[1]`. See
    // `tools::citations`.
    let mut next_citation_ref = 1u32;
    // Groups every tool call of this turn, so the checkpoint taken before the
    // turn's first file change is the one every later change extends (0.10.0).
    // Per turn rather than per step: the user reverts "what the assistant just
    // did", which spans the whole agentic loop, not one iteration of it.
    let turn_id = new_id();

    // The session event log (0.12.2). Written alongside the turn rather than
    // derived from it afterwards, because the things worth replaying — an
    // approval denied, a zone switched, a turn that died on a provider error —
    // leave nothing behind in the transcript to derive from.
    crate::events::record(
        &ctx.db,
        chat_id,
        Some(&turn_id),
        persp,
        "turn_start",
        format!("{} started a turn", zone.name),
        Some(serde_json::json!({ "zoneId": zone.id, "model": zone.model })),
    )
    .await;

    for step in 0..max_steps {
        if cancel.load(Ordering::Relaxed) {
            sink.emit_for(chat_id, persp, StreamPayload::Cancelled);
            return Ok(());
        }

        // Only the primary reads the user's mid-turn notes. A perspective zone
        // is answering the same question in its own lane; a correction aimed at
        // the main answer would land in every lane at once and be saved to the
        // transcript once per participant.
        if persp.is_none() {
            deliver_steers(ctx, sink, chat_id, &mut api_messages).await?;
        }

        // The session spend ceiling (0.14.1, made a real stop in 0.14.3).
        //
        // Checked at the step boundary, and what happens there is a **hard
        // stop**: the loop ends here, with no further request to the provider.
        //
        // 0.14.1 gave the model one more tool-free step to explain itself, the
        // same wrap-up the step budget uses. That was wrong, and the reason is
        // the whole point of this setting: another step is *another paid
        // request*, and the largest kind — a wrap-up re-sends the entire
        // context. A limit that spends past itself to apologise for spending is
        // not a limit. The user is told instead, by the app, for free.
        if spend_cap > 0 {
            match crate::commands::usage::session_spent_tokens(&ctx.db, chat_id).await {
                Ok(spent) if spent >= spend_cap => {
                    tracing::info!("session spend limit reached: {spent}/{spend_cap} tokens");
                    crate::events::record(
                        &ctx.db,
                        chat_id,
                        Some(&turn_id),
                        persp,
                        "spend_limit",
                        format!(
                            "Stopped: this session has spent {spent} tokens of its {spend_cap} limit"
                        ),
                        Some(serde_json::json!({ "spent": spent, "cap": spend_cap })),
                    )
                    .await;
                    sink.emit_for(
                        chat_id,
                        persp,
                        StreamPayload::SpendLimit {
                            spent,
                            cap: spend_cap,
                            // Mid-turn: work was done and is in the transcript
                            // above, which changes what the user is deciding
                            // about.
                            mid_turn: step > 0,
                        },
                    );
                    sink.emit_for(chat_id, persp, StreamPayload::Done);
                    return Ok(());
                }
                Ok(_) => {}
                // A limit that cannot be read must not end the turn — a failed
                // count is our problem, not the user's run.
                Err(e) => tracing::warn!("spend limit check failed: {e}"),
            }
        }

        // Budget signalling. The wrap-up warning lands one step before the end so
        // the model can choose what to spend its last call on; the final step
        // both warns and withholds the tools, which is what actually guarantees
        // prose comes back.
        let final_step = continuity::is_final_step(step, max_steps) || stop_after_step;
        // A planning turn's last step keeps the tools that *file* the plan. The
        // whole point of the mode is that the answer arrives as a row the user
        // can edit; a turn that runs out of budget and writes the plan into the
        // transcript instead has failed in the specific way the mode exists to
        // prevent. `stop_after_step` is excluded — that one is the user asking
        // for the work to end, and it should.
        let plan_endgame = final_step && planning && !stop_after_step;
        if plan_endgame {
            push_system_note(&mut api_messages, continuity::final_step_plan_nudge(max_steps));
        } else if final_step && !stop_after_step {
            push_system_note(&mut api_messages, continuity::final_step_nudge(max_steps));
        } else if final_step {
            // The turn is ending early — the user asked it to stop (0.12.1), or
            // loop detection stopped it (0.14.1). Both already pushed a note
            // saying why; "you have used all N tool steps" on top of that is
            // simply false, and a model told two different reasons picks one.
        } else if continuity::is_wrapup_step(step, max_steps) {
            push_system_note(
                &mut api_messages,
                continuity::wrapup_nudge(max_steps - step, max_steps),
            );
        }

        let assistant_msg_id = new_id();
        sink.emit_for(
            chat_id,
            persp,
            StreamPayload::AssistantStart {
                message_id: assistant_msg_id.clone(),
            },
        );

        // How this model is asked to think — or told not to — is its own
        // business (0.17.9): `reasoning_effort` for OpenAI-style reasoning
        // models and hosted gateways, a chat-template toggle for local Qwen and
        // DeepSeek servers, nothing at all for Gemma (inline tags) or gpt-4o
        // (no reasoning to switch on). See `llm::thinking::profile`.
        let thinking = crate::llm::thinking::controls(
            &zone.model,
            &provider.base_url,
            zone.thinking_enabled,
            &zone.thinking_effort,
        );
        let reasoning_effort = thinking.reasoning_effort;
        let chat_template_kwargs = thinking.chat_template_kwargs;
        let parse_inline_think = thinking.parse_inline;

        let req = ChatRequest {
            model: zone.model.clone(),
            messages: api_messages.clone(),
            temperature: zone.temperature,
            max_tokens: zone.max_tokens,
            top_p: zone.top_p,
            // Tools are withheld on the final step so the model has no option
            // but to answer. Every other step offers the full set — except a
            // planning turn's last step, which keeps exactly the tools that end
            // it properly (see `plan_endgame`).
            tools: if tools.is_empty() {
                None
            } else if plan_endgame {
                let filing: Vec<Tool> = tools
                    .iter()
                    .filter(|t| {
                        matches!(t.function.name.as_str(), "exit_plan_mode" | "draft_plan_step")
                    })
                    .cloned()
                    .collect();
                if filing.is_empty() { None } else { Some(filing) }
            } else if final_step {
                None
            } else {
                Some(tools.clone())
            },
            tool_choice: None,
            reasoning_effort,
            chat_template_kwargs,
            // Ask the provider for its own token counts. Exact where ours are
            // estimated, and the only way to see prompt cache hits — which on a
            // long agentic turn are most of what gets billed.
            stream_options: Some(serde_json::json!({ "include_usage": true })),
            stream: true,
        };

        // The last thing before the request goes out, deliberately: `req` is
        // fully assembled here, so measuring it counts the system prompt, the
        // skills catalog, the memories, the tool schemas, this step's nudge and
        // any steer delivered above — without a second code path being asked to
        // predict what the builder produced.
        let measure = {
            let cpt = crate::llm::tokens::chars_per_token(&ctx.db, &zone.model).await;
            crate::llm::tokens::measure_request(&req, cpt)
        };

        let response = match client.chat_stream(&req).await {
            Ok(res) => res,
            Err(e)
                if !compacted_for_overflow
                    && persp.is_none()
                    && crate::tools::compact::is_context_overflow(&e.to_string()) =>
            {
                // The window setting was too generous for this model (or unset
                // for a small one): the provider has just told us the real
                // limit. Condense and retry with the same step budget — what
                // opencode does on overflow, and the reason the window never
                // has to be typed in for compaction to happen at all.
                compacted_for_overflow = true;
                tracing::info!("{} refused the request as too long ({e}); condensing and retrying", zone.name);
                match crate::tools::compact::auto_compact(&ctx.db, &ctx.http, chat_id, &zone, &provider).await {
                    Ok(Some(n)) => {
                        crate::events::record(
                            &ctx.db,
                            chat_id,
                            Some(&turn_id),
                            persp,
                            "compacted",
                            format!("The model's context window overflowed; condensed {n} earlier messages and retried"),
                            None,
                        )
                        .await;
                        sink.notify_chats_changed();
                        api_messages = build_message_history(&ctx.db, chat_id, &zone, false).await?;
                        continue;
                    }
                    Ok(None) => return Err(e),
                    Err(ce) => {
                        tracing::warn!("compaction after overflow failed: {ce}");
                        return Err(e);
                    }
                }
            }
            Err(e) => {
                // The zone's provider will not serve this turn — rate limited
                // past its cooldown, host down, key rejected. If the zone names
                // a fallback, answer with that instead of losing the run
                // (0.14.1). Once per turn: a second fallback would be a chain
                // that hides which provider actually died, and a fallback whose
                // own provider is also down is a dead turn either way.
                let fallback_id = (!used_fallback)
                    .then(|| zone.fallback_zone_id.clone())
                    .flatten();
                let Some(fallback_id) = fallback_id else { return Err(e) };
                let Ok((fz, fp)) = load_zone_and_provider(&ctx.db, &fallback_id).await else {
                    // The fallback is gone or has no provider. Report the
                    // original failure, which is the one worth reading.
                    tracing::warn!("fallback zone {fallback_id} could not be loaded");
                    return Err(e);
                };
                tracing::info!("{} failed ({e}); falling back to {}", zone.name, fz.name);
                crate::events::record(
                    &ctx.db,
                    chat_id,
                    Some(&turn_id),
                    persp,
                    "zone_fallback",
                    format!("{} could not answer — {} is taking over", zone.name, fz.name),
                    Some(serde_json::json!({
                        "from": zone.name,
                        "to": fz.name,
                        "error": e.to_string(),
                    })),
                )
                .await;
                used_fallback = true;
                current_zone_id = Some(fz.id.clone());
                zone = fz;
                provider = fp;
                tool_ctx.vision_capable = model_vision_capable(&ctx.db, &zone.model).await;
                tools = build_tools_for_zone(&ctx.db, &zone, &tool_ctx).await;
                if knowledge_available {
                    tools.push(crate::tools::knowledge::definition());
                }
                if suppress_ask_user {
                    strip_ask_user(&mut tools);
                }
                planning = apply_plan_mode(&ctx.db, chat_id, &mut tools, persp.is_some()).await;
                mcp_danger = {
                    let ids: Vec<String> =
                        serde_json::from_str(&zone.tools_enabled).unwrap_or_default();
                    crate::mcp::danger_for_ids(&ctx.db, &ids).await
                };
                zone_config = serde_json::from_str(&zone.tool_config)
                    .unwrap_or(Value::Object(Default::default()));
                inject_global_tool_config(&mut zone_config, &ctx.db, &zone.model).await;
                client =
                    LlmClient::new(&ctx.http, &provider.base_url, provider.api_key.as_deref())
                        .for_chat(chat_id);
                sink.emit_event(
                    "chat-zone-updated",
                    serde_json::json!({ "chatId": chat_id, "zoneId": zone.id }),
                );
                continue;
            }
        };

        let sink_for_emit = sink.clone();
        let chat_id_for_emit = chat_id.to_string();
        let persp_for_emit = persp_zone_id.clone();
        let mut agg = consume_stream(response, cancel.clone(), parse_inline_think, move |ev| {
            let persp = persp_for_emit.as_deref();
            match ev {
                StreamEvent::Token { delta } => {
                    sink_for_emit.emit_for(&chat_id_for_emit, persp, StreamPayload::Token { delta });
                }
                StreamEvent::ThinkingToken { delta } => {
                    sink_for_emit.emit_for(
                        &chat_id_for_emit,
                        persp,
                        StreamPayload::ThinkingToken { delta },
                    );
                }
                StreamEvent::ToolCallStart { index, name, id } => {
                    sink_for_emit.emit_for(
                        &chat_id_for_emit,
                        persp,
                        StreamPayload::ToolCallStart { index, id, name },
                    );
                }
                StreamEvent::ToolCallDeltaArgs { index, delta } => {
                    sink_for_emit.emit_for(
                        &chat_id_for_emit,
                        persp,
                        StreamPayload::ToolCallArgsDelta { index, delta },
                    );
                }
                StreamEvent::Done { .. } => {}
                StreamEvent::Error { message } => {
                    sink_for_emit.emit_for(&chat_id_for_emit, persp, StreamPayload::Error { message });
                }
            }
        })
        .await?;
        for tc in &mut agg.tool_calls {
            let canon = tools::canonical_name(&tc.function.name);
            if canon != tc.function.name {
                tc.function.name = canon.to_string();
            }
        }

        // Book the request against the chat before anything else can return
        // early. Every step of the turn re-sends the whole context, so this is
        // where the difference between "what the context costs" and "what the
        // session cost" is actually recorded — one row, one request at a time.
        crate::llm::tokens::record_request(
            &ctx.db,
            chat_id,
            &zone.model,
            &measure,
            agg.usage.as_ref(),
        )
        .await;
        last_context_tokens = agg
            .usage
            .as_ref()
            .map(|u| u.prompt_tokens)
            .filter(|n| *n > 0)
            .unwrap_or(measure.input_tokens);

        // Did this step end the turn, or did the model just stall? A step with
        // no tool calls used to end the turn unconditionally, which is how a
        // long run of file reads ended in an empty bubble and how "now opening
        // the six opportunities" ended without opening anything. Cancellation
        // and the final step are real endings and are never second-guessed.
        let stall = if agg.cancelled || agg.error.is_some() || final_step || !agg.tool_calls.is_empty() {
            Stall::None
        } else if nudges_used >= continuity::MAX_NUDGES_PER_TURN {
            // A model that keeps stalling is stuck on something re-asking won't
            // fix; let the turn end rather than burn the rest of the budget.
            Stall::None
        } else {
            continuity::classify_stall(&strip_thinking_blocks(&agg.content), used_tools_this_turn)
        };

        // A step that produced literally nothing is never written to the chat.
        // It used to be, which is where the empty assistant bubble at the end of
        // a long tool run came from. Not conditional on the stall verdict: an
        // empty bubble is noise whether or not we go on to retry. Anything the
        // model did produce — even reasoning alone — is still saved.
        let skip_persist = agg.content.trim().is_empty()
            && agg.reasoning.trim().is_empty()
            && agg.tool_calls.is_empty();
        if !skip_persist {
            produced_output = true;
        }
        if agg.cancelled {
            cancelled_turn = true;
        }

        // Persist whatever the model produced before cancellation.
        let assistant_content_json = if agg.content.is_empty() {
            "[]".to_string()
        } else {
            serde_json::to_string(&vec![ContentPart::Text {
                text: agg.content.clone(),
            }])?
        };
        let tool_calls_json = if agg.tool_calls.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&agg.tool_calls)?)
        };
        let reasoning_save = if agg.reasoning.is_empty() {
            None
        } else {
            Some(agg.reasoning.clone())
        };
        if !skip_persist {
            let now = now_ts();
            // Primary turns record the answering zone in `active_zone_id` (zone_id
            // stays NULL); perspective turns record it in `zone_id` so they're
            // filtered out of the primary conversation and grouped per-zone.
            let active_zone_col: Option<&str> =
                if persp.is_some() { None } else { Some(zone.id.as_str()) };
            sqlx::query(
                "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, created_at)
                 VALUES (?1, ?2, 'assistant', ?3, ?4, NULL, ?5, ?6, ?7, ?8)",
            )
            .bind(&assistant_msg_id)
            .bind(chat_id)
            .bind(&assistant_content_json)
            .bind(&tool_calls_json)
            .bind(&reasoning_save)
            .bind(persp)
            .bind(active_zone_col)
            .bind(now)
            .execute(&ctx.db)
            .await?;
            sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
                .bind(now)
                .bind(chat_id)
                .execute(&ctx.db)
                .await?;

            let saved = sqlx::query_as::<_, Message>(&format!(
                "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
            ))
            .bind(&assistant_msg_id)
            .fetch_one(&ctx.db)
            .await?;
            sink.emit_for(chat_id, persp, StreamPayload::AssistantSaved { message: &saved });

            // Anchor this turn's checkpoint, if it took one, to the message the
            // transcript will hang "revert what this turn did" on (0.10.1).
            // Only the first assistant message of the turn wins — a turn that
            // took five steps offers one revert, at the top, not five.
            match crate::checkpoints::link_message(
                &ctx.db,
                chat_id,
                &turn_id,
                persp,
                &assistant_msg_id,
            )
            .await
            {
                // The turn grew the store, so this is the moment to bring it
                // back under the user's ceiling. Detached: retention is
                // housekeeping and must never sit between a turn and its next
                // step, and it is best-effort in the same way a checkpoint is.
                Ok(true) => {
                    let db = ctx.db.clone();
                    tokio::spawn(async move {
                        if let Err(e) = crate::checkpoints::prune_to_settings(&db).await {
                            tracing::warn!("checkpoint prune failed: {e}");
                        }
                    });
                }
                Ok(false) => {}
                Err(e) => tracing::warn!("checkpoint message link failed: {e}"),
            }
        }

        if agg.cancelled {
            sink.emit_for(chat_id, persp, StreamPayload::Cancelled);
            return Ok(());
        }

        // The stream stopped because the transport failed, not because the model
        // finished. Deliberately placed here, immediately after cancellation and
        // *after* the persistence above: the two are the same event as far as the
        // half-answer is concerned, and the whole point of this branch is that
        // what arrived is already in the database before the turn fails.
        //
        // It used to `?` out of `consume_stream`, which meant a dropped
        // connection threw away text the user had watched appear, while pressing
        // stop kept it — an asymmetry with no visible logic, in the direction
        // where the more common case lost the data.
        if let Some(stream_error) = agg.error.clone() {
            crate::events::record(
                &ctx.db,
                chat_id,
                Some(&turn_id),
                persp,
                "stream_error",
                format!("The connection to {} dropped mid-response", zone.name),
                Some(serde_json::json!({
                    "zone": zone.name,
                    "error": stream_error,
                    "partialKept": !skip_persist,
                })),
            )
            .await;
            return Err(AppError::Provider(if skip_persist {
                format!(
                    "The connection to {} dropped before it sent anything ({stream_error}). \
                     Nothing was saved — send the message again.",
                    zone.name
                )
            } else {
                format!(
                    "The connection to {} dropped part-way through its answer \
                     ({stream_error}). What had arrived is kept above, but it is \
                     unfinished.",
                    zone.name
                )
            }));
        }

        // Push assistant turn into history. Two layers of thinking-token
        // hygiene apply here:
        //   1. `reasoning_content` (the protocol-level field for DeepSeek-R1 etc.)
        //      is never echoed back — most providers reject it in inputs.
        //   2. Inline `<think>…</think>` blocks (Qwen QwQ style) live inside
        //      `content`. We drop them by default unless the zone opts in via
        //      `include_thinking_in_context`, so long multi-step chats don't
        //      pay the token cost of replaying every reasoning trace.
        let outgoing_content = if agg.content.is_empty() {
            None
        } else if zone.include_thinking_in_context {
            Some(MessageContent::Text(agg.content.clone()))
        } else {
            let stripped = strip_thinking_blocks(&agg.content);
            if stripped.trim().is_empty() && !agg.tool_calls.is_empty() {
                // Pure-thinking turn (the model only emitted a <think> block before
                // its tool call). Send no content field rather than an empty one;
                // OpenAI-compat providers accept `tool_calls` alone.
                None
            } else {
                Some(MessageContent::Text(stripped))
            }
        };
        // A blank step is left out of the history entirely. An assistant message
        // with neither content nor tool calls is rejected outright by some
        // OpenAI-compatible providers, and replaying "the model said nothing"
        // teaches it that saying nothing is an acceptable move.
        if !skip_persist {
            api_messages.push(ChatMessage {
                role: "assistant".into(),
                content: outgoing_content,
                tool_calls: if agg.tool_calls.is_empty() {
                    None
                } else {
                    Some(agg.tool_calls.clone())
                },
                tool_call_id: None,
                name: None,
            });
        }

        if agg.tool_calls.is_empty() {
            // Genuinely finished — but if this turn edited files and the project
            // carries checks, "finished" is a claim rather than a fact (0.14.5).
            // Run them and hand the result back as one more step, so the turn
            // ends on what the checks said instead of on a paragraph that
            // contradicts the build. Once per turn: a suite re-run after every
            // repair is how thirty seconds of tests becomes the step budget.
            if stall == Stall::None && edits_landed && !checks_ran {
                checks_ran = true;
                let outcomes =
                    crate::checks::run(&ctx.db, chat_id, project_dir.as_deref()).await;
                if let Some(note) = crate::checks::note(&outcomes) {
                    let passed = outcomes.iter().all(|o| o.passed);
                    crate::events::record(
                        &ctx.db,
                        chat_id,
                        Some(&turn_id),
                        persp,
                        if passed { "checks_passed" } else { "checks_failed" },
                        crate::checks::summary(&outcomes),
                        Some(serde_json::json!({
                            "checks": outcomes
                                .iter()
                                .map(|o| serde_json::json!({
                                    "label": o.label,
                                    "command": o.command,
                                    "exitCode": o.exit_code,
                                    "passed": o.passed,
                                }))
                                .collect::<Vec<_>>(),
                        })),
                    )
                    .await;
                    push_system_note(&mut api_messages, note);
                    continue;
                }
            }
            if stall == Stall::None {
                break;
            }
            // Stalled. Ask again rather than ending a half-done task on a
            // progress note or an empty bubble.
            nudges_used += 1;
            tracing::debug!(
                "turn stalled ({stall:?}) at step {step}/{max_steps}; nudge {nudges_used}"
            );
            push_system_note(&mut api_messages, continuity::stall_nudge(stall).to_string());
            continue;
        }
        used_tools_this_turn = true;

        // If the model called ask_user, execute it (it just echoes the question),
        // emit its result so the UI can render the widget, then hand control back
        // to the human — we don't loop into another assistant turn until they reply.
        let asked_user = agg
            .tool_calls
            .iter()
            .any(|tc| tc.function.name == "ask_user");

        // A filed plan ends the turn the same way a question does: the plan is
        // now the user's to edit and approve, and anything the model said after
        // it would be arguing with a decision that hasn't been made yet.
        let filed_plan = agg
            .tool_calls
            .iter()
            .any(|tc| tc.function.name == "exit_plan_mode");

        // Execute tools, persist results, push into history. The policy is read
        // per step rather than per turn: a user watching a long run and deciding
        // halfway through to stop being asked about reads should not have to
        // start a new turn for it (0.14.2).
        let policy =
            crate::approvals::Policy::load(&ctx.db, zone.approvals.as_deref()).await;
        let approval_key = approval_key(chat_id, persp);
        // Set when this step's calls tripped loop detection. Handled after the
        // step rather than inside it, so the call that tripped it is still
        // persisted and shown — the evidence is the point.
        let mut runaway = crate::llm::runaway::Runaway::None;
        for tc in &agg.tool_calls {
            if cancel.load(Ordering::Relaxed) {
                sink.emit_for(chat_id, persp, StreamPayload::Cancelled);
                return Ok(());
            }

            // Plan mode's second lock (0.12.0). The tool was withheld from the
            // request, but a model can still name one — from its own priors, a
            // skill, or an earlier turn's transcript — and providers pass that
            // through unchanged. Refusing here means the promise "nothing
            // changes while planning" holds even then, and the model reads why
            // rather than an unexplained failure.
            if planning && !crate::plans::allowed_in_plan_mode(&tc.function.name) {
                let refusal = crate::plans::refusal(&tc.function.name);
                sink.emit_for(
                    chat_id,
                    persp,
                    StreamPayload::ToolCallResult {
                        index: 0,
                        name: tc.function.name.clone(),
                        result: refusal.clone(),
                    },
                );
                let (parts, api_content) = parse_tool_result_content(&refusal);
                let msg_id = new_id();
                sqlx::query(
                    "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, created_at)
                     VALUES (?1, ?2, 'tool', ?3, NULL, ?4, NULL, ?5, ?6)",
                )
                .bind(&msg_id)
                .bind(chat_id)
                .bind(serde_json::to_string(&parts)?)
                .bind(&tc.id)
                .bind(persp)
                .bind(now_ts())
                .execute(&ctx.db)
                .await?;
                let saved = sqlx::query_as::<_, Message>(&format!(
                    "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
                ))
                .bind(&msg_id)
                .fetch_one(&ctx.db)
                .await?;
                sink.emit_for(chat_id, persp, StreamPayload::ToolMessageSaved { message: &saved });
                api_messages.push(ChatMessage {
                    role: "tool".into(),
                    content: Some(api_content),
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                    // No `name`: the current spec keys a tool result by `tool_call_id` alone,
                    // and strict gateways (OpenCode Go) reject the legacy field outright.
                    name: None,
                });
                continue;
            }

            // Check whether this tool needs explicit user approval. MCP tools
            // carry a user-assigned danger level; built-ins use their static one.
            let tool_safety = mcp_danger
                .get(&tc.function.name)
                .copied()
                .unwrap_or_else(|| tools::tool_safety_by_name(&tc.function.name));
            let decision = policy.decide(
                &tc.function.name,
                &tc.function.arguments,
                tool_safety,
                project_dir.as_deref(),
            );

            // A denied shell prefix or edit path is refused here, on the same
            // path plan mode uses: the user already answered this question by
            // writing the rule down, and turning it into a prompt would ask it
            // again.
            if let crate::approvals::Decision::Deny { reason, rule } = &decision {
                crate::events::record(
                    &ctx.db,
                    chat_id,
                    Some(&turn_id),
                    persp,
                    "denial",
                    format!(
                        "`{}` was refused by {}",
                        tc.function.name,
                        if *rule == "editDeny" { "a path rule" } else { "a command rule" }
                    ),
                    Some(serde_json::json!({
                        "tool": tc.function.name,
                        "arguments": crate::events::summarize_args(&tc.function.arguments),
                        "rule": rule,
                    })),
                )
                .await;
                sink.emit_for(
                    chat_id,
                    persp,
                    StreamPayload::ToolCallResult {
                        index: 0,
                        name: tc.function.name.clone(),
                        result: reason.clone(),
                    },
                );
                let (parts, api_content) = parse_tool_result_content(reason);
                let msg_id = new_id();
                sqlx::query(
                    "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, created_at)
                     VALUES (?1, ?2, 'tool', ?3, NULL, ?4, NULL, ?5, ?6)",
                )
                .bind(&msg_id)
                .bind(chat_id)
                .bind(serde_json::to_string(&parts)?)
                .bind(&tc.id)
                .bind(persp)
                .bind(now_ts())
                .execute(&ctx.db)
                .await?;
                let saved = sqlx::query_as::<_, Message>(&format!(
                    "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
                ))
                .bind(&msg_id)
                .fetch_one(&ctx.db)
                .await?;
                sink.emit_for(chat_id, persp, StreamPayload::ToolMessageSaved { message: &saved });
                api_messages.push(ChatMessage {
                    role: "tool".into(),
                    content: Some(api_content),
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                    // No `name`: the current spec keys a tool result by `tool_call_id` alone,
                    // and strict gateways (OpenCode Go) reject the legacy field outright.
                    name: None,
                });
                continue;
            }

            let needs_approval = decision == crate::approvals::Decision::Ask;

            let answer = if needs_approval {
                let (tx, rx) = oneshot::channel::<ApprovalAnswer>();

                // What this call would actually do to the file, as a diff
                // (0.10.2). `None` for every tool that isn't a content write —
                // and best-effort, because failing to render a preview must
                // never be the reason a tool can't be approved.
                let diff = crate::review::preview(
                    &ctx.db,
                    chat_id,
                    &tc.function.name,
                    &tc.function.arguments,
                    project_dir.as_deref(),
                )
                .await
                .unwrap_or(None);

                // Registered before it is announced, so the queue a remote
                // client reads can never be missing a call the stream has
                // already told it about.
                ctx.tool_approvals.lock().await.insert(
                    approval_key.clone(),
                    PendingApproval {
                        chat_id: chat_id.to_string(),
                        zone_id: persp.map(str::to_string),
                        tool: tc.function.name.clone(),
                        arguments: tc.function.arguments.clone(),
                        diff: diff.clone(),
                        requested_at: now_ts(),
                        responder: tx,
                    },
                );

                sink.emit_for(chat_id, persp, StreamPayload::ToolApprovalRequired {
                    index: 0,
                    name: tc.function.name.clone(),
                    arguments: tc.function.arguments.clone(),
                    diff,
                });

                let result = tokio::time::timeout(
                    tokio::time::Duration::from_secs(APPROVAL_TIMEOUT_SECS),
                    rx,
                )
                .await
                .unwrap_or(Ok(ApprovalAnswer::denied()))
                .unwrap_or(ApprovalAnswer::denied());

                ctx.tool_approvals.lock().await.remove(&approval_key);
                result
            } else {
                ApprovalAnswer { approved: true, hunks: None }
            };
            let approved = answer.approved;

            // Approving part of a diff rewrites the call to exactly the content
            // the user agreed to, so a rejected hunk is a real outcome rather
            // than a preference we recorded and then ignored. The tool's *name*
            // is left alone — history, checkpoints and the usage counters all
            // key on it.
            let call_arguments = match &answer.hunks {
                Some(hunks) => narrowed_arguments(
                    &ctx.db,
                    chat_id,
                    &tc.function.name,
                    &tc.function.arguments,
                    project_dir.as_deref(),
                    hunks,
                )
                .await,
                None => tc.function.arguments.clone(),
            };

            let result = if approved {
                sink.emit_for(
                    chat_id,
                    persp,
                    StreamPayload::ToolCallExecuting {
                        index: 0,
                        name: tc.function.name.clone(),
                    },
                );
                let out = tools::dispatch(
                    &tc.function.name,
                    &call_arguments,
                    &zone_config,
                    &ctx.db,
                    chat_id,
                    &turn_id,
                    project_dir.as_deref(),
                    &ctx.http,
                    ctx,
                    sink,
                    Some(zone.id.as_str()),
                )
                .await
                .unwrap_or_else(|e| {
                    serde_json::json!({ "error": e.to_string() }).to_string()
                });
                // Continue this turn's citation numbering. A no-op for every
                // tool that doesn't return refs.
                tools::citations::renumber_refs(out, &mut next_citation_ref)
            } else {
                serde_json::json!({
                    "error": "Tool execution denied by user.",
                    "error_kind": "denied"
                })
                .to_string()
            };

            let failed = crate::commands::tool_usage::result_is_error(&result);

            // Loop detection (0.14.1). A denied call is not evidence of a stuck
            // agent — the user is the one saying no, and three refusals in a row
            // is a conversation, not a runaway.
            if approved && runaway == crate::llm::runaway::Runaway::None {
                runaway = loop_guard.observe(&tc.function.name, &call_arguments, &result, failed);
            }

            crate::events::record(
                &ctx.db,
                chat_id,
                Some(&turn_id),
                persp,
                if !approved {
                    "denial"
                } else if failed {
                    "tool_error"
                } else {
                    "tool_call"
                },
                if !approved {
                    format!("You declined `{}`", tc.function.name)
                } else if failed {
                    format!("`{}` failed", tc.function.name)
                } else {
                    format!("Ran `{}`", tc.function.name)
                },
                Some(serde_json::json!({
                    "tool": tc.function.name,
                    "arguments": crate::events::summarize_args(&call_arguments),
                    "approvalRequired": needs_approval,
                })),
            )
            .await;
            if approved && !failed && crate::events::is_file_mutation(&tc.function.name) {
                // What makes the project's checks worth running at the end of
                // this turn (0.14.5) — a turn that only read things has nothing
                // for them to say anything about.
                edits_landed = true;
                crate::events::record(
                    &ctx.db,
                    chat_id,
                    Some(&turn_id),
                    persp,
                    "file_change",
                    format!(
                        "{} {}",
                        match tc.function.name.as_str() {
                            "write" => "Wrote",
                            "edit" => "Edited",
                            "delete_file" => "Deleted",
                            "move_file" => "Moved",
                            "copy_file" => "Copied",
                            _ => "Created",
                        },
                        serde_json::from_str::<Value>(&call_arguments)
                            .ok()
                            .and_then(|v| v
                                .get("path")
                                .or_else(|| v.get("from"))
                                .and_then(|p| p.as_str())
                                .map(str::to_string))
                            .unwrap_or_else(|| "a file".to_string()),
                    ),
                    Some(crate::events::summarize_args(&call_arguments)),
                )
                .await;
            }

            // Usage counters (0.9.3), so the zone editor can show which tools a
            // zone actually reaches for and which keep failing. Best-effort: a
            // failed counter write never affects the turn. A denied approval
            // counts as an error, which is the honest reading — the call didn't
            // do what the model asked for.
            crate::commands::tool_usage::record(
                &ctx.db,
                &zone.id,
                &tc.function.name,
                crate::commands::tool_usage::result_is_error(&result),
            )
            .await;

            // The tag tool mutates tags/chat_tags — tell the UI to refresh.
            if tc.function.name == "tag_chat" {
                sink.emit_event(
                    "chat-tags-updated",
                    serde_json::json!({ "chatId": chat_id }),
                );
            }
            // The memory tools mutate the memories table — refresh the viewer.
            if matches!(tc.function.name.as_str(), "save_memory" | "delete_memory") {
                sink.emit_event(
                    "memory-updated",
                    serde_json::json!({ "chatId": chat_id }),
                );
            }

            sink.emit_for(
                chat_id,
                persp,
                StreamPayload::ToolCallResult {
                    index: 0,
                    name: tc.function.name.clone(),
                    result: result.clone(),
                },
            );

            // Detect image content-parts arrays returned by read_file with as_image.
            // When the result is a JSON array of ContentParts, store it as-is and
            // send it to the model as multi-part content so VLLMs receive the image.
            let (tool_content_parts, api_content) =
                parse_tool_result_content(&result);

            let tool_msg_id = new_id();
            let tnow = now_ts();
            let tool_content_json = serde_json::to_string(&tool_content_parts)?;
            // Tag perspective tool messages with their zone so they group under
            // the right participant and stay out of the primary conversation.
            sqlx::query(
                "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, created_at)
                 VALUES (?1, ?2, 'tool', ?3, NULL, ?4, NULL, ?5, ?6)",
            )
            .bind(&tool_msg_id)
            .bind(chat_id)
            .bind(&tool_content_json)
            .bind(&tc.id)
            .bind(persp)
            .bind(tnow)
            .execute(&ctx.db)
            .await?;

            let saved_tool = sqlx::query_as::<_, Message>(&format!(
                "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
            ))
            .bind(&tool_msg_id)
            .fetch_one(&ctx.db)
            .await?;
            sink.emit_for(chat_id, persp, StreamPayload::ToolMessageSaved { message: &saved_tool });

            api_messages.push(ChatMessage {
                role: "tool".into(),
                content: Some(api_content),
                tool_calls: None,
                tool_call_id: Some(tc.id.clone()),
                // No `name`: the current spec keys a tool result by `tool_call_id` alone,
                // and strict gateways (OpenCode Go) reject the legacy field outright.
                name: None,
            });

            // Path-triggered rules (0.14.5). A directory deeper in the tree can
            // carry its own `AGENTS.md` — `src/generated/` saying "never edit
            // these by hand" is the common one — and those rules become relevant
            // exactly when a file under them is opened. Delivered here rather
            // than in the base prompt, because a repository's every
            // directory-specific rule up front is context spent on folders the
            // turn never visits.
            if approved && !failed && project_instructions {
                if let Some(note) = crate::instructions::triggered(
                    &tc.function.name,
                    &call_arguments,
                    project_dir.as_deref(),
                    &mut instructions_seen,
                ) {
                    crate::events::record(
                        &ctx.db,
                        chat_id,
                        Some(&turn_id),
                        persp,
                        "instructions",
                        "Read this directory's own instructions".to_string(),
                        Some(serde_json::json!({
                            "tool": tc.function.name,
                            "arguments": crate::events::summarize_args(&call_arguments),
                        })),
                    )
                    .await;
                    push_system_note(&mut api_messages, note);
                }
            }

            // Nothing further from a step that has already been judged a loop.
            // The remaining calls of this step are the same loop continuing.
            if runaway.is_some() {
                break;
            }
        }

        // A runaway turn (0.14.1) ends the way an out-of-steps turn does: one
        // more step with the tools withheld, so the model has to say what it was
        // doing and why it could not finish. A hard abort would be cheaper by one
        // request and much worse — it leaves the user with a stopped run and no
        // sentence, and it leaves a background sub-agent's parent with nothing at
        // all, since what the parent reads is the sub-agent's last message.
        if runaway.is_some() {
            tracing::info!("runaway stopped at step {step}/{max_steps}: {}", runaway.label());
            crate::events::record(
                &ctx.db,
                chat_id,
                Some(&turn_id),
                persp,
                "runaway",
                runaway.label(),
                Some(serde_json::json!({ "kind": runaway.kind() })),
            )
            .await;
            sink.emit_for(
                chat_id,
                persp,
                StreamPayload::Runaway {
                    kind: runaway.kind(),
                    label: runaway.label(),
                },
            );
            // Raised to the parent when this is a sub-agent. A background one is
            // the case that matters: nobody is watching its stream, its wrap-up
            // lands in a transcript nobody has open, and the leader would
            // otherwise collect a plausible-sounding paragraph with no sign that
            // the run behind it went nowhere.
            if let Some(parent_id) = subchat_parent(&ctx.db, chat_id).await {
                crate::events::record(
                    &ctx.db,
                    &parent_id,
                    None,
                    None,
                    "runaway",
                    format!("Sub-agent {} — {}", zone.name, runaway.label().to_lowercase()),
                    Some(serde_json::json!({
                        "kind": runaway.kind(),
                        "subchatId": chat_id,
                        "zone": zone.name,
                    })),
                )
                .await;
                sink.emit_for(
                    &parent_id,
                    None,
                    StreamPayload::Runaway {
                        kind: runaway.kind(),
                        label: format!("{} — {}", zone.name, runaway.label().to_lowercase()),
                    },
                );
            }
            push_system_note(&mut api_messages, runaway.note());
            stop_after_step = true;
        }

        if asked_user || filed_plan {
            break;
        }

        // "Finish this step, then stop" (0.12.1). Honoured here, at the step
        // boundary, which is the whole point of it: cancelling mid-call throws
        // away the work in flight, and the user asking to stop after step three
        // of eight is not asking for step three to be lost. Withholding the
        // tools for one more step is what turns the loop into a wrap-up — the
        // same mechanism the step budget uses to guarantee prose at the end.
        if let Some(plan) = crate::plans::active_plan(&ctx.db, chat_id, persp).await {
            if plan.stop_requested {
                crate::plans::clear_stop(&ctx.db, &plan.id).await.ok();
                crate::plans::set_status(&ctx.db, &plan.id, "stopped").await.ok();
                push_system_note(
                    &mut api_messages,
                    "The user has asked you to stop after the current step. Do not start                      another step or call another tool. Report what you finished, what you                      did not, and what the next person picking this up needs to know."
                        .to_string(),
                );
                stop_after_step = true;
            }
        }

        // `enter_plan_mode` (or a plan approved out from under this turn) may
        // have moved the chat since the toolset was built. Rebuilding here is
        // what makes the mode take effect from the *next* step rather than only
        // on the next turn.
        let planning_now = crate::plans::in_plan_mode(&ctx.db, chat_id).await;
        if planning_now != planning {
            tools = build_tools_for_zone(&ctx.db, &zone, &tool_ctx).await;
            if knowledge_available {
                tools.push(crate::tools::knowledge::definition());
            }
            if suppress_ask_user {
                strip_ask_user(&mut tools);
            }
            planning = apply_plan_mode(&ctx.db, chat_id, &mut tools, persp.is_some()).await;
        }

        // A tool may have switched the chat's primary zone (`change_zone`). If so,
        // reload the zone/provider/tools and continue the loop under the new zone.
        // Only the primary in plain Zone mode switches; perspectives and
        // Smart/Simple turns hold their resolved zone for the whole turn.
        let latest_zone_id = if !allow_zone_switch {
            None
        } else {
            sqlx::query_scalar::<_, Option<String>>("SELECT zone_id FROM chats WHERE id = ?1")
                .bind(chat_id)
                .fetch_optional(&ctx.db)
                .await?
                .flatten()
        };

        if let Some(new_zone_id) = latest_zone_id {
            if Some(&new_zone_id) != current_zone_id.as_ref() {
                // If reloading fails (e.g. the new zone lacks a provider), keep
                // going on the current zone rather than aborting the turn.
                match load_zone_and_provider(&ctx.db, &new_zone_id).await {
                    Ok((new_zone, new_provider)) => {
                        current_zone_id = Some(new_zone_id.clone());
                        zone = new_zone;
                        provider = new_provider;
                        tool_ctx.vision_capable =
                            model_vision_capable(&ctx.db, &zone.model).await;
                        tools = build_tools_for_zone(&ctx.db, &zone, &tool_ctx).await;
                        if knowledge_available {
                            tools.push(crate::tools::knowledge::definition());
                        }
                        if suppress_ask_user {
                            strip_ask_user(&mut tools);
                        }
                        planning = apply_plan_mode(&ctx.db, chat_id, &mut tools, persp.is_some()).await;
                        mcp_danger = {
                            let ids: Vec<String> =
                                serde_json::from_str(&zone.tools_enabled).unwrap_or_default();
                            crate::mcp::danger_for_ids(&ctx.db, &ids).await
                        };
                        zone_config = serde_json::from_str(&zone.tool_config)
                            .unwrap_or(Value::Object(Default::default()));
                        inject_global_tool_config(&mut zone_config, &ctx.db, &zone.model).await;
                        client = LlmClient::new(
                            &ctx.http,
                            &provider.base_url,
                            provider.api_key.as_deref(),
                        )
                        .for_chat(chat_id);
                        sink.emit_event(
                            "chat-zone-updated",
                            serde_json::json!({ "chatId": chat_id, "zoneId": new_zone_id }),
                        );
                        crate::events::record(
                            &ctx.db,
                            chat_id,
                            Some(&turn_id),
                            persp,
                            "zone_switch",
                            format!("Switched to {}", zone.name),
                            Some(serde_json::json!({ "zoneId": new_zone_id, "model": zone.model })),
                        )
                        .await;
                    }
                    Err(e) => {
                        tracing::warn!("zone switch to {new_zone_id} failed: {e}");
                    }
                }
            }
        }
        // Loop for follow-up assistant turn
    }

    // A turn that produced no text, no reasoning and no tool call writes nothing
    // to the chat (see `skip_persist`), so ending quietly here is indistinguish-
    // able from the app ignoring the user: message sent, nothing back, nothing
    // to click. Some providers do this on a bad model name, an empty context, or
    // a silently truncated response. Report it rather than leaving a blank.
    if !produced_output && !cancelled_turn {
        return Err(AppError::Provider(
            "The model returned an empty response — no text and no tool calls. \
             This often means the model name is wrong for this provider, or the \
             request was rejected without an error."
                .to_string(),
        ));
    }

    crate::events::record(
        &ctx.db,
        chat_id,
        Some(&turn_id),
        persp,
        if cancelled_turn { "cancelled" } else { "turn_end" },
        if cancelled_turn { "You stopped the turn" } else { "Turn finished" },
        None,
    )
    .await;

    sink.emit_for(chat_id, persp, StreamPayload::Done);

    // Harness-driven compaction (0.18). After the turn, not during it: the
    // summary sees the whole exchange, and the next turn is the first to send
    // it. Primary conversation only — perspectives and multi-model chats never
    // read the compacted prefix (see `build_message_history`).
    if !cancelled_turn && persp.is_none() && !is_multi_model(&ctx.db, chat_id).await {
        let window = crate::tools::compact::context_window_tokens(&ctx.db).await;
        if crate::tools::compact::should_compact(last_context_tokens, window) {
            match crate::tools::compact::auto_compact(&ctx.db, &ctx.http, chat_id, &zone, &provider).await {
                Ok(Some(n)) => {
                    crate::events::record(
                        &ctx.db,
                        chat_id,
                        Some(&turn_id),
                        None,
                        "compacted",
                        format!("Condensed {n} earlier messages to stay inside the context window"),
                        Some(serde_json::json!({ "messages": n, "contextTokens": last_context_tokens, "window": window })),
                    )
                    .await;
                    sink.notify_chats_changed();
                }
                Ok(None) => {}
                Err(e) => tracing::warn!("auto-compaction failed for {chat_id}: {e}"),
            }
        }
    }
    Ok(())
}

/// Resolves the effective perspective execution mode for a chat:
/// per-chat override → global `perspectiveMode` app setting → `"parallel"`.
async fn resolve_perspective_mode(db: &SqlitePool, chat_id: &str) -> String {
    let chat_mode: Option<String> = match sqlx::query_scalar::<_, Option<String>>(
        "SELECT perspective_mode FROM chats WHERE id = ?1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await
    {
        Ok(Some(inner)) => inner,
        _ => None,
    };
    if let Some(m) = chat_mode {
        if m == "sequential" || m == "parallel" {
            return m;
        }
    }

    // Global default lives in the app_settings JSON blob (same place the
    // filesystem default directory is read from).
    let global = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'app_settings'",
    )
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    .and_then(|v| {
        v.get("perspectiveMode")
            .and_then(|m| m.as_str())
            .map(String::from)
    });

    // Parallel is the default (0.9.9): running every zone at once is how a
    // multi-model chat is normally used. Sequential stays opt-in for local
    // models that can't hold several loads in VRAM at the same time.
    match global.as_deref() {
        Some("sequential") => "sequential".to_string(),
        _ => "parallel".to_string(),
    }
}

/// Perspective-zone wrapper: loads the fixed zone and runs the shared agentic
/// loop. Perspectives get the same tool use as the primary; they just can't
/// switch zones mid-turn and stream on their own per-zone channel.
async fn run_perspective(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    zone_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    let (zone, provider) = load_zone_and_provider(&ctx.db, zone_id).await?;
    let participant = TurnParticipant {
        zone,
        provider,
        persp_zone_id: Some(zone_id.to_string()),
        allow_zone_switch: false,
        // A perspective zone answers the user's own message, never a leader's.
        agent_driven: false,
    };
    run_participant_turn(ctx, sink, chat_id, participant, cancel).await
}

// ─── Message history ──────────────────────────────────────────────────────────

/// A labelled piece of the system prompt.
///
/// The turn only needs the joined text, but the context meter needs to say
/// *why* a chat is 12k in the hole before the user has typed anything — a fat
/// skills catalog, a leader's roster, memories that have piled up. One opaque
/// number can't be acted on; "Skills catalog 4.1k" can.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
///
/// Declaration order is also emission order, and it is chosen deliberately:
/// most-stable first, most-volatile last. See `build_system_snippets`.
pub enum SnippetKind {
    ZonePrompt,
    /// The project's own `AGENTS.md` / `CLAUDE.md` (0.14.5).
    ProjectInstructions,
    Continuity,
    /// What a tooled zone with no prompt of its own is told (0.18).
    DefaultRules,
    /// Where the tools act: working directory, platform, date (0.18).
    Env,
    Skills,
    Knowledge,
    /// The ranked map of what this project defines (0.14.5).
    RepoMap,
    ProjectContext,
    TagContext,
    Leader,
    Identity,
    Memory,
    /// Plan mode is on: what planning means and how to end it (0.12.0).
    PlanMode,
    /// The plan the user approved, as this turn's task list (0.12.0).
    TaskList,
    /// Planning is available but off: what it is for, and when to reach for it
    /// (0.14.6).
    PlanOffer,
}

impl SnippetKind {
    /// Label shown in the context meter's breakdown.
    pub fn label(self) -> &'static str {
        match self {
            Self::ProjectContext => "Project context",
            Self::TagContext => "Tag context",
            Self::Skills => "Skills catalog",
            Self::Knowledge => "Knowledge index",
            Self::RepoMap => "Repository map",
            Self::ZonePrompt => "Zone prompt",
            Self::ProjectInstructions => "Project instructions",
            Self::Continuity => "Agent-loop preamble",
            Self::DefaultRules => "Default rules",
            Self::Env => "Environment",
            Self::Leader => "Sub-agent roster",
            Self::Memory => "Memories",
            Self::Identity => "Multi-zone identity",
            Self::PlanMode => "Plan mode",
            Self::TaskList => "Approved plan",
            Self::PlanOffer => "Planning available",
        }
    }
}

/// True when this chat has (or has had) perspective zones, so its history is
/// built as a shared multi-model transcript.
async fn is_multi_model(db: &SqlitePool, chat_id: &str) -> bool {
    let zones: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_zones WHERE chat_id = ?1")
        .bind(chat_id)
        .fetch_one(db)
        .await
        .unwrap_or(0);
    if zones > 0 {
        return true;
    }
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM messages WHERE chat_id = ?1 AND zone_id IS NOT NULL",
    )
    .bind(chat_id)
    .fetch_one(db)
    .await
    .unwrap_or(0)
        > 0
}

/// Everything prepended to a chat's history as its system message, labelled by
/// what put it there.
///
/// Extracted so the context meter measures the same bytes the turn sends: a
/// meter with its own idea of what the system prompt contains is a meter that
/// goes stale the first time either side changes.
/// See `SnippetKind::DefaultRules`.
pub const DEFAULT_RULES: &str = "# Working in a codebase\n\
- Match the surrounding code's style and use the libraries the project already uses; check \
  before assuming one is available.\n\
- Prefer editing existing files to creating new ones. No documentation or README files \
  unless asked.\n\
- Verify with the project's own test, build and lint commands when they exist, and report \
  the real output, including failures.\n\
- Never commit, push or open a pull request unless asked.\n\
- Be concise. Refer to code as `path:line`.";

/// The `<env>` block: working directory and how paths are written, platform,
/// and today's date. The date is bucketed to the day, so the prefix cache is
/// lost once at midnight rather than on every turn.
pub fn env_block(project_dir: Option<&str>) -> String {
    let mut lines = vec!["<env>".to_string()];
    match project_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => {
            let dir = dir.trim_end_matches(['/', '\\']);
            let sep = if dir.contains('\\') { '\\' } else { '/' };
            lines.push(format!("  Working directory: {dir}"));
            lines.push(format!(
                "  Paths: write them relative to the working directory (`notes.md`, \
                 `docs{sep}notes.md`); a leading `/` or `~` is read as relative to it too. \
                 An absolute path works only inside it; anywhere else on disk is refused."
            ));
        }
        None => lines.push(
            "  Working directory: none set — paths resolve against the zone's allowed roots."
                .to_string(),
        ),
    }
    lines.push(format!("  Platform: {}", std::env::consts::OS));
    lines.push(format!("  Today's date: {}", chrono::Local::now().format("%Y-%m-%d")));
    lines.push("</env>".to_string());
    lines.join("\n")
}

pub async fn build_system_snippets(
    db: &SqlitePool,
    chat_id: &str,
    zone: &Zone,
    chat: Option<&Chat>,
    // `is_perspective`: this participant is one of several answering the same
    // question. It is not offered `enter_plan_mode` (see `apply_plan_mode`), so
    // it must not be told about it either.
    is_perspective: bool,
) -> AppResult<Vec<(SnippetKind, String)>> {
    let mut snippets: Vec<(SnippetKind, String)> = Vec::new();

    // ── Ordering: most stable first, most volatile last ──────────────────────
    //
    // These are joined into one system message at the front of the request, and
    // prefix caches (DeepSeek, OpenAI, and every vLLM/SGLang-style local server)
    // match on a byte-exact prefix: the cache is valid up to the first byte that
    // differs and no further. A volatile snippet near the front therefore costs
    // the cache for the entire conversation behind it, not just for itself.
    //
    // So the pieces that never move within a session go first (zone prompt,
    // agent-loop preamble, skills catalog), the ones that change when the user
    // fiddles with a chat go next (project/tag context, roster, identity), and
    // the ones that can change on any turn go last (memory).
    // Reordering is free to do here because nothing downstream depends on the
    // order — the context meter labels each piece independently.

    // The zone's own prompt is the most stable thing in the request and the
    // primary instruction, so it leads.
    if let Some(sys) = &zone.system_prompt {
        if !sys.trim().is_empty() {
            snippets.push((SnippetKind::ZonePrompt, sys.clone()));
        }
    }

    let zone_tool_ids: Vec<String> = serde_json::from_str(&zone.tools_enabled).unwrap_or_default();

    // A zone with tools but no prompt (0.18). The shipped zones carry their
    // working rules in their own prompts; a blank custom zone used to get the
    // loop preamble and nothing about conventions, committing or verbosity.
    // This is opencode's substance at pi's length, and it steps aside the
    // moment the user writes a prompt of their own.
    let has_own_prompt = zone.system_prompt.as_deref().map_or(false, |p| !p.trim().is_empty());
    if !zone_tool_ids.is_empty() && !has_own_prompt {
        snippets.push((SnippetKind::DefaultRules, DEFAULT_RULES.to_string()));
    }

    // The project's own `AGENTS.md` / `CLAUDE.md` (0.14.5) — second only to the
    // zone prompt, because it is the same kind of thing (standing instructions
    // that do not move within a session) and belongs in front of everything
    // that describes machinery.
    //
    // Gated on the zone having tools, for the same reason the loop preamble is:
    // a zone that cannot touch the project is being told how to work in a
    // repository it will never open. Gated again on the app setting, since this
    // is a file the app reads on its own initiative and switching that off has
    // to be possible without moving the file.
    if !zone_tool_ids.is_empty() && project_instructions_enabled(db).await {
        if let Ok(Some(dir)) = resolve_working_dir(db, chat_id).await {
            let dir = dir.trim().to_string();
            if !dir.is_empty() {
                if let Some(block) = crate::instructions::block(std::path::Path::new(&dir)) {
                    snippets.push((SnippetKind::ProjectInstructions, block));
                }
            }
        }
    }

    // How the agentic loop works (0.9.6). A model that doesn't know it will be
    // called again after a tool result has every reason to stop and wait for the
    // user — which is exactly what stalls a long task halfway through. Only
    // zones that actually have tools get this; for the rest it's noise.
    if !zone_tool_ids.is_empty() {
        snippets.push((
            SnippetKind::Continuity,
            crate::llm::continuity::multi_step_preamble(
                max_tool_steps(db).await,
                zone_tool_ids.iter().any(|t| t == "plan"),
            ),
        ));
    }

    // The environment (0.18): where paths resolve, said once. It used to be a
    // `PATHS:` paragraph in every file tool's description — eleven copies on a
    // team lead — which is where opencode's `<env>` block and pi's `<cwd>`
    // section put it instead. Only zones with tools have anywhere to act.
    if !zone_tool_ids.is_empty() {
        let dir = resolve_working_dir(db, chat_id).await.ok().flatten();
        snippets.push((SnippetKind::Env, env_block(dir.as_deref())));
    }

    // Plan mode and its aftermath (0.12.0), directly after the loop preamble
    // because both change what the rest of the turn is *for*. They are mutually
    // exclusive by construction: approving a plan is what clears the mode.
    if chat.map_or(false, |c| c.plan_mode) {
        snippets.push((SnippetKind::PlanMode, crate::plans::plan_mode_preamble()));
    } else if let Some(plan) = crate::plans::active_plan(db, chat_id, None).await {
        snippets.push((SnippetKind::TaskList, crate::plans::task_list_block(&plan)));
    } else if !zone_tool_ids.is_empty() && !is_perspective {
        // Planning is available and off (0.14.6). Saying so is the fix for the
        // mode's real failure — not misuse but disuse. It lived entirely in one
        // tool description among twenty, while the loop preamble just above
        // pointed at `update_plan` for multi-step work, so "plan this for me"
        // reliably produced a numbered list in prose that nobody could edit or
        // approve. Matches the condition `apply_plan_mode` offers the tool on
        // (a zone with tools), so the prompt never advertises a tool that is
        // not in the request.
        snippets.push((SnippetKind::PlanOffer, crate::plans::plan_offer_preamble()));
    }

    // Skills catalog (Anthropic Agent Skills model): when this zone has the
    // skills tool, list every enabled skill's name + description so the model
    // knows what it can load on demand via `load_skill`. The full content is not
    // injected — the agent requests it only when a request matches.
    if zone_tool_ids.iter().any(|t| t == "skills") {
        if let Some(catalog) = crate::tools::skills::build_catalog(db).await? {
            snippets.push((SnippetKind::Skills, catalog));
        }
    }

    // Knowledge index (0.4.3, told to the model at 1.0). Gated exactly as the
    // `search_local_files` tool is — the chat opted in and its scope has a
    // non-empty index — so the prompt can never advertise a tool the turn does
    // not actually offer, or stay silent about one it does.
    if let Some(c) = chat {
        if c.knowledge_enabled {
            let scope = c
                .project_id
                .clone()
                .unwrap_or_else(|| crate::knowledge::GLOBAL_KB_ID.to_string());
            if crate::knowledge::has_index(db, &scope).await {
                if let Some(block) = crate::knowledge::build_knowledge_block(db, &scope).await {
                    snippets.push((SnippetKind::Knowledge, block));
                }
            }
        }
    }

    // The repository map (0.14.5): what this project defines, ranked by how
    // much of the rest of it depends on each thing. Offered to zones with tools
    // for the same reason as the project's instructions — a zone that cannot
    // open a file has no use for a map of one.
    if !zone_tool_ids.is_empty() {
        let budget = repo_map_tokens(db).await;
        if budget > 0 {
            if let Ok(Some(dir)) = resolve_working_dir(db, chat_id).await {
                let dir = dir.trim().to_string();
                if !dir.is_empty() {
                    if let Some(map) =
                        crate::repomap::cached(db, std::path::Path::new(&dir), budget).await
                    {
                        snippets.push((SnippetKind::RepoMap, map.text));
                    }
                }
            }
        }
    }

    if let Some(c) = chat {
        // Project context
        if c.project_context_enabled {
            if let Some(ref pid) = c.project_id {
                let snippet: Option<String> = sqlx::query_scalar(
                    "SELECT context_snippet FROM projects WHERE id = ?1",
                )
                .bind(pid)
                .fetch_optional(db)
                .await?
                .flatten();
                if let Some(s) = snippet {
                    if !s.trim().is_empty() {
                        snippets.push((SnippetKind::ProjectContext, s));
                    }
                }
            }
        }
        // Enabled tag contexts
        let tag_snippets: Vec<String> = sqlx::query_scalar(
            "SELECT t.context_snippet FROM tags t
             JOIN chat_tags ct ON ct.tag_id = t.id
             WHERE ct.chat_id = ?1 AND ct.context_enabled = 1
               AND t.context_snippet IS NOT NULL AND t.context_snippet != ''
             ORDER BY t.name",
        )
        .bind(&c.id)
        .fetch_all(db)
        .await?;
        snippets.extend(
            tag_snippets
                .into_iter()
                .map(|s| (SnippetKind::TagContext, s)),
        );
    }

    // Response Leader orchestration preamble (0.6.0): when this zone coordinates
    // sub-agents, inject the delegation protocol and the session's sub-agent
    // roster so the leader knows which zones it can spawn.
    if zone.is_leader {
        if let Some(block) = build_leader_preamble(db, chat_id, zone).await? {
            snippets.push((SnippetKind::Leader, block));
        }
    }

    // In a multi-zone chat, tell this model which participant it is (and who the
    // others are) so it can read the labelled transcript correctly and answer as
    // itself on this turn.
    if is_multi_model(db, chat_id).await {
        if let Some(identity) = build_identity_preamble(db, chat_id, chat, zone).await? {
            snippets.push((SnippetKind::Identity, identity));
        }
    }

    // Long-term memory (global → project → chat), injected each turn. Late,
    // because the agent can write a memory mid-session and everything after this
    // point loses its cache when it does.
    if let Some(block) = crate::tools::memory::build_memory_block(db, chat_id).await? {
        snippets.push((SnippetKind::Memory, block));
    }

    Ok(snippets)
}

/// What a turn in this chat costs before anyone says anything: the system
/// prompt it will be sent, and the tool schemas offered alongside it.
pub struct TurnOverhead {
    /// The system prompt, in the pieces that make it up.
    pub snippets: Vec<(SnippetKind, String)>,
    /// The tool definitions exactly as they go on the wire — the schemas are
    /// most of what a well-equipped zone carries, and they are re-sent on every
    /// single step, not once per turn.
    pub tools_json: String,
    pub tool_count: usize,
}

/// Measure a chat's fixed per-turn cost without running anything.
///
/// Built from the same functions the turn uses, so it can't drift from what is
/// actually sent. A chat whose zone or provider no longer resolves reports no
/// overhead rather than failing — the meter is a readout, not a gate.
pub async fn turn_overhead(db: &SqlitePool, chat_id: &str) -> AppResult<TurnOverhead> {
    let Ok((zone, _provider)) = effective_zone_and_provider(db, chat_id).await else {
        return Ok(TurnOverhead { snippets: Vec::new(), tools_json: String::new(), tool_count: 0 });
    };

    let chat = sqlx::query_as::<_, crate::db::models::Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(chat_id)
    .fetch_optional(db)
    .await?;
    let snippets = build_system_snippets(db, chat_id, &zone, chat.as_ref(), false).await?;

    let tool_ctx = load_tool_context(db, Some(chat_id), Some(&zone.model)).await;
    let mut tools = build_tools_for_zone(db, &zone, &tool_ctx).await;
    // Project knowledge is offered independently of the zone's toolset, so it
    // is appended after the build here exactly as it is in the turn.
    if chat.as_ref().map_or(false, |c| c.knowledge_enabled) {
        let scope = chat
            .as_ref()
            .and_then(|c| c.project_id.clone())
            .unwrap_or_else(|| crate::knowledge::GLOBAL_KB_ID.to_string());
        if crate::knowledge::has_index(db, &scope).await {
            tools.push(crate::tools::knowledge::definition());
        }
    }

    Ok(TurnOverhead {
        tools_json: serde_json::to_string(&tools).unwrap_or_default(),
        tool_count: tools.len(),
        snippets,
    })
}

pub(crate) async fn build_message_history(
    db: &SqlitePool,
    chat_id: &str,
    zone: &Zone,
    is_perspective: bool,
) -> AppResult<Vec<ChatMessage>> {
    let chat = sqlx::query_as::<_, crate::db::models::Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(chat_id)
    .fetch_optional(db)
    .await?;

    let snippets = build_system_snippets(db, chat_id, zone, chat.as_ref(), is_perspective).await?;
    let multi_model = is_multi_model(db, chat_id).await;

    let mut out: Vec<ChatMessage> = Vec::new();
    if !snippets.is_empty() {
        let joined = snippets
            .iter()
            .map(|(_, s)| s.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        out.push(ChatMessage {
            role: "system".into(),
            content: Some(MessageContent::Text(joined)),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        });
    }

    if multi_model {
        build_multi_model_history(db, chat_id, chat.as_ref(), &mut out).await?;
        return Ok(out);
    }

    // ── Single-zone history ───────────────────────────────────────────────────
    // Exclude perspective messages (zone_id IS NOT NULL) from the history sent
    // to any zone so they never pollute the primary conversation context.
    //
    // Context compaction (0.9.3): if the model has summarized this chat's older
    // turns, those turns are replaced here by the summary. `created_at > cutoff`
    // drops them from the request only — they remain in the DB and on screen.
    let mut rows = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE chat_id = ?1 AND zone_id IS NULL ORDER BY created_at ASC"
    ))
    .bind(chat_id)
    .fetch_all(db)
    .await?;

    if let Some((summary_block, cutoff)) = crate::tools::compact::compacted_prefix(db, chat_id).await {
        let before = rows.len();
        rows.retain(|m| m.created_at > cutoff);
        // Only claim the compaction if it actually elided something; a cutoff
        // older than every surviving message would otherwise inject a summary
        // alongside the very turns it summarizes.
        if rows.len() < before {
            out.push(ChatMessage {
                role: "system".into(),
                content: Some(MessageContent::Text(summary_block)),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            });
        }
    }

    // A tool result whose call is no longer in the history is fatal, not
    // cosmetic: the provider rejects the whole request ("Messages with role
    // 'tool' must be a response to a preceding message with 'tool_calls'"), so
    // one orphan ends every remaining turn in the chat. Anything that removes a
    // message can leave one behind — a compaction cutoff, a deleted turn — so
    // the guard lives here, at the one point every request is assembled, rather
    // than next to any single cause.
    drop_orphan_tool_messages(&mut rows);

    // Images are sent at full detail for the whole conversation.
    //
    // Earlier turns' images used to be rewritten to detail:"low" (~85 tokens
    // instead of ~700-1000) once a newer user message arrived, to hold down
    // prefill cost on image-heavy chats. It worked as a cost measure and was
    // wrong as a product decision: it silently degraded every image the moment
    // you sent your next message, so following up on a screenshot — "what about
    // the panel on the left" — asked the model about a picture it could no
    // longer read properly. The failure was invisible, because the image is
    // still there in the transcript at full quality; only the copy in the
    // request was downgraded, and the model just answered worse.
    //
    // Being able to reason over an image across a conversation is worth more
    // than the tokens it costs, so nothing is downgraded now. The cost is real
    // and unbounded — N images stay in the prefill of every subsequent request
    // — so if this needs a lid later, make it a user-visible setting that
    // defaults to full detail, rather than a silent rewrite.
    //
    // (It also un-breaks a prefix cache: the request body is now append-only
    // here, where previously each new user turn rewrote the one before it.)

    // OCR fallback (0.4.0): if the resolved model can't accept image input, every
    // image part (uploaded images and PDF page renders) is OCR'd into text so the
    // content still reaches the model instead of erroring or being dropped.
    // The per-model `visionOverrides` app setting (0.7.4) beats the name
    // heuristic in both directions, for models the heuristic can't classify
    // (e.g. fine-tunes whose names hide the base family).
    let vision_capable = match vision_override(db, &zone.model).await.as_deref() {
        Some("on") => true,
        Some("off") => false,
        _ => crate::ocr::is_vision_capable(&zone.model),
    };
    let ocr_lang = if vision_capable { String::new() } else { ocr_language(db).await };

    for m in rows.into_iter() {
        let mut content_parts: Vec<ContentPart> =
            serde_json::from_str(&m.content).unwrap_or_default();
        // For historical assistant turns, strip inline thinking blocks before
        // resending unless this zone opts in. User and tool messages never have
        // think tags, so we only touch role == "assistant".
        if m.role == "assistant" && !zone.include_thinking_in_context {
            for part in &mut content_parts {
                if let ContentPart::Text { text } = part {
                    *text = strip_thinking_blocks(text);
                }
            }
        }
        // Promote hidden parts to their visible equivalents for the API (the
        // hidden flag is only meaningful to the UI renderer). When the model is
        // vision-incapable, image parts are OCR'd into text here instead.
        let mut promoted: Vec<ContentPart> = Vec::with_capacity(content_parts.len());
        for p in content_parts {
            match p {
                ContentPart::HiddenText { text } => promoted.push(ContentPart::Text { text }),
                ContentPart::ImageUrl { image_url } | ContentPart::HiddenImage { image_url }
                    if !vision_capable =>
                {
                    let extracted =
                        crate::ocr::ocr_data_url(image_url.url.clone(), ocr_lang.clone()).await;
                    let text = match extracted {
                        Some(t) => format!("[Image — text extracted via OCR]\n{t}"),
                        None => "[Image attachment — the active model cannot view images, and no text could be extracted from it via OCR.]".to_string(),
                    };
                    promoted.push(ContentPart::Text { text });
                }
                ContentPart::HiddenImage { image_url } => {
                    promoted.push(ContentPart::ImageUrl { image_url })
                }
                other => promoted.push(other),
            }
        }
        let content_parts: Vec<ContentPart> = promoted;
        let content = if content_parts.is_empty() {
            None
        } else if content_parts.len() == 1 {
            if let ContentPart::Text { text } = &content_parts[0] {
                if text.trim().is_empty() && m.tool_calls.is_some() {
                    None
                } else {
                    Some(MessageContent::Text(text.clone()))
                }
            } else {
                Some(MessageContent::Parts(content_parts))
            }
        } else {
            Some(MessageContent::Parts(content_parts))
        };

        let tool_calls = m.tool_calls.as_ref().and_then(|s| {
            serde_json::from_str::<Vec<ToolCall>>(s).ok()
        });

        out.push(ChatMessage {
            role: m.role,
            content,
            tool_calls,
            tool_call_id: m.tool_call_id,
            name: None,
        });
    }

    Ok(out)
}

/// Builds the orchestration preamble for a Response Leader zone: the delegation
/// protocol plus the session's sub-agent roster (from `chat_subagents`). Returns
/// `None` only if the leader has no sub-agents configured *and* no roster could
/// be resolved — in that case the leader still gets the protocol text so it can
/// spawn ad-hoc sub-agents by name.
async fn build_leader_preamble(
    db: &SqlitePool,
    chat_id: &str,
    zone: &Zone,
) -> AppResult<Option<String>> {
    // Resolve the configured sub-agent roster (zone name + first-line blurb).
    let roster: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT z.name, z.system_prompt
         FROM chat_subagents s JOIN zones z ON z.id = s.zone_id
         WHERE s.chat_id = ?1 ORDER BY z.name",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await?;

    let mut text = format!(
        "You are \"{}\", the Response Leader for this conversation. Your job is to \
         coordinate one or more specialist sub-agents and synthesize their work into \
         a single answer for the user.\n\n\
         Delegation protocol:\n\
         • Drive sub-agents exclusively through the `spawn_subagent` and \
           `send_subchat_message` tools — never answer purely from your own knowledge \
           when a sub-agent could do the work better.\n\
         • Fan out, don't queue. Spawn every sub-agent you need for the current stage \
           with `background: true` in one message, keep working while they run, then \
           read their replies with `collect_subagents`. A blocking spawn stops you dead \
           until that one sub-agent finishes, so use it only when the next decision \
           genuinely depends on that single reply.\n\
         • Reuse your sub-agents. `list_subchats` shows the ones you already have; \
           continuing one with `send_subchat_message` keeps its context and costs far \
           less than briefing a fresh one. Spawn a second sub-agent on the same zone \
           only when you deliberately want two independent attempts.\n\
         • To stress-test an idea, present each sub-agent with a deliberately *opposing* \
           or devil's-advocate framing of the task rather than forwarding the user's \
           message verbatim. Have them argue different sides, then reconcile.\n\
         • Treat each sub-agent's reply (returned to you as a tool result) as input, not \
           as the final answer. Synthesize across them before you respond to the user.\n\
         • You are the only participant who may call `ask_user`; sub-agents cannot pause \
           to ask the user, so give them everything they need up front.\n\
         • Never end your turn with sub-agents still in flight — collect them first, or \
           their work is wasted.",
        zone.name
    );

    // Shared-tree coordination (0.9.10). Only when the leader actually has the
    // tool — and it changes the shape of the delegation, because sub-agents
    // editing one working directory at the same time need their seams agreed
    // before they start rather than discovered when a write is refused.
    if serde_json::from_str::<Vec<String>>(&zone.tools_enabled)
        .map_or(false, |t| t.iter().any(|id| id == "teamwork"))
    {
        text.push_str(
            "\n\nWorking one tree together:\n\
             • Your sub-agents edit the same working directory you do, at the same time. \
               Before they start, decide the seams — which files each one owns, and any \
               signature or name they must all honour — and `post_note` that to the shared \
               board. Parallel edits only compose if the contract exists first.\n\
             • Give each sub-agent a slice whose files don't overlap another's. Two agents \
               told to edit one file is a decomposition mistake, not something they can \
               negotiate: the tools refuse a write to a file another agent has claimed.\n\
             • `team_status` shows who holds which files and every note posted. Read it \
               between stages instead of asking each sub-agent what it did.\n\
             • When work must be compared rather than combined — two attempts at one hard \
               problem — tell each sub-agent to hand back a diff and leave the tree alone.",
        );
    }

    if roster.is_empty() {
        text.push_str(
            "\n\nNo sub-agents are pre-assigned to this session. Call `list_zones` to \
             discover available specialists, then spawn the ones you need.",
        );
    } else {
        text.push_str("\n\nSub-agents available for this session:");
        for (name, blurb) in &roster {
            let line = blurb
                .as_deref()
                .map(first_line)
                .filter(|s| !s.is_empty())
                .unwrap_or("specialist assistant");
            text.push_str(&format!("\n• {name} — {line}"));
        }
        text.push_str(
            "\n\nSpawn these by name with `spawn_subagent`. You may also bring in other \
             zones via `list_zones` if a task needs a specialist not listed here.",
        );
    }

    // Sub-agents this chat already has (0.9.10). Without this a leader on turn
    // two has no idea it briefed anyone on turn one, so it re-spawns the same
    // specialists from scratch and pays for the same context twice. Listing them
    // here is what makes reuse the path of least resistance.
    let existing: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT c.id, COALESCE(z.name, 'unknown'),
                (SELECT COUNT(*) FROM messages m
                  WHERE m.chat_id = c.id AND m.zone_id IS NULL
                    AND m.role IN ('user', 'assistant')) AS turns
           FROM chats c LEFT JOIN zones z ON z.id = c.zone_id
          WHERE c.parent_chat_id = ?1 AND c.initiated_by_zone_id IS NOT NULL
          ORDER BY c.created_at ASC",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await?;

    if !existing.is_empty() {
        text.push_str("\n\nSub-agents you have already briefed in this session:");
        for (id, name, turns) in &existing {
            text.push_str(&format!("\n• {name} [{id}] — {turns} turn(s)"));
        }
        text.push_str(
            "\n\nContinue one of these with `send_subchat_message` (it still has its own \
             context) rather than spawning a duplicate. `read_subchat` re-reads what one \
             already told you.",
        );
    }

    if let Some(in_flight) = crate::tools::subchat::in_flight_summary(chat_id) {
        text.push_str(&format!(
            "\n\nBackground sub-agents from earlier this session:\n{in_flight}\n\
             Call `collect_subagents` to pick up anything uncollected before you spawn more.",
        ));
    }

    Ok(Some(text))
}

/// Builds the per-turn identity preamble for a zone in a multi-zone chat:
/// tells the model which participant it is, names the other participants, and
/// explains the `**Name:**` labelling used in the shared transcript. Returns
/// `None` only if zone names can't be resolved at all.
async fn build_identity_preamble(
    db: &SqlitePool,
    chat_id: &str,
    chat: Option<&Chat>,
    self_zone: &Zone,
) -> AppResult<Option<String>> {
    // All participant zone ids: the primary zone plus every perspective zone.
    let mut ids: Vec<String> = Vec::new();
    if let Some(pz) = chat.and_then(|c| c.zone_id.clone()) {
        ids.push(pz);
    }
    let persp: Vec<String> =
        sqlx::query_scalar("SELECT zone_id FROM chat_zones WHERE chat_id = ?1")
            .bind(chat_id)
            .fetch_all(db)
            .await
            .unwrap_or_default();
    ids.extend(persp);

    let zone_names: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM zones").fetch_all(db).await?;
    let name_of = |zid: &str| -> Option<String> {
        zone_names.iter().find(|(id, _)| id == zid).map(|(_, n)| n.clone())
    };

    // Distinct "other participant" names (everyone except this zone).
    let mut others: Vec<String> = Vec::new();
    for id in &ids {
        if *id == self_zone.id {
            continue;
        }
        if let Some(n) = name_of(id) {
            if !others.contains(&n) {
                others.push(n);
            }
        }
    }

    let mut text = format!(
        "You are taking part in a multi-zone conversation. You are \"{}\". \
         You answer this turn independently — you cannot see what the other zones \
         say this turn, only what everyone said in previous turns.",
        self_zone.name
    );
    if !others.is_empty() {
        text.push_str(&format!(
            " The other participants are: {}.",
            others.join(", ")
        ));
    }
    text.push_str(
        " In the conversation that follows, each previous turn is prefixed with the \
         name of the zone that wrote it (e.g. \"**Name:**\"). Those labels are context \
         only — reply directly in your own voice without prefixing your answer with a name.",
    );

    Ok(Some(text))
}

/// Drop `tool` messages that no surviving assistant message called for.
///
/// Only the `tool` side is repaired here. The mirror case — an assistant message
/// whose calls never got results, which a cancelled turn can leave behind — is a
/// different provider complaint and needs a different answer (a stand-in result
/// rather than a deletion), so it isn't quietly folded into this.
fn drop_orphan_tool_messages(rows: &mut Vec<Message>) {
    let mut called: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in rows.iter() {
        let Some(raw) = m.tool_calls.as_deref() else { continue };
        if let Ok(calls) = serde_json::from_str::<Vec<ToolCall>>(raw) {
            called.extend(calls.into_iter().map(|c| c.id));
        }
    }
    rows.retain(|m| {
        if m.role != "tool" {
            return true;
        }
        let kept = m.tool_call_id.as_ref().is_some_and(|id| called.contains(id));
        if !kept {
            tracing::warn!(
                "dropping orphaned tool message {} (call {:?} is not in the history)",
                m.id,
                m.tool_call_id,
            );
        }
        kept
    });
}

/// Builds a shared, multi-model transcript for perspective chats and appends it
/// to `out` (which already holds the system message, if any).
///
/// Two rules implement the desired behaviour:
///   1. **Blind within a round** — every zone answers as if it were the only
///      responder. We never include any assistant/tool message produced *after*
///      the last user message, so a zone can't see its siblings' (or the
///      primary's) answer for the turn currently being generated. The primary's
///      own in-progress tool loop is appended in memory by the caller, not here.
///   2. **Shared memory across rounds** — for every *previous* round we merge
///      all zones' answers into a single labelled assistant message, so on the
///      next turn each zone can see what every other zone said before.
///
/// Tool-call structure from past rounds is flattened to text here; the active
/// turn still carries full tool structure via the caller's in-memory appends.
async fn build_multi_model_history(
    db: &SqlitePool,
    chat_id: &str,
    chat: Option<&Chat>,
    out: &mut Vec<ChatMessage>,
) -> AppResult<()> {
    let rows = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC"
    ))
    .bind(chat_id)
    .fetch_all(db)
    .await?;

    // The last user message is the current-round boundary. Anything an assistant
    // produced at/after it belongs to the round being generated → excluded.
    let last_user_ts = rows
        .iter()
        .filter(|m| m.role == "user")
        .map(|m| m.created_at)
        .max();

    // Resolve zone ids → display names so each contribution can be labelled.
    let zone_names: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM zones").fetch_all(db).await?;
    let primary_zone_id = chat.and_then(|c| c.zone_id.clone());
    let name_of = |zid: &str| -> String {
        zone_names
            .iter()
            .find(|(id, _)| id == zid)
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| "Assistant".to_string())
    };
    let primary_name = primary_zone_id
        .as_deref()
        .map(name_of)
        .unwrap_or_else(|| "Assistant".to_string());

    // Accumulates the answers produced since the previous user message, flushed
    // as one merged assistant turn when the next user message (or the end) is hit.
    let mut pending: Vec<(String, String)> = Vec::new();

    for m in &rows {
        match m.role.as_str() {
            "system" => continue,
            "user" => {
                push_merged_round(out, &mut pending);
                let is_historical = last_user_ts.map_or(false, |lu| m.created_at < lu);
                if let Some(content) = user_message_content(m, is_historical) {
                    out.push(ChatMessage {
                        role: "user".into(),
                        content: Some(content),
                        tool_calls: None,
                        tool_call_id: None,
                        name: None,
                    });
                }
            }
            "assistant" => {
                // Only past-round answers; current-round siblings stay hidden.
                let is_past = last_user_ts.map_or(false, |lu| m.created_at < lu);
                if !is_past {
                    continue;
                }
                let text = strip_thinking_blocks(&assistant_text(&m.content));
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let label = match &m.zone_id {
                    None => primary_name.clone(),
                    Some(z) => name_of(z),
                };
                pending.push((label, text.to_string()));
            }
            // Tool messages aren't replayed in the shared transcript.
            _ => continue,
        }
    }
    push_merged_round(out, &mut pending);

    Ok(())
}

/// Flushes the accumulated per-zone answers for one round into a single labelled
/// assistant message (keeps the API's user/assistant alternation valid).
fn push_merged_round(out: &mut Vec<ChatMessage>, pending: &mut Vec<(String, String)>) {
    if pending.is_empty() {
        return;
    }
    let mut buf = String::new();
    for (i, (label, text)) in pending.iter().enumerate() {
        if i > 0 {
            buf.push_str("\n\n");
        }
        buf.push_str("**");
        buf.push_str(label);
        buf.push_str(":**\n");
        buf.push_str(text);
    }
    pending.clear();
    out.push(ChatMessage {
        role: "assistant".into(),
        content: Some(MessageContent::Text(buf)),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    });
}

/// Joins the text parts of a stored assistant message's content JSON.
fn assistant_text(content_json: &str) -> String {
    let parts: Vec<ContentPart> = serde_json::from_str(content_json).unwrap_or_default();
    parts
        .iter()
        .filter_map(|p| match p {
            ContentPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Builds the API content for a stored user message, downgrading historical
/// images to low detail (same vision-token economy as the single-zone path).
fn user_message_content(m: &Message, downgrade_images: bool) -> Option<MessageContent> {
    let mut parts: Vec<ContentPart> = serde_json::from_str(&m.content).unwrap_or_default();
    if downgrade_images {
        for part in &mut parts {
            if let ContentPart::ImageUrl { image_url } = part {
                image_url.detail = Some("low".to_string());
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    if parts.len() == 1 {
        if let ContentPart::Text { text } = &parts[0] {
            return Some(MessageContent::Text(text.clone()));
        }
    }
    Some(MessageContent::Parts(parts))
}

/// Remove the `ask_user` tool from a toolset. Used for sub-agent (subchat)
/// turns so only the leader can pause the session to ask the user.
fn strip_ask_user(tools: &mut Vec<Tool>) {
    tools.retain(|t| t.function.name != "ask_user");
}

/// Apply plan mode to a built toolset (0.12.0).
///
/// In plan mode the mutating tools are *removed from the request*, not merely
/// discouraged — a model cannot misuse a tool it was never offered — and
/// `exit_plan_mode` is added as the way out. Out of plan mode, `enter_plan_mode`
/// is offered so the model can take itself into planning when a request turns
/// out to be bigger than it sounded.
///
/// Until 0.14.6 that offer was gated on the zone having a mutating tool, on the
/// reasoning that a read-only zone has nothing to withhold and so gains nothing
/// from the mode. That reasoning was about half of what plan mode is. The other
/// half is the artifact — an ordered, editable, approvable plan the user rewrites
/// before agreeing to it — and *that* is worth exactly as much to a zone whose
/// job is a 5 000-word report as to one that edits files. The gate was also the
/// single biggest reason the mode was never reached in practice: a Quick chat on
/// a search-and-read base zone was never offered the tool at all, so no amount of
/// asking for a plan could produce one. Any zone with tools can plan now.
///
/// Returns whether the chat is in plan mode, since the caller gates the
/// executor's refusal on the same answer.
async fn apply_plan_mode(
    db: &SqlitePool,
    chat_id: &str,
    tools: &mut Vec<Tool>,
    is_perspective: bool,
) -> bool {
    let planning = crate::plans::in_plan_mode(db, chat_id).await;
    // A zone with no tools at all is left alone: handing it `enter_plan_mode`
    // would turn a plain chat model into a tool-calling one for no gain, and
    // there is nothing for it to investigate with once inside the mode.
    let has_tools = !tools.is_empty();

    if planning {
        tools.retain(|t| crate::plans::allowed_in_plan_mode(&t.function.name));
        // Drafting the plan a step at a time, filing it, and reading one back:
        // always offered while planning, whatever the zone has enabled, because
        // they *are* the mode. A zone with no plan tool ticked can still plan.
        tools.push(crate::tools::plan_mode::draft_step_definition());
        tools.push(crate::tools::plan_mode::exit_definition());
        if !tools.iter().any(|t| t.function.name == "read_plan") {
            tools.push(crate::tools::plan_mode::read_plan_definition());
        }
        // Planning without the checklist tool leaves the model no way to report
        // progress once the plan is approved, and the plan it just wrote is the
        // obvious thing to keep. Cheap enough to always include.
        if !tools.iter().any(|t| t.function.name == "update_plan") {
            tools.push(crate::tools::plan::definition());
        }
    } else {
        // Not offered to a perspective zone. Plan mode is a property of the
        // *chat*, so one of several voices answering the same question would
        // take the whole conversation — and the other participants' turns —
        // into planning on everyone's behalf. Same reasoning as `ask_user`:
        // the shared controls belong to the primary.
        if has_tools && !is_perspective {
            tools.push(crate::tools::plan_mode::enter_definition());
        }
        // Out of plan mode `read_plan` earns its place only when there is a
        // plan to read: a turn executing an approved one is exactly where step
        // 6's specification has scrolled out of context and needs fetching
        // back. In a chat that has never planned it would be one more tool
        // definition in every request for nothing.
        if crate::plans::chat_has_plans(db, chat_id).await
            && !tools.iter().any(|t| t.function.name == "read_plan")
        {
            tools.push(crate::tools::plan_mode::read_plan_definition());
        }
    }
    planning
}

async fn build_tools_for_zone(db: &SqlitePool, zone: &Zone, ctx: &ToolContext) -> Vec<Tool> {
    let ids: Vec<String> = serde_json::from_str(&zone.tools_enabled).unwrap_or_default();
    let mut tools = Vec::new();
    for id in &ids {
        if let Some(tid) = ToolId::from_str(id) {
            tools.extend(tid.definitions(ctx));
        }
    }
    // MCP tools enabled on this zone (qualified ids `mcp__<server>__<tool>`).
    tools.extend(crate::mcp::tool_defs_for_ids(db, &ids).await);

    // Per-zone description overrides (0.9.3). A tool's description is the whole
    // of what the model knows about when and how to call it, and the wording
    // that works for a frontier model often isn't the wording that works for a
    // 7B local one — so let the user rewrite it per zone. Stored in the zone's
    // tool_config as `{"tool_descriptions": {"<function name>": "..."}}`; an
    // empty or absent entry leaves the shipped description alone. Covers MCP
    // tools too, since they're keyed by function name like everything else.
    if let Some(overrides) = serde_json::from_str::<Value>(&zone.tool_config)
        .ok()
        .and_then(|c| c.get("tool_descriptions").cloned())
        .and_then(|v| v.as_object().cloned())
    {
        for tool in &mut tools {
            if let Some(text) = overrides
                .get(&tool.function.name)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                tool.function.description = text.to_string();
            }
        }
    }

    tools
}

/// One callable function a zone can enable, flattened out of the tool groups.
/// The zone editor needs this because a group id (`file_system`) can expose
/// several functions (`read`, `edit`, …), and a description override
/// is per function. Derived from the Rust definitions so there is one source of
/// truth for what the model actually sees.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFunctionInfo {
    /// The group id as stored in a zone's `tools_enabled`, e.g. "file_system".
    pub tool_id: String,
    /// The function name the model calls, e.g. "read".
    pub name: String,
    /// The shipped description — the default an override replaces.
    pub description: String,
}

#[tauri::command]
pub async fn list_tool_functions(state: State<'_, AppState>) -> AppResult<Vec<ToolFunctionInfo>> {
    let ctx = load_tool_context(&state.db, None, None).await;
    let mut out = Vec::new();
    for id in crate::tools::ALL_TOOL_IDS {
        for def in id.definitions(&ctx) {
            out.push(ToolFunctionInfo {
                tool_id: id.as_str().to_string(),
                name: def.function.name,
                description: def.function.description,
            });
        }
    }
    Ok(out)
}

/// If the tool result JSON is an array of ContentParts (e.g. from read_file with
/// as_image), return them directly so the model receives the image inline.
/// Otherwise wrap the raw string in a single text ContentPart.
fn parse_tool_result_content(result: &str) -> (Vec<ContentPart>, MessageContent) {
    if result.trim_start().starts_with('[') {
        if let Ok(parts) = serde_json::from_str::<Vec<ContentPart>>(result) {
            if !parts.is_empty() {
                return (parts.clone(), MessageContent::Parts(parts));
            }
        }
    }
    let part = ContentPart::Text { text: result.to_string() };
    (vec![part], MessageContent::Text(result.to_string()))
}

/// Request-time state the tool definitions vary with. `model` is the one that
/// will answer, so a tool can leave out an option that model can't use; `None`
/// (the zone editor listing every shipped tool) describes the full surface.
async fn load_tool_context(
    db: &SqlitePool,
    chat_id: Option<&str>,
    model: Option<&str>,
) -> ToolContext {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?1")
        .bind("theme")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    let theme = ThemePalette::from_settings_json(row.as_ref().map(|(v,)| v.as_str()));
    let project_dir = match chat_id {
        Some(id) => resolve_working_dir(db, id).await.unwrap_or(None),
        None => None,
    };
    let vision_capable = match model {
        Some(m) => model_vision_capable(db, m).await,
        None => true,
    };
    ToolContext { theme, project_dir, vision_capable }
}

/// The directory the file tools are scoped to: the chat's project directory, or
/// the app-level default when the chat has no project. Resolved once per turn
/// and used twice — to execute the file tools, and to tell the model in each
/// tool's description which directory its paths resolve against.
pub(crate) async fn resolve_working_dir(db: &SqlitePool, chat_id: &str) -> AppResult<Option<String>> {
    let from_project: Option<String> = sqlx::query_scalar(
        "SELECT p.directory FROM projects p
         JOIN chats c ON c.project_id = p.id
         WHERE c.id = ?1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await?
    .flatten();

    if from_project.is_some() {
        return Ok(from_project);
    }

    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await?
            .flatten();
    Ok(raw
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("defaultDirectory")
                .and_then(|d| d.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(String::from)
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, role: &str, tool_calls: Option<&str>, tool_call_id: Option<&str>) -> Message {
        Message {
            id: id.into(),
            chat_id: "c1".into(),
            role: role.into(),
            content: "[]".into(),
            tool_calls: tool_calls.map(str::to_string),
            tool_call_id: tool_call_id.map(str::to_string),
            reasoning: None,
            zone_id: None,
            active_zone_id: None,
            edited: false,
            created_at: 0,
        }
    }

    /// The shape a compaction cutoff used to leave behind: the tool result
    /// survives, the assistant message that called for it does not. Sent as-is,
    /// the provider rejects the whole request, so every later turn in that chat
    /// failed too.
    #[test]
    fn orphaned_tool_results_are_dropped() {
        let calls = r#"[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{}"}}]"#;
        let mut rows = vec![
            msg("m1", "tool", None, Some("call_0")), // its call was compacted away
            msg("m2", "user", None, None),
            msg("m3", "assistant", Some(calls), None),
            msg("m4", "tool", None, Some("call_1")), // answered by m3
        ];

        drop_orphan_tool_messages(&mut rows);

        assert_eq!(
            rows.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["m2", "m3", "m4"],
            "only the tool result with no surviving caller should be dropped",
        );
    }

    // ── Reaching plan mode at all (0.14.6) ───────────────────────────────────

    fn tool_named(name: &str) -> Tool {
        Tool {
            tool_type: "function".into(),
            function: crate::llm::types::ToolFunction {
                name: name.into(),
                description: String::new(),
                parameters: serde_json::json!({}),
            },
        }
    }

    fn names(tools: &[Tool]) -> Vec<&str> {
        tools.iter().map(|t| t.function.name.as_str()).collect()
    }

    /// The bug that made plan mode unreachable for most chats: `enter_plan_mode`
    /// was offered only to a zone holding a mutating tool, so a Quick chat on a
    /// search-and-read zone — the exact setup someone asks for a report plan in
    /// — never saw the tool, and no phrasing could produce a plan.
    #[tokio::test]
    async fn a_read_only_zone_can_still_reach_plan_mode() {
        let pool = pool_with_long_chat().await;
        let mut tools = vec![tool_named("smart_search"), tool_named("read")];
        let planning = apply_plan_mode(&pool, "c1", &mut tools, false).await;
        assert!(!planning);
        assert!(names(&tools).contains(&"enter_plan_mode"));
    }

    /// A perspective zone is one of several voices answering the same question,
    /// and plan mode is a property of the whole chat — so it must not be able to
    /// take the conversation into planning on everyone else's behalf.
    #[tokio::test]
    async fn a_perspective_zone_cannot_seize_the_mode() {
        let pool = pool_with_long_chat().await;
        let mut tools = vec![tool_named("smart_search"), tool_named("write")];
        apply_plan_mode(&pool, "c1", &mut tools, true).await;
        assert!(!names(&tools).contains(&"enter_plan_mode"));
    }

    /// A zone with no tools is left alone: handing it `enter_plan_mode` would
    /// make a plain chat model a tool-calling one with nothing to investigate.
    #[tokio::test]
    async fn a_zone_with_no_tools_is_left_alone() {
        let pool = pool_with_long_chat().await;
        let mut tools: Vec<Tool> = Vec::new();
        apply_plan_mode(&pool, "c1", &mut tools, false).await;
        assert!(tools.is_empty());
    }

    /// Inside the mode: the mutating tools are gone from the request itself, and
    /// the three tools that *are* the mode arrive whatever the zone had ticked.
    #[tokio::test]
    async fn planning_swaps_the_toolset() {
        let pool = pool_with_long_chat().await;
        crate::plans::set_plan_mode(&pool, "c1", true).await.unwrap();
        let mut tools = vec![tool_named("smart_search"), tool_named("write")];
        let planning = apply_plan_mode(&pool, "c1", &mut tools, false).await;
        assert!(planning);
        let n = names(&tools);
        assert!(!n.contains(&"write"), "mutating tools are withheld, not discouraged");
        assert!(n.contains(&"smart_search"), "the research half of the mode survives");
        for t in ["draft_plan_step", "exit_plan_mode", "read_plan", "update_plan"] {
            assert!(n.contains(&t), "{t} should be offered while planning");
        }
        assert!(!n.contains(&"enter_plan_mode"), "already in the mode");
    }

    /// The prompt has to say planning exists — a tool description among twenty
    /// was not enough, and the loop preamble beside it pointed at `update_plan`.
    #[tokio::test]
    async fn the_prompt_offers_planning_when_it_is_available() {
        let pool = pool_with_long_chat().await;
        let prompt = system_prompt_for(&pool, &zone_with_compact_tool()).await;
        assert!(prompt.contains("enter_plan_mode"));

        // And where the checklist tool is also enabled, the preamble names it
        // as progress reporting and points the "agree it first" case at plan
        // mode — so the two stop competing for the same request.
        let mut planner = zone_with_compact_tool();
        planner.tools_enabled = r#"["plan","read"]"#.into();
        let prompt = system_prompt_for(&pool, &planner).await;
        assert!(prompt.contains("update_plan"));
        assert!(prompt.contains("enter_plan_mode` instead"));
    }

    /// Inside the mode the offer is replaced by the mode's own preamble, so the
    /// model is never told to enter a mode it is already in.
    #[tokio::test]
    async fn the_offer_gives_way_to_the_mode_itself() {
        let pool = pool_with_long_chat().await;
        crate::plans::set_plan_mode(&pool, "c1", true).await.unwrap();
        let chat = sqlx::query_as::<_, crate::db::models::Chat>(&format!(
            "SELECT {CHAT_COLS} FROM chats WHERE id = 'c1'"
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        let kinds: Vec<SnippetKind> =
            build_system_snippets(&pool, "c1", &zone_with_compact_tool(), Some(&chat), false)
                .await
                .unwrap()
                .into_iter()
                .map(|(k, _)| k)
                .collect();
        assert!(kinds.contains(&SnippetKind::PlanMode));
        assert!(!kinds.contains(&SnippetKind::PlanOffer));
    }

    // ── Prefix-cache stability ────────────────────────────────────────────────

    async fn pool_with_long_chat() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
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

    /// Give the chat a long history: 48k characters plus `extra`.
    async fn grow_history(pool: &SqlitePool, extra: usize) {
        let filler = "x".repeat(48_000 + extra);
        sqlx::query(
            "INSERT INTO messages (id, chat_id, role, content, created_at)
             VALUES ('grow', 'c1', 'user', ?1, 1)",
        )
        .bind(&filler)
        .execute(pool)
        .await
        .unwrap();
    }

    fn zone_with_compact_tool() -> Zone {
        Zone {
            id: "z1".into(),
            name: "Z".into(),
            provider_id: None,
            model: "m".into(),
            system_prompt: Some("You are a careful engineer.".into()),
            temperature: Some(0.7),
            max_tokens: None,
            top_p: None,
            tools_enabled: r#"["compact","read"]"#.into(),
            tool_config: "{}".into(),
            thinking_enabled: false,
            thinking_effort: "medium".into(),
            include_thinking_in_context: false,
            icon: None,
            accent_color: None,
            is_leader: false,
            fallback_zone_id: None,
            approvals: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    async fn system_prompt_for(pool: &SqlitePool, zone: &Zone) -> String {
        build_system_snippets(pool, "c1", zone, None, false)
            .await
            .unwrap()
            .iter()
            .map(|(_, s)| s.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// The system prompt is the front of every request and prefix caches match
    /// a byte-exact prefix, so anything in here that changes as the history
    /// grows invalidates the cache for the entire conversation behind it — on
    /// every turn, on exactly the long chats where caching is worth most. A
    /// since-removed compaction hint used to embed a live token count and did
    /// precisely that.
    ///
    /// Growing the history must leave the system prompt byte-identical.
    #[tokio::test]
    async fn the_system_prompt_is_byte_stable_as_the_history_grows() {
        let pool = pool_with_long_chat().await;
        let zone = zone_with_compact_tool();

        grow_history(&pool, 0).await;
        let first = system_prompt_for(&pool, &zone).await;

        // A few more turns' worth of conversation.
        sqlx::query("DELETE FROM messages WHERE id = 'grow'").execute(&pool).await.unwrap();
        grow_history(&pool, 9_000).await;
        let second = system_prompt_for(&pool, &zone).await;

        assert_eq!(
            first, second,
            "the system prompt changed as the history grew, so every request \
             behind it misses the prefix cache",
        );
    }

}
