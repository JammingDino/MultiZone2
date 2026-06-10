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

const ZONE_COLS: &str = "id, name, provider_id, model, system_prompt, temperature, max_tokens, top_p,
    tools_enabled, tool_config, thinking_enabled, include_thinking_in_context,
    icon, accent_color, created_at, updated_at";
const CHAT_COLS: &str =
    "id, title, zone_id, project_id, project_context_enabled, created_at, updated_at";
const MSG_COLS: &str =
    "id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, created_at";

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
    // Deny any pending tool approval so the backend loop isn't stuck.
    let mut approvals = state.tool_approvals.lock().await;
    if let Some(tx) = approvals.remove(&chat_id) {
        let _ = tx.send(false);
    }
    Ok(())
}

/// Called by the frontend to approve or deny a pending tool execution.
#[tauri::command]
pub async fn respond_tool_approval(
    state: State<'_, AppState>,
    chat_id: String,
    approved: bool,
) -> AppResult<()> {
    let mut map = state.tool_approvals.lock().await;
    if let Some(tx) = map.remove(&chat_id) {
        let _ = tx.send(approved);
    }
    Ok(())
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
    run_agentic_loop(ctx, sink, chat_id, cancel.clone()).await?;
    run_perspectives(ctx, sink, chat_id, cancel).await;
    Ok(())
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    parts: Vec<InputPart>,
) -> AppResult<()> {
    let ctx = EngineCtx::from_state(&state);
    let sink = StreamSink::tauri(app);
    run_send_entry(&ctx, &sink, &chat_id, parts).await
}

/// Shared entry point for "send" used by both the Tauri command and the HTTP
/// API: registers a cancel flag, runs the send, cleans up.
pub async fn run_send_entry(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    parts: Vec<InputPart>,
) -> AppResult<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    ctx.active_streams
        .write()
        .await
        .insert(chat_id.to_string(), cancel.clone());

    let result = run_send(ctx, sink, chat_id, parts, cancel.clone()).await;

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
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    // Validate the chat exists and has a zone before persisting anything.
    let chat = sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(chat_id)
    .fetch_optional(&ctx.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("chat {chat_id}")))?;

    if chat.zone_id.is_none() {
        return Err(AppError::Invalid("chat has no zone".into()));
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

    run_agentic_loop(ctx, sink, chat_id, cancel.clone()).await?;
    run_perspectives(ctx, sink, chat_id, cancel).await;
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
        "SELECT id, name, base_url, api_key, created_at FROM providers WHERE id = ?1",
    )
    .bind(&provider_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("provider {provider_id}")))?;

    Ok((zone, provider))
}

async fn run_agentic_loop(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let tool_ctx = load_tool_context(&ctx.db).await;

    // Resolve the chat's current primary zone. This is re-checked after every
    // tool-execution phase so the `change_zone` tool can switch zones mid-turn.
    let mut current_zone_id = sqlx::query_scalar::<_, Option<String>>(
        "SELECT zone_id FROM chats WHERE id = ?1",
    )
    .bind(chat_id)
    .fetch_optional(&ctx.db)
    .await?
    .flatten()
    .ok_or_else(|| AppError::Invalid("chat has no zone".into()))?;

    let (mut zone, mut provider) = load_zone_and_provider(&ctx.db, &current_zone_id).await?;
    let mut tools = build_tools_for_zone(&zone, &tool_ctx);
    let mut zone_config: Value =
        serde_json::from_str(&zone.tool_config).unwrap_or(Value::Object(Default::default()));

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
            sink.emit(chat_id, StreamPayload::Cancelled);
            return Ok(());
        }

        let assistant_msg_id = new_id();
        sink.emit(
            chat_id,
            StreamPayload::AssistantStart {
                message_id: assistant_msg_id.clone(),
            },
        );

        let reasoning_effort = if zone.thinking_enabled {
            Some("medium".to_string())
        } else {
            None
        };

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
        let agg = consume_stream(response, cancel.clone(), move |ev| match ev {
            StreamEvent::Token { delta } => {
                sink_for_emit.emit(&chat_id_for_emit, StreamPayload::Token { delta });
            }
            StreamEvent::ThinkingToken { delta } => {
                sink_for_emit
                    .emit(&chat_id_for_emit, StreamPayload::ThinkingToken { delta });
            }
            StreamEvent::ToolCallStart { index, name, id } => {
                sink_for_emit.emit(
                    &chat_id_for_emit,
                    StreamPayload::ToolCallStart { index, id, name },
                );
            }
            StreamEvent::ToolCallDeltaArgs { index, delta } => {
                sink_for_emit.emit(
                    &chat_id_for_emit,
                    StreamPayload::ToolCallArgsDelta { index, delta },
                );
            }
            StreamEvent::Done { .. } => {}
            StreamEvent::Error { message } => {
                sink_for_emit
                    .emit(&chat_id_for_emit, StreamPayload::Error { message });
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
        sqlx::query(
            "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, created_at)
             VALUES (?1, ?2, 'assistant', ?3, ?4, NULL, ?5, ?6)",
        )
        .bind(&assistant_msg_id)
        .bind(chat_id)
        .bind(&assistant_content_json)
        .bind(&tool_calls_json)
        .bind(&reasoning_save)
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
        sink.emit(chat_id, StreamPayload::AssistantSaved { message: &saved });

        if agg.cancelled {
            sink.emit(chat_id, StreamPayload::Cancelled);
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
        for tc in &agg.tool_calls {
            if cancel.load(Ordering::Relaxed) {
                sink.emit(chat_id, StreamPayload::Cancelled);
                return Ok(());
            }

            // Check whether this tool needs explicit user approval.
            let tool_safety = tools::tool_safety_by_name(&tc.function.name);
            let needs_approval = approval_needed(&auto_approve_level, tool_safety);

            let approved = if needs_approval {
                let (tx, rx) = oneshot::channel::<bool>();
                ctx.tool_approvals.lock().await.insert(chat_id.to_string(), tx);

                sink.emit(chat_id, StreamPayload::ToolApprovalRequired {
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

                ctx.tool_approvals.lock().await.remove(chat_id);
                result
            } else {
                true
            };

            let result = if approved {
                sink.emit(
                    chat_id,
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

            sink.emit(
                chat_id,
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
            sqlx::query(
                "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, created_at)
                 VALUES (?1, ?2, 'tool', ?3, NULL, ?4, NULL, ?5)",
            )
            .bind(&tool_msg_id)
            .bind(chat_id)
            .bind(&tool_content_json)
            .bind(&tc.id)
            .bind(tnow)
            .execute(&ctx.db)
            .await?;

            let saved_tool = sqlx::query_as::<_, Message>(&format!(
                "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
            ))
            .bind(&tool_msg_id)
            .fetch_one(&ctx.db)
            .await?;
            sink.emit(chat_id, StreamPayload::ToolMessageSaved { message: &saved_tool });

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
        let latest_zone_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT zone_id FROM chats WHERE id = ?1",
        )
        .bind(chat_id)
        .fetch_optional(&ctx.db)
        .await?
        .flatten();

        if let Some(new_zone_id) = latest_zone_id {
            if new_zone_id != current_zone_id {
                // If reloading fails (e.g. the new zone lacks a provider), keep
                // going on the current zone rather than aborting the turn.
                match load_zone_and_provider(&ctx.db, &new_zone_id).await {
                    Ok((new_zone, new_provider)) => {
                        current_zone_id = new_zone_id.clone();
                        zone = new_zone;
                        provider = new_provider;
                        tools = build_tools_for_zone(&zone, &tool_ctx);
                        zone_config = serde_json::from_str(&zone.tool_config)
                            .unwrap_or(Value::Object(Default::default()));
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

    sink.emit(chat_id, StreamPayload::Done);
    Ok(())
}

// ─── Perspective zone runners ─────────────────────────────────────────────────

async fn run_perspectives(
    ctx: &EngineCtx,
    sink: &StreamSink,
    chat_id: &str,
    cancel: Arc<AtomicBool>,
) {
    let zone_ids: Vec<String> =
        sqlx::query_scalar("SELECT zone_id FROM chat_zones WHERE chat_id = ?1")
            .bind(chat_id)
            .fetch_all(&ctx.db)
            .await
            .unwrap_or_default();

    if zone_ids.is_empty() {
        return;
    }

    let mut handles = Vec::new();
    for zone_id in zone_ids {
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
}

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

    let api_messages = build_message_history(&ctx.db, chat_id, &zone).await?;

    let msg_id = new_id();
    sink.emit_persp(
        chat_id,
        zone_id,
        StreamPayload::AssistantStart { message_id: msg_id.clone() },
    );

    let reasoning_effort = if zone.thinking_enabled {
        Some("medium".to_string())
    } else {
        None
    };

    let req = crate::llm::types::ChatRequest {
        model: zone.model.clone(),
        messages: api_messages,
        temperature: Some(zone.temperature),
        max_tokens: zone.max_tokens,
        top_p: zone.top_p,
        tools: None, // perspectives are read-only, no tool use
        reasoning_effort,
        stream: true,
    };

    let client = crate::llm::client::LlmClient::new(&ctx.http, &provider.base_url, provider.api_key.as_deref());
    let response = client.chat_stream(&req).await?;

    let sink_clone = sink.clone();
    let chat_id_clone = chat_id.to_string();
    let zone_id_clone = zone_id.to_string();

    let agg = crate::llm::streaming::consume_stream(response, cancel.clone(), move |ev| match ev {
        crate::llm::streaming::StreamEvent::Token { delta } => {
            sink_clone.emit_persp(&chat_id_clone, &zone_id_clone, StreamPayload::Token { delta });
        }
        crate::llm::streaming::StreamEvent::ThinkingToken { delta } => {
            sink_clone.emit_persp(
                &chat_id_clone,
                &zone_id_clone,
                StreamPayload::ThinkingToken { delta },
            );
        }
        _ => {}
    })
    .await?;

    let content_json = if agg.content.is_empty() {
        "[]".to_string()
    } else {
        serde_json::to_string(&vec![ContentPart::Text { text: agg.content.clone() }])?
    };
    let reasoning_save = if agg.reasoning.is_empty() {
        None
    } else {
        Some(agg.reasoning.clone())
    };
    let now = now_ts();

    sqlx::query(
        "INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, created_at)
         VALUES (?1, ?2, 'assistant', ?3, NULL, NULL, ?4, ?5, ?6)",
    )
    .bind(&msg_id)
    .bind(chat_id)
    .bind(&content_json)
    .bind(&reasoning_save)
    .bind(zone_id)
    .bind(now)
    .execute(&ctx.db)
    .await?;

    let saved = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
    ))
    .bind(&msg_id)
    .fetch_one(&ctx.db)
    .await?;

    sink.emit_persp(chat_id, zone_id, StreamPayload::AssistantSaved { message: &saved });

    if agg.cancelled {
        sink.emit_persp(chat_id, zone_id, StreamPayload::Cancelled);
    } else {
        sink.emit_persp(chat_id, zone_id, StreamPayload::Done);
    }

    Ok(())
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

    if let Some(sys) = &zone.system_prompt {
        if !sys.trim().is_empty() { snippets.push(sys.clone()); }
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
