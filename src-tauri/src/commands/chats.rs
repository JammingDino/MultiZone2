use crate::commands::{new_id, now_ts};
use crate::db::models::{Chat, ChatTagEntry, ChatZone, Message};
use crate::error::{AppError, AppResult};
use crate::llm::client::LlmClient;
use crate::llm::thinking::strip_thinking_blocks;
use crate::llm::types::{ChatMessage, ChatRequest, MessageContent};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// Every column of the `chats` table, in `Chat` field order. Shared with
/// `commands::messages` — `query_as::<Chat>` fails to decode if the list and the
/// struct drift, so there must only ever be one of these.
pub const CHAT_COLS: &str =
    "id, title, zone_id, project_id, project_context_enabled, knowledge_enabled, perspective_mode, smart_routing, parent_chat_id, branched_from_message_id, initiated_by_zone_id, context_summary, context_summary_through, plan_mode, created_at, updated_at";

/// The global default for whether new chats start with knowledge enabled, read
/// from the `knowledgeDefaultEnabled` field of the `app_settings` JSON blob.
async fn knowledge_default_setting(db: &sqlx::SqlitePool) -> bool {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    raw.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("knowledgeDefaultEnabled").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

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

    // Global default for whether new chats start with knowledge enabled.
    let global_knowledge_default = knowledge_default_setting(&state.db).await;

    // Inherit default zone, default_context_enabled, and the knowledge default
    // from the project when set (the project's override beats the global setting).
    let (effective_zone_id, project_context_enabled, knowledge_enabled) = match &project_id {
        Some(pid) => {
            let row: Option<(Option<String>, bool, Option<bool>)> = sqlx::query_as(
                "SELECT default_zone_id, default_context_enabled, kb_default_enabled FROM projects WHERE id = ?1",
            )
            .bind(pid)
            .fetch_optional(&state.db)
            .await?;
            let (proj_zone, proj_ctx, proj_kb) = row.unwrap_or((None, false, None));
            let effective_zone = zone_id.clone().or(proj_zone);
            (effective_zone, proj_ctx, proj_kb.unwrap_or(global_knowledge_default))
        }
        None => (zone_id.clone(), false, global_knowledge_default),
    };

    sqlx::query(
        "INSERT INTO chats (id, title, zone_id, project_id, project_context_enabled, knowledge_enabled, created_at, updated_at)
         VALUES (?1, 'New Chat', ?2, ?3, ?4, ?5, ?6, ?6)",
    )
    .bind(&id)
    .bind(&effective_zone_id)
    .bind(&project_id)
    .bind(project_context_enabled)
    .bind(knowledge_enabled)
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

// ─── Multizone sub-agents (0.6.0) ───────────────────────────────────────────
// The sub-agent roster for a multizone session. The chat's primary `zone_id` is
// the leader; these are the zones it may delegate to via the subchat tools.
// Distinct from perspective `chat_zones`, which answer every turn.

#[tauri::command]
pub async fn get_chat_subagents(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<ChatZone>> {
    let rows = sqlx::query_as::<_, ChatZone>(
        "SELECT chat_id, zone_id FROM chat_subagents WHERE chat_id = ?1",
    )
    .bind(&chat_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

/// Replace a chat's entire sub-agent roster with `zone_ids`. Used by the
/// multizone session-start flow (and the in-chat roster editor) to set which
/// zones the leader may delegate to.
#[tauri::command]
pub async fn set_chat_subagents(
    state: State<'_, AppState>,
    chat_id: String,
    zone_ids: Vec<String>,
) -> AppResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM chat_subagents WHERE chat_id = ?1")
        .bind(&chat_id)
        .execute(&mut *tx)
        .await?;
    for zid in &zone_ids {
        sqlx::query("INSERT OR IGNORE INTO chat_subagents (chat_id, zone_id) VALUES (?1, ?2)")
            .bind(&chat_id)
            .bind(zid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    sqlx::query("UPDATE chats SET updated_at = ?1 WHERE id = ?2")
        .bind(now_ts())
        .bind(&chat_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

// ─── Stack tracer (0.6.1) ───────────────────────────────────────────────────

/// The full sub-agent call tree rooted at `chat_id`: every descendant subchat
/// (recursively), each with its conversational message count. Only true subchats
/// (`initiated_by_zone_id` set) are walked — branches, which share the
/// `parent_chat_id` link but have no owning zone, are excluded. The frontend
/// assembles the tree via `parent_chat_id` and scopes each assistant turn's
/// trace to the subchats it spawned (matched from the turn's tool results).
#[tauri::command]
pub async fn get_subchat_tree(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<crate::db::models::SubchatNode>> {
    let rows = sqlx::query_as::<_, crate::db::models::SubchatNode>(
        "WITH RECURSIVE descendants(id) AS (
            SELECT id FROM chats
              WHERE parent_chat_id = ?1 AND initiated_by_zone_id IS NOT NULL
            UNION ALL
            SELECT c.id FROM chats c
              JOIN descendants d ON c.parent_chat_id = d.id
              WHERE c.initiated_by_zone_id IS NOT NULL
         )
         SELECT c.id, c.title, c.zone_id, c.initiated_by_zone_id, c.parent_chat_id,
                (SELECT COUNT(*) FROM messages m
                   WHERE m.chat_id = c.id AND m.zone_id IS NULL
                     AND m.role IN ('user', 'assistant')) AS message_count,
                c.created_at
         FROM chats c
         JOIN descendants d ON c.id = d.id
         ORDER BY c.created_at ASC",
    )
    .bind(&chat_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

/// Forks a chat at `message_id` into a brand-new chat containing a copy of the
/// history up to that point. The source chat is untouched. The new chat is
/// linked back to the source via `parent_chat_id` / `branched_from_message_id`
/// so the sidebar can nest it under its parent. Returns the new chat.
///
/// `solo` picks up one participant's thread out of a multi-responder chat:
/// the branch answers with a single zone from here on (`zone_id`, or the
/// source's own primary zone when that's None) and inherits no perspective
/// roster. Branching from a user message leaves `solo` false, which keeps the
/// full roster — that's a "re-ask this", not a "follow this one answer".
///
/// Two cuts are involved, and they are not the same:
///
/// - Where the *history* ends. Branching from an assistant message copies its
///   whole round, siblings included, not just the rows that happen to predate
///   the clicked one. Participants finish at their own wall-clock times, so a
///   plain `created_at <= pivot` silently dropped whichever zones were still
///   thinking when the clicked one landed — you'd branch off the fast model and
///   lose the primary's answer from the last round.
/// - Where the *conversation* continues from. That's the pivot, unchanged.
///
/// Branching from a user message still cuts at the message itself, so the
/// answers to it are left behind and the branch re-asks.
#[tauri::command]
pub async fn branch_chat(
    state: State<'_, AppState>,
    chat_id: String,
    message_id: String,
    solo: Option<bool>,
    zone_id: Option<String>,
) -> AppResult<Chat> {
    let solo = solo.unwrap_or(false);

    // Resolve the pivot's timestamp and role — the role decides how far the copy
    // reaches past it.
    let pivot: Option<(i64, String)> =
        sqlx::query_as("SELECT created_at, role FROM messages WHERE id = ?1 AND chat_id = ?2")
            .bind(&message_id)
            .bind(&chat_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((pivot_ts, pivot_role)) = pivot else {
        return Err(AppError::NotFound(format!("message {message_id}")));
    };

    // For an assistant pivot, extend the copy to the end of its round — up to
    // (but not including) the next user message — so every participant's answer
    // to the same question comes along.
    let copy_through_ts: i64 = if pivot_role == "user" {
        pivot_ts
    } else {
        let round_start: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(created_at) FROM messages
             WHERE chat_id = ?1 AND role = 'user' AND created_at <= ?2",
        )
        .bind(&chat_id)
        .bind(pivot_ts)
        .fetch_optional(&state.db)
        .await?
        .flatten();
        match round_start {
            Some(start) => {
                let next_user: Option<i64> = sqlx::query_scalar(
                    "SELECT MIN(created_at) FROM messages
                     WHERE chat_id = ?1 AND role = 'user' AND created_at > ?2",
                )
                .bind(&chat_id)
                .bind(start)
                .fetch_optional(&state.db)
                .await?
                .flatten();
                // Timestamps are milliseconds; stopping one short of the next
                // user message keeps the bound inclusive like the pivot case.
                // No later user message means this is the last round, so the
                // rest of the chat is exactly that round.
                next_user.map(|t| t - 1).unwrap_or(i64::MAX)
            }
            // An assistant message with no user message before it shouldn't
            // happen, but if it does there's no round to complete — cut at the
            // pivot rather than sweeping in every later round too.
            None => pivot_ts,
        }
    };

    let source = sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(&chat_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("chat {chat_id}")))?;

    let new_id = new_id();
    let now = now_ts();
    let new_title = format!("{} (branch)", source.title);

    // Soloing pins the branch to one zone: the clicked perspective, or the
    // source's own primary zone when the primary card was the one clicked
    // (which may be None — a Quick chat stays a Quick chat). Pinning a zone also
    // switches smart routing off, since the zone is no longer up for debate.
    let branch_zone_id = if solo {
        zone_id.clone().or_else(|| source.zone_id.clone())
    } else {
        source.zone_id.clone()
    };
    let branch_smart_routing = source.smart_routing && !(solo && zone_id.is_some());

    // Create the branch, inheriting the source's chat-level settings and linking
    // it back to the parent at the pivot message.
    sqlx::query(
        "INSERT INTO chats
           (id, title, zone_id, project_id, project_context_enabled, knowledge_enabled, perspective_mode,
            smart_routing, parent_chat_id, branched_from_message_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
    )
    .bind(&new_id)
    .bind(&new_title)
    .bind(&branch_zone_id)
    .bind(&source.project_id)
    .bind(source.project_context_enabled)
    .bind(source.knowledge_enabled)
    .bind(&source.perspective_mode)
    .bind(branch_smart_routing)
    .bind(&chat_id)
    .bind(&message_id)
    .bind(now)
    .execute(&state.db)
    .await?;

    // Copy messages up to and including the pivot. Each gets a fresh primary key;
    // tool_call_id is the model-supplied id (not a row PK) so copying it verbatim
    // keeps tool calls matched within the branch. Map old→new ids for attachments.
    let msgs = sqlx::query_as::<_, Message>(
        "SELECT id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, edited, created_at
         FROM messages WHERE chat_id = ?1 AND created_at <= ?2 ORDER BY created_at ASC",
    )
    .bind(&chat_id)
    .bind(copy_through_ts)
    .fetch_all(&state.db)
    .await?;

    let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for m in &msgs {
        let nid = crate::commands::new_id();
        id_map.insert(m.id.clone(), nid.clone());
        sqlx::query(
            "INSERT INTO messages
               (id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, edited, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )
        .bind(&nid)
        .bind(&new_id)
        .bind(&m.role)
        .bind(&m.content)
        .bind(&m.tool_calls)
        .bind(&m.tool_call_id)
        .bind(&m.reasoning)
        .bind(&m.zone_id)
        .bind(&m.active_zone_id)
        .bind(m.edited)
        .bind(m.created_at)
        .execute(&state.db)
        .await?;
    }

    // Copy attachments for the copied messages, remapping to the new message ids.
    let attachments = sqlx::query_as::<_, crate::db::models::Attachment>(
        "SELECT id, message_id, chat_id, file_name, file_type, storage_path, content, page_count, created_at
         FROM attachments WHERE chat_id = ?1 AND created_at <= ?2",
    )
    .bind(&chat_id)
    .bind(copy_through_ts)
    .fetch_all(&state.db)
    .await?;
    for a in &attachments {
        // Drop attachments whose owning message wasn't copied (defensive).
        let new_msg_id = match &a.message_id {
            Some(mid) => match id_map.get(mid) {
                Some(nid) => Some(nid.clone()),
                None => continue,
            },
            None => None,
        };
        sqlx::query(
            "INSERT INTO attachments
               (id, message_id, chat_id, file_name, file_type, storage_path, content, page_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .bind(crate::commands::new_id())
        .bind(&new_msg_id)
        .bind(&new_id)
        .bind(&a.file_name)
        .bind(&a.file_type)
        .bind(&a.storage_path)
        .bind(&a.content)
        .bind(a.page_count)
        .bind(a.created_at)
        .execute(&state.db)
        .await?;
    }

    // Inherit tag links (and their per-chat context toggles).
    sqlx::query(
        "INSERT INTO chat_tags (chat_id, tag_id, context_enabled)
         SELECT ?1, tag_id, context_enabled FROM chat_tags WHERE chat_id = ?2",
    )
    .bind(&new_id)
    .bind(&chat_id)
    .execute(&state.db)
    .await?;

    // Inherit perspective zones — unless this branch is following one
    // participant, in which case an empty roster is the whole point: the copied
    // history still shows every zone's answers, but only the chosen one speaks
    // from here.
    if !solo {
        sqlx::query(
            "INSERT INTO chat_zones (chat_id, zone_id)
             SELECT ?1, zone_id FROM chat_zones WHERE chat_id = ?2",
        )
        .bind(&new_id)
        .bind(&chat_id)
        .execute(&state.db)
        .await?;
    }

    let chat = sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats WHERE id = ?1"
    ))
    .bind(&new_id)
    .fetch_one(&state.db)
    .await?;
    Ok(chat)
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
    // Remove the chat's mirrored markdown file too (0.7.2).
    crate::commands::mirror::unmirror_chat_best_effort(&state.db, &id).await;
    // Tear down any persistent WSL shell owned by this chat, so deleting a chat
    // does not leave an orphaned `bash` running until the idle reaper notices.
    crate::tools::wsl::close_session(&id).await;
    // Terminals are never reaped on idle, so a deleted chat's are only ever
    // stopped here or at app exit.
    crate::tools::terminal::close_session(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn get_messages(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<Message>> {
    let rows = sqlx::query_as::<_, Message>(
        "SELECT id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, edited, created_at
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
    // Forced regenerations title the conversation as it now stands; the
    // automatic first-turn pass only has the opening message to go on.
    whole_conversation: Option<bool>,
) -> AppResult<String> {
    let whole_conversation = whole_conversation.unwrap_or(false);
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

    let convo = build_title_context(&state.db, &zone, &chat_id, whole_conversation).await?;
    if convo.is_empty() {
        return Err(AppError::Invalid("no user message yet".into()));
    }

    let subject = if whole_conversation {
        "the conversation above. Weigh what the conversation actually turned out to be about, not only how it opened"
    } else {
        "the message above"
    };
    // Name the topic as a noun phrase: "History of Mechanical Pencils", not
    // "Researching the History of Mechanical Pencils" — the chat list is a list
    // of subjects, and a leading verb spends a word restating that it's a chat.
    let instruction = format!(
        "Reply with a title for {subject}. Rules: 3 to 6 words; a noun phrase naming the \
         topic, not a sentence and not starting with a verb; no quotes, no trailing period, \
         no label like \"Title:\". Do not think, explain, or list options — your entire reply \
         must be the title itself and nothing else."
    );

    // The conversation goes in as real messages — same shape the model sees on
    // an ordinary turn, images and all — with the instruction appended last.
    // Deliberately omitted: the system prompt, memories, skills and tools. A
    // title needs the content, not the zone's whole operating context.
    let mut messages = convo;
    messages.push(ChatMessage {
        role: "user".into(),
        content: Some(MessageContent::Text(instruction)),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    });

    let req = ChatRequest {
        model: zone.model.clone(),
        messages,
        temperature: Some(0.4),
        max_tokens: Some(TITLE_MAX_TOKENS),
        top_p: None,
        tools: None,
        tool_choice: None,
        reasoning_effort: None,
        chat_template_kwargs: None,
        stream_options: None,
        stream: false,
    };

    // Titling is a small request, but it is a request, and it is charged for.
    let measure = {
        let cpt = crate::llm::tokens::chars_per_token(&state.db, &req.model).await;
        crate::llm::tokens::measure_request(&req, cpt)
    };
    let model = req.model.clone();

    let client = LlmClient::new(&state.http, &provider.base_url, provider.api_key.as_deref());
    let resp = request_title(&client, req).await?;
    crate::llm::tokens::record_request(&state.db, &chat_id, &model, &measure, resp.usage.as_ref())
        .await;
    let raw = resp
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
        .unwrap_or_default();

    // A model that thought out loud anyway leaves nothing usable behind — a
    // truncated ramble, or a stray line of its own reasoning. Rather than
    // hanging that on the chat, fall back to the opening message's own words.
    let title = match clean_title_candidate(&raw) {
        Some(t) => t,
        None => {
            tracing::debug!("title response wasn't a usable title; falling back to the first message");
            fallback_title(&state.db, &chat_id).await
        }
    };

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

    // The title lives in the mirror's frontmatter + filename (0.7.2).
    crate::commands::mirror::mirror_chat_best_effort(&state.db, &chat_id).await;

    Ok(title)
}

/// Per-message text budget for title context — enough to characterise a turn,
/// short of resending an entire long answer just to name the chat.
const TITLE_TEXT_BUDGET: usize = 2000;
/// Images are by far the expensive part of the request, and they only ever earn
/// their place when there is no text to name the chat from — so at most one, and
/// only from a message that said nothing.
const TITLE_MAX_IMAGES: usize = 1;
/// Output ceiling for the title call — roughly 200 words. A title is a handful
/// of words; anything approaching this is a model thinking out loud, which is
/// cut off rather than paid for. Truncation is safe: what comes back then fails
/// [`clean_title_candidate`] and the chat is named from its opening message.
const TITLE_MAX_TOKENS: i64 = 256;
/// Longest a generated title may be. Past this it isn't a title, it's prose.
const TITLE_MAX_CHARS: usize = 80;
/// Most words a generated title may have. The prompt asks for 3–6; this is the
/// outer bound past which the reply is something other than a title.
const TITLE_MAX_WORDS: usize = 10;

/// Ask for the title with thinking switched off, falling back to a plain
/// request if the provider won't take the switches.
///
/// There is no portable way to turn a thinking model's reasoning off: local
/// servers (vLLM, SGLang, llama.cpp, LM Studio) read `chat_template_kwargs`,
/// newer hosted models read `reasoning_effort: "none"`, and older hosted
/// reasoning models reject both — OpenAI 400s on an unrecognised field, and on
/// `"none"` for the o-series. So both go out on the first attempt and a failure
/// retries clean. Titling is a cheap background call; one wasted round trip
/// against a provider that refuses is a better trade than leaving reasoning on
/// for everyone else, which is what produced titles made of thinking output.
async fn request_title(
    client: &LlmClient<'_>,
    plain: ChatRequest,
) -> AppResult<crate::llm::types::ChatResponse> {
    let quiet = ChatRequest {
        reasoning_effort: Some("none".to_string()),
        chat_template_kwargs: Some(serde_json::json!({ "enable_thinking": false })),
        ..plain.clone()
    };
    match client.chat_completion(&quiet).await {
        Ok(resp) => Ok(resp),
        Err(e) => {
            tracing::debug!("title request refused with thinking disabled ({e}); retrying plain");
            client.chat_completion(&plain).await
        }
    }
}

/// Pull a usable title out of a model's reply, or `None` if there isn't one.
///
/// The reply is supposed to be the title and nothing else, and often isn't:
/// reasoning models narrate first, some wrap the answer in quotes or a
/// `Title:` label, and a reply cut off mid-thought carries no answer at all.
/// Taking the last non-empty line and hoping is what put "Here's a thinking
/// process:" in the chat list — so the candidate is cleaned, then checked
/// against what a title can actually look like, and rejected outright if it
/// doesn't fit.
fn clean_title_candidate(raw: &str) -> Option<String> {
    // Tagged reasoning goes first, including an unterminated block (a truncated
    // response), which takes everything after the opening tag with it.
    let stripped = strip_thinking_blocks(raw);
    let line = stripped.lines().map(str::trim).filter(|l| !l.is_empty()).next_back()?;

    // Markdown decoration, a leading list marker, and the label a model reaches
    // for when it can't just answer.
    let mut t = line.trim_start_matches(['-', '*', '•', '#', '>']).trim();
    for label in ["Title:", "title:", "TITLE:", "Final:", "Chat title:", "Output:"] {
        if let Some(rest) = t.strip_prefix(label) {
            t = rest.trim();
        }
    }
    let t = t
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '*' || c == '#')
        .trim()
        .trim_end_matches('.')
        .trim();

    if t.is_empty() || t.chars().count() > TITLE_MAX_CHARS {
        return None;
    }
    // A trailing colon means a heading over something that got cut off; a code
    // fence or tag means the model is still mid-output.
    if t.ends_with(':') || t.contains("```") || t.contains('<') {
        return None;
    }
    let words = t.split_whitespace().count();
    if words == 0 || words > TITLE_MAX_WORDS {
        return None;
    }
    // Must read as a name, not punctuation or a numbered step.
    if !t.chars().any(|c| c.is_alphanumeric()) {
        return None;
    }
    Some(t.to_string())
}

/// Name the chat from its own opening message — the same thing the app does
/// when automatic titling is switched off. Used when the model's reply isn't a
/// title, which beats hanging "New Chat" (or a line of reasoning) on a chat
/// whose first message says exactly what it's about.
async fn fallback_title(db: &sqlx::SqlitePool, chat_id: &str) -> String {
    let first: Option<(String,)> = sqlx::query_as(
        "SELECT content FROM messages WHERE chat_id = ?1 AND role = 'user'
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    let text = first
        .map(|(c,)| extract_text_from_content_json(&c))
        .unwrap_or_default();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return "New Chat".to_string();
    }
    let short = truncate_chars(&text, TITLE_MAX_CHARS - 1);
    short.trim().to_string()
}

/// Builds the conversation the title model sees.
///
/// Images are the exception, not the rule (0.9.9): a message that carries any
/// text is titled from that text, and only a wordless turn — a bare screenshot
/// with nothing said about it — sends its image, at low detail, at most one per
/// request, and only to a model that accepts image input. Everything else names
/// the attachment in a line of text so the model knows the turn wasn't empty.
///
/// Tool traffic is dropped entirely: tool calls, tool results, and the
/// assistant messages that carry nothing but a tool call. What a chat is
/// *about* lives in the prose.
async fn build_title_context(
    db: &sqlx::SqlitePool,
    zone: &crate::db::models::Zone,
    chat_id: &str,
    whole_conversation: bool,
) -> AppResult<Vec<ChatMessage>> {
    let rows = if whole_conversation {
        sqlx::query_as::<_, Message>(
            "SELECT id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, edited, created_at
             FROM messages
             WHERE chat_id = ?1 AND zone_id IS NULL AND role IN ('user', 'assistant')
             ORDER BY created_at ASC",
        )
        .bind(chat_id)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_as::<_, Message>(
            "SELECT id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, edited, created_at
             FROM messages WHERE chat_id = ?1 AND role = 'user' ORDER BY created_at ASC LIMIT 1",
        )
        .bind(chat_id)
        .fetch_optional(db)
        .await?
        .into_iter()
        .collect()
    };

    // Same resolution order as an ordinary turn: the user's per-model override
    // beats the name heuristic, so a model they've marked vision-capable keeps
    // its images here too.
    let vision_capable =
        match crate::commands::messages::vision_override(db, &zone.model).await.as_deref() {
            Some("on") => true,
            Some("off") => false,
            _ => crate::ocr::is_vision_capable(&zone.model),
        };

    let mut out: Vec<ChatMessage> = Vec::new();
    let mut images_used = 0usize;

    for m in rows {
        let stored: Vec<crate::llm::types::ContentPart> =
            serde_json::from_str(&m.content).unwrap_or_default();

        // Text first, images second: whether an image is worth sending depends
        // on whether this message said anything, which isn't known until every
        // part has been walked.
        let mut parts: Vec<crate::llm::types::ContentPart> = Vec::new();
        let mut images: Vec<crate::llm::types::ImageUrl> = Vec::new();
        let mut text_len = 0usize;
        for p in stored {
            match p {
                crate::llm::types::ContentPart::Text { text }
                | crate::llm::types::ContentPart::HiddenText { text } => {
                    let text = if m.role == "assistant" {
                        strip_thinking_blocks(&text)
                    } else {
                        text
                    };
                    let text = text.trim().to_string();
                    if text.is_empty() || text_len >= TITLE_TEXT_BUDGET {
                        continue;
                    }
                    let text = truncate_chars(&text, TITLE_TEXT_BUDGET - text_len);
                    text_len += text.chars().count();
                    parts.push(crate::llm::types::ContentPart::Text { text });
                }
                crate::llm::types::ContentPart::ImageUrl { image_url }
                | crate::llm::types::ContentPart::HiddenImage { image_url } => {
                    images.push(image_url);
                }
            }
        }

        // A message that carries text is titled from that text alone — sending
        // the screenshot alongside it costs far more than the words it adds.
        // Only a wordless turn ("<photo>") needs the image, and then just the
        // first one, once per request.
        if text_len == 0 && !images.is_empty() {
            if vision_capable && images_used < TITLE_MAX_IMAGES {
                images_used += 1;
                let mut image_url = images.swap_remove(0);
                image_url.detail = Some("low".to_string());
                parts.push(crate::llm::types::ContentPart::ImageUrl { image_url });
            } else {
                // No vision (or the one image is already spent) — name the
                // attachment so the model knows the turn wasn't empty.
                parts.push(crate::llm::types::ContentPart::Text {
                    text: "[image attachment]".to_string(),
                });
            }
        }

        if parts.is_empty() {
            continue;
        }
        let content = if parts.len() == 1 {
            match &parts[0] {
                crate::llm::types::ContentPart::Text { text } => {
                    Some(MessageContent::Text(text.clone()))
                }
                _ => Some(MessageContent::Parts(parts)),
            }
        } else {
            Some(MessageContent::Parts(parts))
        };
        out.push(ChatMessage {
            role: m.role,
            content,
            tool_calls: None,
            tool_call_id: None,
            name: None,
        });
    }

    Ok(out)
}

/// Truncate on a character boundary (byte slicing panics on multi-byte input).
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

/// Best-effort plain text out of a stored message's JSON content parts.
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

#[cfg(test)]
mod title_tests {
    use super::*;

    #[test]
    fn accepts_a_bare_title() {
        assert_eq!(
            clean_title_candidate("History of Mechanical Pencils").as_deref(),
            Some("History of Mechanical Pencils")
        );
    }

    #[test]
    fn strips_decoration_and_labels() {
        for raw in [
            "\"History of Mechanical Pencils\"",
            "**History of Mechanical Pencils**",
            "Title: History of Mechanical Pencils",
            "- History of Mechanical Pencils",
            "History of Mechanical Pencils.",
        ] {
            assert_eq!(
                clean_title_candidate(raw).as_deref(),
                Some("History of Mechanical Pencils"),
                "failed on {raw:?}"
            );
        }
    }

    #[test]
    fn takes_the_answer_after_tagged_reasoning() {
        let raw = "<think>Let me consider a few options for this.</think>\nHistory of Mechanical Pencils";
        assert_eq!(
            clean_title_candidate(raw).as_deref(),
            Some("History of Mechanical Pencils")
        );
    }

    #[test]
    fn rejects_reasoning_cut_off_mid_thought() {
        // An unterminated block leaves nothing behind, so there is no title.
        let raw = "<think>Here's a thinking process:\n1. Analyze User Input";
        assert_eq!(clean_title_candidate(raw), None);
    }

    #[test]
    fn rejects_untagged_thinking_left_as_the_last_line() {
        // The failure this guards: reasoning narrated as plain text, truncated
        // before the model ever wrote a title.
        for raw in [
            "Here's a thinking process:",
            "Brainstorming Titles:",
            "3. Determine Title Requirements:",
            "I'll go with the simplest option, which names the topic directly and reads well in a list",
        ] {
            assert_eq!(clean_title_candidate(raw), None, "should reject {raw:?}");
        }
    }

    #[test]
    fn rejects_empty_and_junk() {
        assert_eq!(clean_title_candidate(""), None);
        assert_eq!(clean_title_candidate("   \n  \n"), None);
        assert_eq!(clean_title_candidate("---"), None);
        assert_eq!(clean_title_candidate("```"), None);
    }
}
