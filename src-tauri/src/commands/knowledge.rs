//! Tauri commands for project knowledge (RAG, 0.4.3): configuring the embedding
//! model, (re)indexing the project directory, inspecting the index, and the
//! per-chat opt-in toggle. Retrieval itself happens through the `search_knowledge`
//! tool during a turn, not via a command.

use crate::commands::now_ts;
use crate::db::models::Project;
use crate::error::{AppError, AppResult};
use crate::knowledge::{self, IndexSummary, GLOBAL_KB_ID};
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

const PROJECT_COLS: &str = crate::commands::projects::PROJECT_COLS;

/// Read the app's default directory from the `app_settings` JSON blob.
async fn default_directory(state: &AppState) -> Option<String> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    raw.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("defaultDirectory")
                .and_then(|d| d.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(String::from)
        })
}

/// A row in the knowledge base viewer.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct KbDocument {
    pub id: String,
    pub path: String,
    pub title: String,
    pub chunk_count: i64,
    pub status: String,
    pub error: Option<String>,
    pub indexed_at: i64,
}

/// Index summary surfaced to the viewer header.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeStatus {
    pub document_count: i64,
    pub chunk_count: i64,
}

async fn fetch_project(state: &AppState, id: &str) -> AppResult<Project> {
    sqlx::query_as::<_, Project>(&format!("SELECT {PROJECT_COLS} FROM projects WHERE id = ?1"))
        .bind(id)
        .fetch_one(&state.db)
        .await
        .map_err(Into::into)
}

/// Set the project's embedding provider + model. Because the embedding model
/// defines the index's vector space, changing it (or the provider) invalidates
/// every stored chunk — so we clear the index and reset its indexed state,
/// forcing a fresh re-index. Setting the same values again is a no-op for data.
#[tauri::command]
pub async fn set_project_kb_config(
    state: State<'_, AppState>,
    project_id: String,
    provider_id: Option<String>,
    embedding_model: Option<String>,
) -> AppResult<Project> {
    apply_kb_config(&state, &project_id, provider_id, embedding_model).await?;
    knowledge::watcher::resync().await;
    fetch_project(&state, &project_id).await
}

/// Shared by per-project and global config. Changing the provider/model changes
/// the vector space, so the existing index is discarded and its indexed state
/// reset, forcing a fresh re-index.
async fn apply_kb_config(
    state: &AppState,
    project_id: &str,
    provider_id: Option<String>,
    embedding_model: Option<String>,
) -> AppResult<()> {
    let current = fetch_project(state, project_id).await?;
    let model = embedding_model.filter(|s| !s.trim().is_empty());
    let provider = provider_id.filter(|s| !s.trim().is_empty());

    let changed = current.kb_provider_id != provider || current.kb_embedding_model != model;
    if changed {
        // Different vector space — discard the old index (chunks cascade).
        sqlx::query("DELETE FROM kb_documents WHERE project_id = ?1")
            .bind(project_id)
            .execute(&state.db)
            .await?;
    }

    sqlx::query(
        "UPDATE projects SET kb_provider_id = ?1, kb_embedding_model = ?2,
           kb_dimensions = CASE WHEN ?4 THEN NULL ELSE kb_dimensions END,
           kb_indexed_at = CASE WHEN ?4 THEN NULL ELSE kb_indexed_at END,
           updated_at = ?3
         WHERE id = ?5",
    )
    .bind(&provider)
    .bind(&model)
    .bind(now_ts())
    .bind(changed)
    .bind(project_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Walk the project directory and (re)build its index. Long-running: embeds
/// every changed/new file via the configured provider.
#[tauri::command]
pub async fn index_project_knowledge(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<IndexSummary> {
    let summary = knowledge::index_project(&state.db, &state.http, &project_id).await?;
    // Now indexed → ensure it's being watched for live re-index.
    knowledge::watcher::resync().await;
    Ok(summary)
}

/// Counts for the viewer header.
#[tauri::command]
pub async fn get_knowledge_status(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<KnowledgeStatus> {
    let document_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM kb_documents WHERE project_id = ?1")
            .bind(&project_id)
            .fetch_one(&state.db)
            .await?;
    let chunk_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM kb_chunks WHERE project_id = ?1")
            .bind(&project_id)
            .fetch_one(&state.db)
            .await?;
    Ok(KnowledgeStatus { document_count, chunk_count })
}

/// Documents in the index, most-recently-indexed first.
#[tauri::command]
pub async fn list_knowledge_documents(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Vec<KbDocument>> {
    let rows = sqlx::query_as::<_, KbDocument>(
        "SELECT id, path, title, chunk_count, status, error, indexed_at
         FROM kb_documents WHERE project_id = ?1 ORDER BY indexed_at DESC, path ASC",
    )
    .bind(&project_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

/// Remove a single document (and its chunks) from the index.
#[tauri::command]
pub async fn remove_knowledge_document(
    state: State<'_, AppState>,
    document_id: String,
) -> AppResult<()> {
    sqlx::query("DELETE FROM kb_documents WHERE id = ?1")
        .bind(&document_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Wipe the project's entire index (keeps the embedding config).
#[tauri::command]
pub async fn clear_project_knowledge(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<()> {
    sqlx::query("DELETE FROM kb_documents WHERE project_id = ?1")
        .bind(&project_id)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE projects SET kb_dimensions = NULL, kb_indexed_at = NULL WHERE id = ?1")
        .bind(&project_id)
        .execute(&state.db)
        .await?;
    knowledge::watcher::resync().await;
    Ok(())
}

/// Per-chat opt-in for project knowledge.
#[tauri::command]
pub async fn set_chat_knowledge(
    state: State<'_, AppState>,
    chat_id: String,
    enabled: bool,
) -> AppResult<()> {
    sqlx::query("UPDATE chats SET knowledge_enabled = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(enabled)
        .bind(now_ts())
        .bind(&chat_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

// ─── Global knowledge base (default directory) ──────────────────────────────────

/// The default embedding config + global-KB index status, surfaced in
/// Settings → Knowledge. `directory` is the app's default directory (the global
/// KB's source); `configured` is whether an embedding provider+model is set.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalKbView {
    pub provider_id: Option<String>,
    pub embedding_model: Option<String>,
    pub directory: Option<String>,
    pub indexed_at: Option<i64>,
    pub dimensions: Option<i64>,
    pub document_count: i64,
    pub chunk_count: i64,
}

#[tauri::command]
pub async fn get_global_kb(state: State<'_, AppState>) -> AppResult<GlobalKbView> {
    knowledge::ensure_global_project(&state.db).await?;
    let project = fetch_project(&state, GLOBAL_KB_ID).await?;
    let document_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM kb_documents WHERE project_id = ?1")
            .bind(GLOBAL_KB_ID)
            .fetch_one(&state.db)
            .await?;
    let chunk_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM kb_chunks WHERE project_id = ?1")
            .bind(GLOBAL_KB_ID)
            .fetch_one(&state.db)
            .await?;
    Ok(GlobalKbView {
        provider_id: project.kb_provider_id,
        embedding_model: project.kb_embedding_model,
        directory: default_directory(&state).await,
        indexed_at: project.kb_indexed_at,
        dimensions: project.kb_dimensions,
        document_count,
        chunk_count,
    })
}

/// Set the global KB's embedding provider + model (also the default new projects
/// inherit). Changing it discards the global index.
#[tauri::command]
pub async fn set_global_kb_config(
    state: State<'_, AppState>,
    provider_id: Option<String>,
    embedding_model: Option<String>,
) -> AppResult<GlobalKbView> {
    knowledge::ensure_global_project(&state.db).await?;
    apply_kb_config(&state, GLOBAL_KB_ID, provider_id, embedding_model).await?;
    get_global_kb(state).await
}

/// (Re)index the app's default directory into the global knowledge base. The
/// global KB's directory is synced from the default-directory setting first.
#[tauri::command]
pub async fn index_global_knowledge(state: State<'_, AppState>) -> AppResult<IndexSummary> {
    knowledge::ensure_global_project(&state.db).await?;
    let dir = default_directory(&state)
        .await
        .ok_or_else(|| AppError::Provider("no default directory set in Settings".into()))?;
    sqlx::query("UPDATE projects SET directory = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(&dir)
        .bind(now_ts())
        .bind(GLOBAL_KB_ID)
        .execute(&state.db)
        .await?;
    let summary = knowledge::index_project(&state.db, &state.http, GLOBAL_KB_ID).await?;
    knowledge::watcher::resync().await;
    Ok(summary)
}

#[tauri::command]
pub async fn list_global_kb_documents(state: State<'_, AppState>) -> AppResult<Vec<KbDocument>> {
    let rows = sqlx::query_as::<_, KbDocument>(
        "SELECT id, path, title, chunk_count, status, error, indexed_at
         FROM kb_documents WHERE project_id = ?1 ORDER BY indexed_at DESC, path ASC",
    )
    .bind(GLOBAL_KB_ID)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn clear_global_knowledge(state: State<'_, AppState>) -> AppResult<()> {
    sqlx::query("DELETE FROM kb_documents WHERE project_id = ?1")
        .bind(GLOBAL_KB_ID)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE projects SET kb_dimensions = NULL, kb_indexed_at = NULL WHERE id = ?1")
        .bind(GLOBAL_KB_ID)
        .execute(&state.db)
        .await?;
    knowledge::watcher::resync().await;
    Ok(())
}
