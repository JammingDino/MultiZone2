use crate::commands::{new_id, now_ts};
use crate::db::models::{Chat, ChatTagEntry, ChatZone, Message};
use crate::error::{AppError, AppResult};
use crate::llm::client::LlmClient;
use crate::llm::thinking::strip_thinking_blocks;
use crate::llm::types::{ChatMessage, ChatRequest, MessageContent};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

const CHAT_COLS: &str =
    "id, title, zone_id, project_id, project_context_enabled, perspective_mode, smart_routing, created_at, updated_at";

#[tauri::command]
pub async fn list_chats(state: State<'_, AppState>) -> AppResult<Vec<Chat>> {
    let rows = sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats ORDER BY updated_at DESC"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn create_chat(
    state: State<'_, AppState>,
    zone_id: Option<String>,
    project_id: Option<String>,
) -> AppResult<Chat> {
    let id = new_id();
    let now = now_ts();

    // Inherit default zone and default_context_enabled from project when set.
    let (effective_zone_id, project_context_enabled) = match &project_id {
        Some(pid) => {
            let row: Option<(Option<String>, bool)> = sqlx::query_as(
                "SELECT default_zone_id, default_context_enabled FROM projects WHERE id = ?1",
            )
            .bind(pid)
            .fetch_optional(&state.db)
            .await?;
            let (proj_zone, proj_ctx) = row.unwrap_or((None, false));
            let effective_zone = zone_id.clone().or(proj_zone);
            (effective_zone, proj_ctx)
        }
        None => (zone_id.clone(), false),
    };

    sqlx::query(
        "INSERT INTO chats (id, title, zone_id, project_id, project_context_enabled, created_at, updated_at)
         VALUES (?1, 'New Chat', ?2, ?3, ?4, ?5, ?5)",
    )
    .bind(&id)
    .bind(&effective_zone_id)
    .bind(&project_id)
    .bind(project_context_enabled)
    .bind(now)
    .execute(&state.db)
    .await?;

    let chat = sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(chat)
}

#[tauri::command]
pub async fn rename_chat(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> AppResult<()> {
    sqlx::query("UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(&title)
        .bind(now_ts())
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn set_chat_zone(
    state: State<'_, AppState>,
    id: String,
    zone_id: Option<String>,
) -> AppResult<()> {
    // Picking an explicit zone (or Quick chat = NULL) turns off smart routing.
    sqlx::query("UPDATE chats SET zone_id = ?1, smart_routing = 0, updated_at = ?2 WHERE id = ?3")
        .bind(&zone_id)
        .bind(now_ts())
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Toggle Smart chat for a chat. When enabled, the chat's zone is cleared and a
/// router picks the best zone to answer each turn.
#[tauri::command]
pub async fn set_chat_smart(
    state: State<'_, AppState>,
    id: String,
    smart: bool,
) -> AppResult<()> {
    if smart {
        sqlx::query("UPDATE chats SET smart_routing = 1, zone_id = NULL, updated_at = ?1 WHERE id = ?2")
            .bind(now_ts())
            .bind(&id)
            .execute(&state.db)
            .await?;
    } else {
        sqlx::query("UPDATE chats SET smart_routing = 0, updated_at = ?1 WHERE id = ?2")
            .bind(now_ts())
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_chat_project(
    state: State<'_, AppState>,
    chat_id: String,
    project_id: Option<String>,
) -> AppResult<()> {
    sqlx::query("UPDATE chats SET project_id = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(&project_id)
        .bind(now_ts())
        .bind(&chat_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn set_chat_project_context(
    state: State<'_, AppState>,
    chat_id: String,
    enabled: bool,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE chats SET project_context_enabled = ?1, updated_at = ?2 WHERE id = ?3",
    )
    .bind(enabled)
    .bind(now_ts())
    .bind(&chat_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn get_chat_tags(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<ChatTagEntry>> {
    let rows = sqlx::query_as::<_, ChatTagEntry>(
        "SELECT t.id AS tag_id, t.name, t.color, t.context_snippet, ct.context_enabled
         FROM chat_tags ct
         JOIN tags t ON t.id = ct.tag_id
         WHERE ct.chat_id = ?1
         ORDER BY t.name",
    )
    .bind(&chat_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

/// Every chat↔tag link in one query, for sidebar chips and tag-filtering.
#[tauri::command]
pub async fn get_all_chat_tags(state: State<'_, AppState>) -> AppResult<Vec<crate::db::models::ChatTagLink>> {
    let rows = sqlx::query_as::<_, crate::db::models::ChatTagLink>(
        "SELECT ct.chat_id, ct.tag_id, t.name, t.color
         FROM chat_tags ct
         JOIN tags t ON t.id = ct.tag_id
         ORDER BY t.name",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn add_chat_tag(
    state: State<'_, AppState>,
    chat_id: String,
    tag_id: String,
) -> AppResult<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO chat_tags (chat_id, tag_id, context_enabled) VALUES (?1, ?2, 0)",
    )
    .bind(&chat_id)
    .bind(&tag_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn remove_chat_tag(
    state: State<'_, AppState>,
    chat_id: String,
    tag_id: String,
) -> AppResult<()> {
    sqlx::query("DELETE FROM chat_tags WHERE chat_id = ?1 AND tag_id = ?2")
        .bind(&chat_id)
        .bind(&tag_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn set_chat_tag_context(
    state: State<'_, AppState>,
    chat_id: String,
    tag_id: String,
    enabled: bool,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE chat_tags SET context_enabled = ?1 WHERE chat_id = ?2 AND tag_id = ?3",
    )
    .bind(enabled)
    .bind(&chat_id)
    .bind(&tag_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

// ─── Perspective zones ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_chat_zones(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<ChatZone>> {
    let rows = sqlx::query_as::<_, ChatZone>(
        "SELECT chat_id, zone_id FROM chat_zones WHERE chat_id = ?1",
    )
    .bind(&chat_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn add_perspective_zone(
    state: State<'_, AppState>,
    chat_id: String,
    zone_id: String,
) -> AppResult<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO chat_zones (chat_id, zone_id) VALUES (?1, ?2)",
    )
    .bind(&chat_id)
    .bind(&zone_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Set the per-chat perspective execution mode override. Pass `None` to clear
/// the override and inherit the global default from app settings.
#[tauri::command]
pub async fn set_chat_perspective_mode(
    state: State<'_, AppState>,
    chat_id: String,
    mode: Option<String>,
) -> AppResult<()> {
    // Only persist recognised values; treat anything else as "inherit".
    let mode = mode.filter(|m| m == "sequential" || m == "parallel");
    sqlx::query("UPDATE chats SET perspective_mode = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(&mode)
        .bind(now_ts())
        .bind(&chat_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn remove_perspective_zone(
    state: State<'_, AppState>,
    chat_id: String,
    zone_id: String,
) -> AppResult<()> {
    sqlx::query("DELETE FROM chat_zones WHERE chat_id = ?1 AND zone_id = ?2")
        .bind(&chat_id)
        .bind(&zone_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Deletes the given message and everything chronologically after it in the same chat.
#[tauri::command]
pub async fn delete_messages_from(
    state: State<'_, AppState>,
    chat_id: String,
    message_id: String,
) -> AppResult<()> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT created_at FROM messages WHERE id = ?1 AND chat_id = ?2")
            .bind(&message_id)
            .bind(&chat_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((ts,)) = row else {
        return Err(AppError::NotFound(format!("message {message_id}")));
    };
    sqlx::query("DELETE FROM messages WHERE chat_id = ?1 AND created_at >= ?2")
        .bind(&chat_id)
        .bind(ts)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
        .bind(now_ts())
        .bind(&chat_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Deletes one participant's messages in the latest round (everything that
/// participant produced since the last user message). `zone_id = None` targets
/// the primary turn; `Some(z)` targets that perspective zone. Used by
/// per-participant regenerate so siblings and earlier rounds stay intact.
#[tauri::command]
pub async fn delete_participant_messages(
    state: State<'_, AppState>,
    chat_id: String,
    zone_id: Option<String>,
) -> AppResult<()> {
    let last_user_ts: Option<i64> = sqlx::query_scalar(
        "SELECT created_at FROM messages WHERE chat_id = ?1 AND role = 'user' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&chat_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(ts) = last_user_ts else { return Ok(()); };

    match zone_id {
        Some(z) => {
            sqlx::query(
                "DELETE FROM messages WHERE chat_id = ?1 AND created_at >= ?2 AND role != 'user' AND zone_id = ?3",
            )
            .bind(&chat_id)
            .bind(ts)
            .bind(&z)
            .execute(&state.db)
            .await?;
        }
        None => {
            sqlx::query(
                "DELETE FROM messages WHERE chat_id = ?1 AND created_at >= ?2 AND role != 'user' AND zone_id IS NULL",
            )
            .bind(&chat_id)
            .bind(ts)
            .execute(&state.db)
            .await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_chat(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM chats WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn get_messages(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<Message>> {
    let rows = sqlx::query_as::<_, Message>(
        "SELECT id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, created_at
         FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC",
    )
    .bind(&chat_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn generate_title(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<String> {
    sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(&chat_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("chat {chat_id}")))?;

    // Works for both zone-bound chats and simple/quick chats (synthetic zone).
    let (zone, provider) =
        crate::commands::messages::effective_zone_and_provider(&state.db, &chat_id).await?;

    let first_user = sqlx::query_as::<_, Message>(
        "SELECT id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, created_at
         FROM messages WHERE chat_id = ?1 AND role = 'user' ORDER BY created_at ASC LIMIT 1",
    )
    .bind(&chat_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Invalid("no user message yet".into()))?;

    let user_text = extract_text_from_content_json(&first_user.content);

    let prompt = format!(
        "Generate a very short title (3 to 6 words, no quotes, no period) summarizing this chat based on the user's first message. Respond with ONLY the title text — no preamble, no explanation, no thinking out loud.\n\nUser message:\n{user_text}"
    );

    let req = ChatRequest {
        model: zone.model.clone(),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: Some(MessageContent::Text(prompt)),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }],
        temperature: Some(0.4),
        max_tokens: Some(2048),
        top_p: None,
        tools: None,
        reasoning_effort: None,
        stream: false,
    };

    let client = LlmClient::new(&state.http, &provider.base_url, provider.api_key.as_deref());
    let resp = client.chat_completion(&req).await?;
    let title = resp
        .choices
        .first()
        .and_then(|c| match &c.message.content {
            Some(MessageContent::Text(s)) => Some(s.clone()),
            Some(MessageContent::Parts(parts)) => {
                let joined: String = parts
                    .iter()
                    .filter_map(|p| match p {
                        crate::llm::types::ContentPart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                if joined.is_empty() { None } else { Some(joined) }
            }
            None => None,
        })
        .unwrap_or_else(|| "New Chat".to_string());

    let title = strip_thinking_blocks(&title);
    let title = title
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .unwrap_or("")
        .to_string();
    let title = title.trim().trim_matches('"').trim_matches('\'').to_string();
    let title = if title.is_empty() { "New Chat".to_string() } else { title };

    sqlx::query("UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(&title)
        .bind(now_ts())
        .bind(&chat_id)
        .execute(&state.db)
        .await?;

    let _ = app.emit(
        "chat-title-updated",
        serde_json::json!({ "chatId": chat_id, "title": title }),
    );

    Ok(title)
}

fn extract_text_from_content_json(content_json: &str) -> String {
    if let Ok(parts) = serde_json::from_str::<Vec<serde_json::Value>>(content_json) {
        let mut buf = String::new();
        for p in parts {
            if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                    if !buf.is_empty() { buf.push('\n'); }
                    buf.push_str(t);
                }
            }
        }
        return buf;
    }
    content_json.to_string()
}
