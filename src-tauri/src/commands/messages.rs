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
use crate::llm::thinking::strip_thinking_blocks;
use crate::tools::{self, ThemePalette, ToolContext, ToolId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, RwLock};

const MAX_TOOL_ITERATIONS: usize = 8;

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
}

impl TurnOverride {
    fn is_active(&self) -> bool {
        self.zone_id.is_some() || self.model.is_some()
    }
}

const ZONE_COLS: &str = "id, name, provider_id, model, system_prompt, temperature, max_tokens, top_p,
    tools_enabled, tool_config, thinking_enabled, include_thinking_in_context,
    icon, accent_color, created_at, updated_at";
const CHAT_COLS: &str =
    "id, title, zone_id, project_id, project_context_enabled, perspective_mode, smart_routing, parent_chat_id, branched_from_message_id, created_at, updated_at";
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
    ToolApprovalRequired { index: usize, name: String, arguments: String },
    ToolCallExecuting { index: usize, name: String },
    ToolCallResult { index: usize, name: String, result: String },
    ToolMessageSaved { message: &'a Message },
    AssistantSaved { message: &'a Message },
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
    pub tool_approvals: Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<bool>>>>,
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

    /// Side-channel app events (tag/title/zone refreshes). GUI-only; no SSE.
    fn emit_event(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }
}

#[tauri::command]
pub async fn cancel_stream(state: State<'_, AppState>, chat_id: String) -> AppResult<()> {
    {
        let map = state.active_streams.read().await;
        if let Some(flag) = map.get(&chat_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    // Deny every pending tool approval for this chat — the primary (keyed by
    // chat id) and any perspective zones (keyed `chat_id::zone_id`) — so no
    // participant's loop is left blocked waiting on the user.
    let mut approvals = state.tool_approvals.lock().await;
    let keys: Vec<String> = approvals
        .keys()
        .filter(|k| approval_key_belongs_to_chat(k, &chat_id))
        .cloned()
        .collect();
    for k in keys {
        if let Some(tx) = approvals.remove(&k) {
            let _ = tx.send(false);
        }
    }
    Ok(())
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
pub async fn respond_tool_approval(
    state: State<'_, AppState>,
    chat_id: String,
    zone_id: Option<String>,
    approved: bool,
) -> AppResult<()> {
    let key = approval_key(&chat_id, zone_id.as_deref());
    let mut map = state.tool_approvals.lock().await;
    if let Some(tx) = map.remove(&key) {
        let _ = tx.send(approved);
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

    sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
    ))
    .bind(&message_id)
    .fetch_one(&state.db)
    .await
    .map_err(Into::into)
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

    let result = run_regenerate(ctx, sink, chat_id, cancel).await;

    ctx.active_streams.write().await.remove(chat_id);

    if let Err(e) = &result {
        sink.emit(chat_id, StreamPayload::Error { message: e.to_string() });
    }
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
    };
    run_send_entry(&ctx, &sink, &chat_id, parts, ov).await
}

/// Shared entry point for "send" used by both the Tauri command and the HTTP
/// API: registers a cancel flag, runs the send, cleans up.
pub async fn run_send_entry(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    parts: Vec<InputPart>,
    ov: TurnOverride,
) -> AppResult<()> {
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
    result
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

/// Resolve the provider used for simple (no-zone) chats: the one named by the
/// `defaultProviderId` app setting, falling back to the oldest provider.
async fn default_provider(db: &SqlitePool) -> AppResult<Provider> {
    let configured: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT value FROM settings WHERE key = 'app_settings'",
    )
    .fetch_optional(db)
    .await?
    .flatten()
    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    .and_then(|v| {
        v.get("defaultProviderId")
            .and_then(|d| d.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
    });

    if let Some(pid) = configured {
        if let Some(p) = sqlx::query_as::<_, Provider>(
            "SELECT id, name, base_url, api_key, default_model, created_at FROM providers WHERE id = ?1",
        )
        .bind(&pid)
        .fetch_optional(db)
        .await?
        {
            return Ok(p);
        }
    }

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
        temperature: 0.7,
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
        reasoning_effort: None,
        stream: false,
    };

    let client = LlmClient::new(http, &provider.base_url, provider.api_key.as_deref());
    let resp = client.chat_completion(&req).await?;
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
    };
    run_participant_turn(ctx, sink, chat_id, participant, cancel).await
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
    } = participant;
    let persp = persp_zone_id.as_deref();
    let tool_ctx = load_tool_context(&ctx.db).await;

    // The chat's stored primary zone, tracked so the `change_zone` tool can
    // switch zones mid-turn. Only the primary in plain Zone mode can switch.
    let mut current_zone_id: Option<String> = if allow_zone_switch {
        Some(zone.id.clone())
    } else {
        None
    };
    let mut tools = build_tools_for_zone(&zone, &tool_ctx);
    let mut zone_config: Value =
        serde_json::from_str(&zone.tool_config).unwrap_or(Value::Object(Default::default()));

    // Read global web-search config once; injected into zone_config (and on
    // zone-switch) so every zone uses the same provider/credentials without
    // storing them in per-zone tool_config.
    let global_ws_cfg: Option<Value> = {
        let raw: Option<String> = sqlx::query_scalar(
            "SELECT value FROM settings WHERE key = 'app_settings'",
        )
        .fetch_optional(&ctx.db)
        .await?
        .flatten();
        raw.and_then(|s| serde_json::from_str::<Value>(&s).ok()).map(|app_cfg| {
            let provider = app_cfg.get("webSearchProvider").and_then(|v| v.as_str()).unwrap_or("multi");
            let endpoint = app_cfg.get("webSearchEndpoint").and_then(|v| v.as_str()).unwrap_or("");
            let api_key = app_cfg.get("webSearchApiKey").and_then(|v| v.as_str()).unwrap_or("");
            serde_json::json!({ "provider": provider, "endpoint": endpoint, "api_key": api_key })
        })
    };
    if let Some(ws) = &global_ws_cfg {
        if let Some(obj) = zone_config.as_object_mut() {
            obj.insert("web_search".to_string(), ws.clone());
        }
    }

    // The project directory scopes the filesystem tools. If no project directory
    // is set, fall back to the app-level default directory from settings.
    let project_dir: Option<String> = {
        let from_project: Option<String> = sqlx::query_scalar(
            "SELECT p.directory FROM projects p
             JOIN chats c ON c.project_id = p.id
             WHERE c.id = ?1",
        )
        .bind(chat_id)
        .fetch_optional(&ctx.db)
        .await?
        .flatten();

        if from_project.is_some() {
            from_project
        } else {
            // Fall back to the default directory stored in app_settings JSON
            let raw: Option<String> = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key = 'app_settings'",
            )
            .fetch_optional(&ctx.db)
            .await?
            .flatten();
            raw.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| {
                    v.get("defaultDirectory")
                        .and_then(|d| d.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .map(String::from)
                })
        }
    };

    // Build initial messages array (full history)
    let mut api_messages = build_message_history(&ctx.db, chat_id, &zone).await?;

    let mut client =
        LlmClient::new(&ctx.http, &provider.base_url, provider.api_key.as_deref());

    // Agentic loop
    for _iteration in 0..MAX_TOOL_ITERATIONS {
        if cancel.load(Ordering::Relaxed) {
            sink.emit_for(chat_id, persp, StreamPayload::Cancelled);
            return Ok(());
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
            temperature: Some(zone.temperature),
            max_tokens: zone.max_tokens,
            top_p: zone.top_p,
            tools: if tools.is_empty() { None } else { Some(tools.clone()) },
            reasoning_effort,
            stream: true,
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
        let now = now_ts();
        // Primary turns record the answering zone in `active_zone_id` (zone_id
        // stays NULL); perspective turns record it in `zone_id` so they're
        // filtered out of the primary conversation and grouped per-zone.
        let active_zone_col: Option<&str> = if persp.is_some() { None } else { Some(zone.id.as_str()) };
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

        if agg.tool_calls.is_empty() {
            break;
        }

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

            // Check whether this tool needs explicit user approval.
            let tool_safety = tools::tool_safety_by_name(&tc.function.name);
            let needs_approval = approval_needed(&auto_approve_level, tool_safety);

            let approved = if needs_approval {
                let (tx, rx) = oneshot::channel::<bool>();
                ctx.tool_approvals.lock().await.insert(approval_key.clone(), tx);

                sink.emit_for(chat_id, persp, StreamPayload::ToolApprovalRequired {
                    index: 0,
                    name: tc.function.name.clone(),
                    arguments: tc.function.arguments.clone(),
                });

                // Wait up to 5 minutes for the user to approve or deny.
                let result = tokio::time::timeout(
                    tokio::time::Duration::from_secs(300),
                    rx,
                )
                .await
                .unwrap_or(Ok(false))
                .unwrap_or(false);

                ctx.tool_approvals.lock().await.remove(&approval_key);
                result
            } else {
                true
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
                tools::dispatch(
                    &tc.function.name,
                    &tc.function.arguments,
                    &zone_config,
                    &ctx.db,
                    chat_id,
                    project_dir.as_deref(),
                    &ctx.http,
                )
                .await
                .unwrap_or_else(|e| {
                    serde_json::json!({ "error": e.to_string() }).to_string()
                })
            } else {
                serde_json::json!({
                    "error": "Tool execution denied by user.",
                    "error_kind": "denied"
                })
                .to_string()
            };

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
                        tools = build_tools_for_zone(&zone, &tool_ctx);
                        zone_config = serde_json::from_str(&zone.tool_config)
                            .unwrap_or(Value::Object(Default::default()));
                        if let Some(ws) = &global_ws_cfg {
                            if let Some(obj) = zone_config.as_object_mut() {
                                obj.insert("web_search".to_string(), ws.clone());
                            }
                        }
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

    sink.emit_for(chat_id, persp, StreamPayload::Done);
    Ok(())
}

/// Resolves the effective perspective execution mode for a chat:
/// per-chat override → global `perspectiveMode` app setting → `"sequential"`.
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

    match global.as_deref() {
        Some("parallel") => "parallel".to_string(),
        _ => "sequential".to_string(),
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
    };
    run_participant_turn(ctx, sink, chat_id, participant, cancel).await
}

// ─── Message history ──────────────────────────────────────────────────────────

async fn build_message_history(
    db: &SqlitePool,
    chat_id: &str,
    zone: &Zone,
) -> AppResult<Vec<ChatMessage>> {
    // Collect context snippets: project (if enabled) then enabled tags, then zone system prompt.
    let mut snippets: Vec<String> = Vec::new();

    let chat = sqlx::query_as::<_, crate::db::models::Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(chat_id)
    .fetch_optional(db)
    .await?;

    if let Some(ref c) = chat {
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
                    if !s.trim().is_empty() { snippets.push(s); }
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
        snippets.extend(tag_snippets);
    }

    // Skills catalog (Anthropic Agent Skills model): when this zone has the
    // skills tool, list every enabled skill's name + description so the model
    // knows what it can load on demand via `load_skill`. The full content is not
    // injected — the agent requests it only when a request matches.
    let zone_tool_ids: Vec<String> = serde_json::from_str(&zone.tools_enabled).unwrap_or_default();
    if zone_tool_ids.iter().any(|t| t == "skills") {
        if let Some(catalog) = crate::tools::skills::build_catalog(db).await? {
            snippets.push(catalog);
        }
    }

    if let Some(sys) = &zone.system_prompt {
        if !sys.trim().is_empty() { snippets.push(sys.clone()); }
    }

    // Long-term memory (global → project → chat), injected each turn.
    if let Some(block) = crate::tools::memory::build_memory_block(db, chat_id).await? {
        snippets.push(block);
    }

    // Does this chat involve perspective zones (now, or historically)? If so we
    // build a shared multi-model transcript; otherwise we keep the original
    // single-zone history verbatim so ordinary chats are completely unaffected.
    let persp_zone_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM chat_zones WHERE chat_id = ?1")
            .bind(chat_id)
            .fetch_one(db)
            .await
            .unwrap_or(0);
    let persp_msg_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE chat_id = ?1 AND zone_id IS NOT NULL",
    )
    .bind(chat_id)
    .fetch_one(db)
    .await
    .unwrap_or(0);
    let multi_model = persp_zone_count > 0 || persp_msg_count > 0;

    // In a multi-zone chat, tell this model which participant it is (and who the
    // others are) so it can read the labelled transcript correctly and answer as
    // itself on this turn.
    if multi_model {
        if let Some(identity) = build_identity_preamble(db, chat_id, chat.as_ref(), zone).await? {
            snippets.push(identity);
        }
    }

    let mut out: Vec<ChatMessage> = Vec::new();
    if !snippets.is_empty() {
        out.push(ChatMessage {
            role: "system".into(),
            content: Some(MessageContent::Text(snippets.join("\n\n"))),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        });
    }

    if multi_model {
        build_multi_model_history(db, chat_id, chat.as_ref(), &mut out).await?;
        return Ok(out);
    }

    // ── Single-zone history (unchanged) ───────────────────────────────────────
    // Exclude perspective messages (zone_id IS NOT NULL) from the history sent
    // to any zone so they never pollute the primary conversation context.
    let rows = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE chat_id = ?1 AND zone_id IS NULL ORDER BY created_at ASC"
    ))
    .bind(chat_id)
    .fetch_all(db)
    .await?;

    // Find the last user message so we can downgrade images in earlier turns.
    // Qwen2-VL tokenises images at native resolution (~700-1000 tokens each);
    // with N images accumulated over K turns we'd otherwise pay a growing
    // prefill cost on every response. Setting detail:"low" for historical
    // images cuts each to ~85 tokens (~10× cheaper) while leaving the most
    // recent user message at full quality. The stored data is not touched —
    // this only affects the API request body built here.
    let last_user_idx = rows.iter().rposition(|m| m.role == "user");

    for (idx, m) in rows.into_iter().enumerate() {
        let is_historical = last_user_idx.map_or(false, |li| idx < li);

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
        // Downgrade historical images to low detail to reduce vision-token
        // prefill cost. Applies to both user messages (uploaded images) and
        // tool messages (images returned by file-system reads).
        if is_historical {
            for part in &mut content_parts {
                match part {
                    ContentPart::ImageUrl { image_url }
                    | ContentPart::HiddenImage { image_url } => {
                        image_url.detail = Some("low".to_string());
                    }
                    _ => {}
                }
            }
        }

        // Promote hidden parts to their visible equivalents for the API.
        // The hidden flag is only meaningful to the UI renderer.
        let content_parts: Vec<ContentPart> = content_parts
            .into_iter()
            .map(|p| match p {
                ContentPart::HiddenText { text } => ContentPart::Text { text },
                ContentPart::HiddenImage { image_url } => ContentPart::ImageUrl { image_url },
                other => other,
            })
            .collect();
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

fn build_tools_for_zone(zone: &Zone, ctx: &ToolContext) -> Vec<Tool> {
    let ids: Vec<String> = serde_json::from_str(&zone.tools_enabled).unwrap_or_default();
    let mut tools = Vec::new();
    for id in ids {
        if let Some(tid) = ToolId::from_str(&id) {
            tools.extend(tid.definitions(ctx));
        }
    }
    tools
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

async fn load_tool_context(db: &SqlitePool) -> ToolContext {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?1")
        .bind("theme")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    let theme = ThemePalette::from_settings_json(row.as_ref().map(|(v,)| v.as_str()));
    ToolContext { theme }
}
