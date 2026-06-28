use crate::commands::{new_id, now_ts};
use crate::db::models::{Project, Tag};
use crate::error::AppResult;
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;

// ─── Projects ────────────────────────────────────────────────────────────────

pub const PROJECT_COLS: &str = "id, name, icon, accent_color, default_zone_id, context_snippet, directory, default_context_enabled, kb_provider_id, kb_embedding_model, kb_dimensions, kb_indexed_at, kb_default_enabled, created_at, updated_at";

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    // The reserved global-KB project is hidden — it backs the default-directory
    // knowledge base, not a user-facing project.
    let rows = sqlx::query_as::<_, Project>(
        "SELECT id, name, icon, accent_color, default_zone_id, context_snippet, directory, default_context_enabled, kb_provider_id, kb_embedding_model, kb_dimensions, kb_indexed_at, kb_default_enabled, created_at, updated_at
         FROM projects WHERE id != ?1 ORDER BY name",
    )
    .bind(crate::knowledge::GLOBAL_KB_ID)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    pub id: Option<String>,
    pub name: String,
    pub icon: Option<String>,
    pub accent_color: Option<String>,
    pub default_zone_id: Option<String>,
    pub context_snippet: Option<String>,
    pub directory: Option<String>,
    pub default_context_enabled: Option<bool>,
}

#[tauri::command]
pub async fn upsert_project(state: State<'_, AppState>, project: ProjectInput) -> AppResult<Project> {
    let is_new = project.id.is_none();
    let id = project.id.unwrap_or_else(new_id);
    let now = now_ts();
    let default_context = project.default_context_enabled.unwrap_or(false);
    sqlx::query(
        "INSERT INTO projects (id, name, icon, accent_color, default_zone_id, context_snippet, directory, default_context_enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           icon = excluded.icon,
           accent_color = excluded.accent_color,
           default_zone_id = excluded.default_zone_id,
           context_snippet = excluded.context_snippet,
           directory = excluded.directory,
           default_context_enabled = excluded.default_context_enabled,
           updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(&project.name)
    .bind(&project.icon)
    .bind(&project.accent_color)
    .bind(&project.default_zone_id)
    .bind(&project.context_snippet)
    .bind(&project.directory)
    .bind(default_context)
    .bind(now)
    .execute(&state.db)
    .await?;

    // New projects inherit the global default embedding provider+model so the
    // user doesn't reconfigure it per project (they can still override it).
    if is_new {
        let (provider, model) = crate::knowledge::default_embedding_config(&state.db).await;
        if provider.is_some() || model.is_some() {
            sqlx::query(
                "UPDATE projects SET kb_provider_id = ?1, kb_embedding_model = ?2 WHERE id = ?3",
            )
            .bind(&provider)
            .bind(&model)
            .bind(&id)
            .execute(&state.db)
            .await?;
        }
    }

    let row = sqlx::query_as::<_, Project>(
        "SELECT id, name, icon, accent_color, default_zone_id, context_snippet, directory, default_context_enabled, kb_provider_id, kb_embedding_model, kb_dimensions, kb_indexed_at, kb_default_enabled, created_at, updated_at
         FROM projects WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    // Directory may have changed — re-sync the knowledge watcher.
    crate::knowledge::watcher::resync().await;
    Ok(row)
}

/// Delete a project. By default its chats are kept and moved to "Ungrouped"
/// (the `chats.project_id` FK is `ON DELETE SET NULL`). Pass `delete_chats =
/// true` to also delete every chat in the project (and, via cascade, their
/// messages) before removing the project.
#[tauri::command]
pub async fn delete_project(
    state: State<'_, AppState>,
    id: String,
    delete_chats: Option<bool>,
) -> AppResult<()> {
    if delete_chats.unwrap_or(false) {
        sqlx::query("DELETE FROM chats WHERE project_id = ?1")
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    sqlx::query("DELETE FROM projects WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    crate::knowledge::watcher::resync().await;
    Ok(())
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> AppResult<Vec<Tag>> {
    let rows = sqlx::query_as::<_, Tag>(
        "SELECT id, name, color, context_snippet, created_at, updated_at FROM tags ORDER BY name",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInput {
    pub id: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub context_snippet: Option<String>,
}

#[tauri::command]
pub async fn upsert_tag(state: State<'_, AppState>, tag: TagInput) -> AppResult<Tag> {
    let id = tag.id.unwrap_or_else(new_id);
    let now = now_ts();
    sqlx::query(
        "INSERT INTO tags (id, name, color, context_snippet, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           color = excluded.color,
           context_snippet = excluded.context_snippet,
           updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(&tag.name)
    .bind(&tag.color)
    .bind(&tag.context_snippet)
    .bind(now)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Tag>(
        "SELECT id, name, color, context_snippet, created_at, updated_at FROM tags WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn delete_tag(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM tags WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}
