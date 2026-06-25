use crate::commands::{new_id, now_ts};
use crate::db::models::Memory;
use crate::error::AppResult;
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;

/// Every memory entry across all scopes, newest first — backs the settings
/// viewer. Scope/owner names are resolved client-side from existing collections.
#[tauri::command]
pub async fn list_memories(state: State<'_, AppState>) -> AppResult<Vec<Memory>> {
    let rows = sqlx::query_as::<_, Memory>(
        "SELECT id, scope, scope_id, content, created_at, updated_at
         FROM memories ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInput {
    pub id: Option<String>,
    /// "global" | "project" | "chat"
    pub scope: String,
    pub scope_id: Option<String>,
    pub content: String,
}

/// Create or edit a memory entry from the viewer. Tools use the dedicated
/// `save_memory` handler instead (which also enforces the per-scope size cap).
#[tauri::command]
pub async fn upsert_memory(state: State<'_, AppState>, memory: MemoryInput) -> AppResult<Memory> {
    let id = memory.id.unwrap_or_else(new_id);
    let now = now_ts();
    let scope_id = match memory.scope.as_str() {
        "global" => None,
        _ => memory.scope_id,
    };
    sqlx::query(
        "INSERT INTO memories (id, scope, scope_id, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET
           scope = excluded.scope,
           scope_id = excluded.scope_id,
           content = excluded.content,
           updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(&memory.scope)
    .bind(&scope_id)
    .bind(&memory.content)
    .bind(now)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Memory>(
        "SELECT id, scope, scope_id, content, created_at, updated_at FROM memories WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn delete_memory(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM memories WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}
