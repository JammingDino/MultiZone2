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

const ZONE_COLS: &str = "id, name, provider_id, model, system_prompt, temperature_override AS temperature, max_tokens, top_p,
    tools_enabled, tool_config, thinking_enabled, include_thinking_in_context,
    icon, accent_color, is_leader, created_at, updated_at";
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

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
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
    Cancelled,
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
    pub tool_approvals: Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<ApprovalAnswer>>>>,
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
        if let Some(tx) = approvals.remove(&k) {
            let _ = tx.send(ApprovalAnswer::denied());
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
    if let Some(tx) = map.remove(&key) {
        let _ = tx.send(ApprovalAnswer { approved, hunks });
    }
    Ok(())
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

/// Read the auto-approve level from persisted app_settings.
/// Returns "all" if not set (backward-compatible: no approval prompts).
async fn get_auto_approve_level(db: &SqlitePool) -> String {
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
            v.get("autoApproveLevel")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "all".to_string())
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

/// Returns true when the tool needs explicit user approval given the current level.
fn approval_needed(auto_level: &str, tool_safety: u8) -> bool {
    match auto_level {
        "all" => false,
        "safe_moderate" => tool_safety > 1,
        "safe" => tool_safety > 0,
        "none" => true,
        _ => false,
    }
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
        include_thinking_in_context: false,
        icon: None,
        accent_color: None,
        is_leader: false,
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

    let client = LlmClient::new(http, &provider.base_url, provider.api_key.as_deref());
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
fn push_system_note(api_messages: &mut Vec<ChatMessage>, text: String) {
    api_messages.push(ChatMessage {
        role: "user".into(),
        content: Some(MessageContent::Text(text)),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    });
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
    let mut api_messages = build_message_history(&ctx.db, chat_id, &zone).await?;

    let mut client =
        LlmClient::new(&ctx.http, &provider.base_url, provider.api_key.as_deref());

    // Agentic loop. The budget is a user setting rather than a constant, and its
    // last two steps are spent finishing: one warned step, then a final step with
    // tools switched off so the turn always ends in an answer instead of falling
    // silently off the end of a tool result (see `llm::continuity`).
    let max_steps = max_tool_steps(&ctx.db).await;
    // Stall recovery state, tracked across the whole turn.
    let mut used_tools_this_turn = false;
    let mut nudges_used = 0usize;
    // Did any step of this turn yield something the user can see? Drives the
    // empty-response check after the loop.
    let mut produced_output = false;
    // A turn the user stopped is an empty result on purpose, not a failure.
    let mut cancelled_turn = false;
    // Citation numbering for this turn. Every citing tool numbers its own
    // results from 1, so without a shared counter a search and a `read_file` in
    // the same turn would both tell the model to write `[1]`. See
    // `tools::citations`.
    let mut next_citation_ref = 1u32;
    // Groups every tool call of this turn, so the checkpoint taken before the
    // turn's first file change is the one every later change extends (0.10.0).
    // Per turn rather than per step: the user reverts "what the assistant just
    // did", which spans the whole agentic loop, not one iteration of it.
    let turn_id = new_id();

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

        // Budget signalling. The wrap-up warning lands one step before the end so
        // the model can choose what to spend its last call on; the final step
        // both warns and withholds the tools, which is what actually guarantees
        // prose comes back.
        let final_step = continuity::is_final_step(step, max_steps);
        if final_step {
            push_system_note(&mut api_messages, continuity::final_step_nudge(max_steps));
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

        // Gemma models embed thinking in `<think>…</think>` tags inside the
        // normal content field; they don't support the reasoning_effort param.
        let is_gemma = zone.model.to_lowercase().contains("gemma");
        let reasoning_effort = if zone.thinking_enabled && !is_gemma {
            Some("medium".to_string())
        } else {
            None
        };
        let parse_inline_think = zone.thinking_enabled && is_gemma;

        let req = ChatRequest {
            model: zone.model.clone(),
            messages: api_messages.clone(),
            temperature: zone.temperature,
            max_tokens: zone.max_tokens,
            top_p: zone.top_p,
            // Tools are withheld on the final step so the model has no option
            // but to answer. Every other step offers the full set.
            tools: if tools.is_empty() || final_step { None } else { Some(tools.clone()) },
            tool_choice: None,
            reasoning_effort,
            chat_template_kwargs: None,
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

        let response = client.chat_stream(&req).await?;

        let sink_for_emit = sink.clone();
        let chat_id_for_emit = chat_id.to_string();
        let persp_for_emit = persp_zone_id.clone();
        let agg = consume_stream(response, cancel.clone(), parse_inline_think, move |ev| {
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

        // Did this step end the turn, or did the model just stall? A step with
        // no tool calls used to end the turn unconditionally, which is how a
        // long run of file reads ended in an empty bubble and how "now opening
        // the six opportunities" ended without opening anything. Cancellation
        // and the final step are real endings and are never second-guessed.
        let stall = if agg.cancelled || final_step || !agg.tool_calls.is_empty() {
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
            // Genuinely finished — the turn ends here.
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

        // Execute tools, persist results, push into history
        let auto_approve_level = get_auto_approve_level(&ctx.db).await;
        let approval_key = approval_key(chat_id, persp);
        for tc in &agg.tool_calls {
            if cancel.load(Ordering::Relaxed) {
                sink.emit_for(chat_id, persp, StreamPayload::Cancelled);
                return Ok(());
            }

            // Check whether this tool needs explicit user approval. MCP tools
            // carry a user-assigned danger level; built-ins use their static one.
            let tool_safety = mcp_danger
                .get(&tc.function.name)
                .copied()
                .unwrap_or_else(|| tools::tool_safety_by_name(&tc.function.name));
            let needs_approval = approval_needed(&auto_approve_level, tool_safety);

            let answer = if needs_approval {
                let (tx, rx) = oneshot::channel::<ApprovalAnswer>();
                ctx.tool_approvals.lock().await.insert(approval_key.clone(), tx);

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

                sink.emit_for(chat_id, persp, StreamPayload::ToolApprovalRequired {
                    index: 0,
                    name: tc.function.name.clone(),
                    arguments: tc.function.arguments.clone(),
                    diff,
                });

                // Wait up to 5 minutes for the user to approve or deny.
                let result = tokio::time::timeout(
                    tokio::time::Duration::from_secs(300),
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
                name: Some(tc.function.name.clone()),
            });
        }

        if asked_user {
            break;
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
                        );
                        sink.emit_event(
                            "chat-zone-updated",
                            serde_json::json!({ "chatId": chat_id, "zoneId": new_zone_id }),
                        );
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

    sink.emit_for(chat_id, persp, StreamPayload::Done);
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
    Continuity,
    Skills,
    Knowledge,
    ProjectContext,
    TagContext,
    Leader,
    Identity,
    Memory,
    CompactHint,
}

impl SnippetKind {
    /// Label shown in the context meter's breakdown.
    pub fn label(self) -> &'static str {
        match self {
            Self::ProjectContext => "Project context",
            Self::TagContext => "Tag context",
            Self::Skills => "Skills catalog",
            Self::Knowledge => "Knowledge index",
            Self::ZonePrompt => "Zone prompt",
            Self::Continuity => "Agent-loop preamble",
            Self::Leader => "Sub-agent roster",
            Self::Memory => "Memories",
            Self::Identity => "Multi-zone identity",
            Self::CompactHint => "Compaction hint",
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
pub async fn build_system_snippets(
    db: &SqlitePool,
    chat_id: &str,
    zone: &Zone,
    chat: Option<&Chat>,
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
    // the ones that can change on any turn go last (memory, compaction hint).
    // Reordering is free to do here because nothing downstream depends on the
    // order — the context meter labels each piece independently.

    // The zone's own prompt is the most stable thing in the request and the
    // primary instruction, so it leads.
    if let Some(sys) = &zone.system_prompt {
        if !sys.trim().is_empty() {
            snippets.push((SnippetKind::ZonePrompt, sys.clone()));
        }
    }

    // How the agentic loop works (0.9.6). A model that doesn't know it will be
    // called again after a tool result has every reason to stop and wait for the
    // user — which is exactly what stalls a long task halfway through. Only
    // zones that actually have tools get this; for the rest it's noise.
    let zone_tool_ids: Vec<String> = serde_json::from_str(&zone.tools_enabled).unwrap_or_default();
    if !zone_tool_ids.is_empty() {
        snippets.push((
            SnippetKind::Continuity,
            crate::llm::continuity::multi_step_preamble(
                max_tool_steps(db).await,
                zone_tool_ids.iter().any(|t| t == "plan"),
            ),
        ));
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

    // Context compaction (0.9.3): once the history is long, nudge the model to
    // summarize it — but only if this zone actually has the tool to do so,
    // otherwise the nudge is noise it can't act on.
    if serde_json::from_str::<Vec<String>>(&zone.tools_enabled)
        .map_or(false, |t| t.iter().any(|id| id == "compact"))
    {
        let history_chars: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(LENGTH(content)), 0) FROM messages
             WHERE chat_id = ?1 AND zone_id IS NULL",
        )
        .bind(chat_id)
        .fetch_one(db)
        .await
        .unwrap_or(0);
        if history_chars as usize >= crate::tools::compact::COMPACT_HINT_CHARS {
            snippets.push((
                SnippetKind::CompactHint,
                crate::tools::compact::compact_hint(history_chars as usize),
            ));
        }
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
    let snippets = build_system_snippets(db, chat_id, &zone, chat.as_ref()).await?;

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

async fn build_message_history(
    db: &SqlitePool,
    chat_id: &str,
    zone: &Zone,
) -> AppResult<Vec<ChatMessage>> {
    let chat = sqlx::query_as::<_, crate::db::models::Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(chat_id)
    .fetch_optional(db)
    .await?;

    let snippets = build_system_snippets(db, chat_id, zone, chat.as_ref()).await?;
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
/// several functions (`read_file`, `edit_file`, …), and a description override
/// is per function. Derived from the Rust definitions so there is one source of
/// truth for what the model actually sees.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFunctionInfo {
    /// The group id as stored in a zone's `tools_enabled`, e.g. "file_system".
    pub tool_id: String,
    /// The function name the model calls, e.g. "read_file".
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
        let calls = r#"[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{}"}}]"#;
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

    /// Push the chat's history past `COMPACT_HINT_CHARS` by `extra` characters,
    /// which is what makes the compaction hint appear in the system prompt.
    async fn grow_history(pool: &SqlitePool, extra: usize) {
        let filler = "x".repeat(crate::tools::compact::COMPACT_HINT_CHARS + extra);
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
            tools_enabled: r#"["compact","read_file"]"#.into(),
            tool_config: "{}".into(),
            thinking_enabled: false,
            include_thinking_in_context: false,
            icon: None,
            accent_color: None,
            is_leader: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    async fn system_prompt_for(pool: &SqlitePool, zone: &Zone) -> String {
        build_system_snippets(pool, "c1", zone, None)
            .await
            .unwrap()
            .iter()
            .map(|(_, s)| s.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// The regression this whole exercise was about.
    ///
    /// The system prompt is the front of every request and prefix caches match
    /// a byte-exact prefix, so anything in here that changes as the history
    /// grows invalidates the cache for the entire conversation behind it — on
    /// every turn, on exactly the long chats where caching is worth most. The
    /// compaction hint used to embed a live token count and did precisely that.
    ///
    /// Growing the history must leave the system prompt byte-identical.
    #[tokio::test]
    async fn the_system_prompt_is_byte_stable_as_the_history_grows() {
        let pool = pool_with_long_chat().await;
        let zone = zone_with_compact_tool();

        grow_history(&pool, 0).await;
        let first = system_prompt_for(&pool, &zone).await;

        // Sanity: the hint really is present, or this test proves nothing.
        assert!(
            first.contains("# Context length"),
            "the compaction hint should be in play for this fixture",
        );

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

    /// Ordering is load-bearing, not cosmetic: the cache is valid up to the
    /// first differing byte, so when a volatile piece *does* change, everything
    /// declared before it still hits. Pin the invariant that the volatile
    /// snippets sort last.
    #[tokio::test]
    async fn volatile_snippets_come_last_in_the_system_prompt() {
        let pool = pool_with_long_chat().await;
        grow_history(&pool, 0).await;
        let snippets = build_system_snippets(&pool, "c1", &zone_with_compact_tool(), None)
            .await
            .unwrap();

        let kinds: Vec<SnippetKind> = snippets.iter().map(|(k, _)| *k).collect();
        let pos = |k: SnippetKind| kinds.iter().position(|x| *x == k);

        let (Some(prompt), Some(hint)) = (pos(SnippetKind::ZonePrompt), pos(SnippetKind::CompactHint))
        else {
            panic!("fixture should produce both a zone prompt and a compaction hint: {kinds:?}");
        };
        assert!(prompt < hint, "the stable zone prompt must precede the volatile hint: {kinds:?}");
        assert_eq!(
            hint,
            kinds.len() - 1,
            "the compaction hint is the most volatile piece and must sort last: {kinds:?}",
        );
    }
}
