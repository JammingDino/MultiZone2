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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

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
    ToolCallExecuting { index: usize, name: String },
    ToolCallResult { index: usize, name: String, result: String },
    ToolMessageSaved { message: &'a Message },
    AssistantSaved { message: &'a Message },
    Cancelled,
    Done,
    Error { message: String },
}

fn emit(app: &AppHandle, chat_id: &str, payload: StreamPayload) {
    let _ = app.emit(
        "stream",
        serde_json::json!({ "chatId": chat_id, "event": payload }),
    );
}

fn emit_persp(app: &AppHandle, chat_id: &str, zone_id: &str, payload: StreamPayload) {
    let _ = app.emit(
        "stream",
        serde_json::json!({ "chatId": chat_id, "perspectiveZoneId": zone_id, "event": payload }),
    );
}

#[tauri::command]
pub async fn cancel_stream(state: State<'_, AppState>, chat_id: String) -> AppResult<()> {
    let map = state.active_streams.read().await;
    if let Some(flag) = map.get(&chat_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Run the agentic loop against the chat's existing history without inserting
/// a new user message. Used by "regenerate" after we've trimmed previous responses.
#[tauri::command]
pub async fn regenerate_response(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .active_streams
        .write()
        .await
        .insert(chat_id.clone(), cancel.clone());

    let result = run_regenerate(&app, &state, &chat_id, cancel).await;

    state.active_streams.write().await.remove(&chat_id);

    if let Err(e) = &result {
        emit(
            &app,
            &chat_id,
            StreamPayload::Error { message: e.to_string() },
        );
    }
    result
}

async fn run_regenerate(
    app: &AppHandle,
    state: &AppState,
    chat_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let chat = sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(chat_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("chat {chat_id}")))?;

    let zone_id = chat
        .zone_id
        .clone()
        .ok_or_else(|| AppError::Invalid("chat has no zone".into()))?;
    let zone = sqlx::query_as::<_, Zone>(&format!(
        "SELECT {ZONE_COLS} FROM zones WHERE id = ?1"
    ))
    .bind(&zone_id)
    .fetch_optional(&state.db)
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
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("provider {provider_id}")))?;

    run_agentic_loop(app, state, chat_id, &zone, &provider, cancel).await
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    parts: Vec<InputPart>,
) -> AppResult<()> {
    // Register a cancel flag for this chat.
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .active_streams
        .write()
        .await
        .insert(chat_id.clone(), cancel.clone());

    let result = run_send(&app, &state, &chat_id, parts, cancel.clone()).await;

    // Always clean up the cancel registration.
    state.active_streams.write().await.remove(&chat_id);

    if let Err(e) = &result {
        emit(
            &app,
            &chat_id,
            StreamPayload::Error { message: e.to_string() },
        );
    }
    result
}

async fn run_send(
    app: &AppHandle,
    state: &AppState,
    chat_id: &str,
    parts: Vec<InputPart>,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    // 1. Load chat, zone, provider
    let chat = sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(chat_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("chat {chat_id}")))?;

    let zone_id = chat
        .zone_id
        .clone()
        .ok_or_else(|| AppError::Invalid("chat has no zone".into()))?;

    let zone = sqlx::query_as::<_, Zone>(&format!(
        "SELECT {ZONE_COLS} FROM zones WHERE id = ?1"
    ))
    .bind(&zone_id)
    .fetch_optional(&state.db)
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
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("provider {provider_id}")))?;

    // 2. Convert input parts to ContentParts and save user message
    let content_parts: Vec<ContentPart> = parts
        .into_iter()
        .map(|p| match p {
            InputPart::Text { text } => ContentPart::Text { text },
            InputPart::Image { data_url } => ContentPart::ImageUrl {
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
    .execute(&state.db)
    .await?;
    sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
        .bind(user_now)
        .bind(chat_id)
        .execute(&state.db)
        .await?;

    let user_msg = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
    ))
    .bind(&user_msg_id)
    .fetch_one(&state.db)
    .await?;
    emit(app, chat_id, StreamPayload::UserMessageSaved { message: &user_msg });

    run_agentic_loop(app, state, chat_id, &zone, &provider, cancel.clone()).await?;
    run_perspectives(app, state, chat_id, cancel).await;
    Ok(())
}

async fn run_agentic_loop(
    app: &AppHandle,
    state: &AppState,
    chat_id: &str,
    zone: &Zone,
    provider: &Provider,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    // Build initial messages array (full history)
    let mut api_messages = build_message_history(&state.db, chat_id, zone).await?;

    let tool_ctx = load_tool_context(state).await;
    let tools = build_tools_for_zone(zone, &tool_ctx);
    let zone_config: Value =
        serde_json::from_str(&zone.tool_config).unwrap_or(Value::Object(Default::default()));

    // The project directory (if this chat belongs to a project with one) scopes
    // the filesystem tools and serves as their base for relative paths.
    let project_dir: Option<String> = sqlx::query_scalar(
        "SELECT p.directory FROM projects p
         JOIN chats c ON c.project_id = p.id
         WHERE c.id = ?1",
    )
    .bind(chat_id)
    .fetch_optional(&state.db)
    .await?
    .flatten();

    let client = LlmClient::new(&state.http, &provider.base_url, provider.api_key.as_deref());

    // Agentic loop
    for _iteration in 0..MAX_TOOL_ITERATIONS {
        if cancel.load(Ordering::Relaxed) {
            emit(app, chat_id, StreamPayload::Cancelled);
            return Ok(());
        }

        let assistant_msg_id = new_id();
        emit(
            app,
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

        let chat_id_for_emit = chat_id.to_string();
        let app_for_emit = app.clone();
        let agg = consume_stream(response, cancel.clone(), move |ev| match ev {
            StreamEvent::Token { delta } => {
                emit(&app_for_emit, &chat_id_for_emit, StreamPayload::Token { delta });
            }
            StreamEvent::ThinkingToken { delta } => {
                emit(
                    &app_for_emit,
                    &chat_id_for_emit,
                    StreamPayload::ThinkingToken { delta },
                );
            }
            StreamEvent::ToolCallStart { index, name, id } => {
                emit(
                    &app_for_emit,
                    &chat_id_for_emit,
                    StreamPayload::ToolCallStart { index, id, name },
                );
            }
            StreamEvent::ToolCallDeltaArgs { index, delta } => {
                emit(
                    &app_for_emit,
                    &chat_id_for_emit,
                    StreamPayload::ToolCallArgsDelta { index, delta },
                );
            }
            StreamEvent::Done { .. } => {}
            StreamEvent::Error { message } => {
                emit(
                    &app_for_emit,
                    &chat_id_for_emit,
                    StreamPayload::Error { message },
                );
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
        .execute(&state.db)
        .await?;
        sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
            .bind(now)
            .bind(chat_id)
            .execute(&state.db)
            .await?;

        let saved = sqlx::query_as::<_, Message>(&format!(
            "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
        ))
        .bind(&assistant_msg_id)
        .fetch_one(&state.db)
        .await?;
        emit(app, chat_id, StreamPayload::AssistantSaved { message: &saved });

        if agg.cancelled {
            emit(app, chat_id, StreamPayload::Cancelled);
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
        for tc in &agg.tool_calls {
            if cancel.load(Ordering::Relaxed) {
                emit(app, chat_id, StreamPayload::Cancelled);
                return Ok(());
            }

            emit(
                app,
                chat_id,
                StreamPayload::ToolCallExecuting {
                    index: 0,
                    name: tc.function.name.clone(),
                },
            );
            let result = tools::dispatch(
                &tc.function.name,
                &tc.function.arguments,
                &zone_config,
                &state.db,
                chat_id,
                project_dir.as_deref(),
                &state.http,
            )
            .await
            .unwrap_or_else(|e| {
                serde_json::json!({ "error": e.to_string() }).to_string()
            });

            // The tag tool mutates tags/chat_tags — tell the UI to refresh.
            if tc.function.name == "tag_chat" {
                let _ = app.emit(
                    "chat-tags-updated",
                    serde_json::json!({ "chatId": chat_id }),
                );
            }

            emit(
                app,
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
            .execute(&state.db)
            .await?;

            let saved_tool = sqlx::query_as::<_, Message>(&format!(
                "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
            ))
            .bind(&tool_msg_id)
            .fetch_one(&state.db)
            .await?;
            emit(
                app,
                chat_id,
                StreamPayload::ToolMessageSaved { message: &saved_tool },
            );

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
        // Loop for follow-up assistant turn
    }

    emit(app, chat_id, StreamPayload::Done);
    Ok(())
}

// ─── Perspective zone runners ─────────────────────────────────────────────────

async fn run_perspectives(
    app: &AppHandle,
    state: &AppState,
    chat_id: &str,
    cancel: Arc<AtomicBool>,
) {
    let zone_ids: Vec<String> =
        sqlx::query_scalar("SELECT zone_id FROM chat_zones WHERE chat_id = ?1")
            .bind(chat_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();

    if zone_ids.is_empty() {
        return;
    }

    let mut handles = Vec::new();
    for zone_id in zone_ids {
        let app = app.clone();
        let db = state.db.clone();
        let http = state.http.clone();
        let chat_id = chat_id.to_string();
        let cancel = cancel.clone();
        handles.push(tokio::spawn(async move {
            if let Err(e) =
                run_perspective(&app, &db, &http, &chat_id, &zone_id, cancel).await
            {
                tracing::warn!("perspective zone {zone_id} error: {e}");
                emit_persp(
                    &app,
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
    app: &AppHandle,
    db: &SqlitePool,
    http: &reqwest::Client,
    chat_id: &str,
    zone_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }

    let zone = sqlx::query_as::<_, Zone>(&format!(
        "SELECT {ZONE_COLS} FROM zones WHERE id = ?1"
    ))
    .bind(zone_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("perspective zone {zone_id}")))?;

    let provider_id = zone
        .provider_id
        .clone()
        .ok_or_else(|| AppError::Invalid("perspective zone has no provider".into()))?;
    let provider = sqlx::query_as::<_, Provider>(
        "SELECT id, name, base_url, api_key, created_at FROM providers WHERE id = ?1",
    )
    .bind(&provider_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("provider {provider_id}")))?;

    let api_messages = build_message_history(db, chat_id, &zone).await?;

    let msg_id = new_id();
    emit_persp(
        app,
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

    let client = crate::llm::client::LlmClient::new(http, &provider.base_url, provider.api_key.as_deref());
    let response = client.chat_stream(&req).await?;

    let app_clone = app.clone();
    let chat_id_clone = chat_id.to_string();
    let zone_id_clone = zone_id.to_string();

    let agg = crate::llm::streaming::consume_stream(response, cancel.clone(), move |ev| match ev {
        crate::llm::streaming::StreamEvent::Token { delta } => {
            emit_persp(&app_clone, &chat_id_clone, &zone_id_clone, StreamPayload::Token { delta });
        }
        crate::llm::streaming::StreamEvent::ThinkingToken { delta } => {
            emit_persp(
                &app_clone,
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
    .execute(db)
    .await?;

    let saved = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE id = ?1"
    ))
    .bind(&msg_id)
    .fetch_one(db)
    .await?;

    emit_persp(app, chat_id, zone_id, StreamPayload::AssistantSaved { message: &saved });

    if agg.cancelled {
        emit_persp(app, chat_id, zone_id, StreamPayload::Cancelled);
    } else {
        emit_persp(app, chat_id, zone_id, StreamPayload::Done);
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
                if let ContentPart::ImageUrl { image_url } = part {
                    image_url.detail = Some("low".to_string());
                }
            }
        }
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

async fn load_tool_context(state: &AppState) -> ToolContext {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?1")
        .bind("theme")
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    let theme = ThemePalette::from_settings_json(row.as_ref().map(|(v,)| v.as_str()));
    ToolContext { theme }
}
