use crate::error::AppResult;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn get_setting(
    state: State<'_, AppState>,
    key: String,
) -> AppResult<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM settings WHERE key = ?1")
            .bind(&key)
            .fetch_optional(&state.db)
            .await?;
    Ok(row.map(|(v,)| v))
}

#[tauri::command]
pub async fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(&key)
    .bind(&value)
    .execute(&state.db)
    .await?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStats {
    pub chats: i64,
    pub messages: i64,
    pub zones: i64,
    pub projects: i64,
    pub tags: i64,
}

#[tauri::command]
pub async fn get_db_stats(state: State<'_, AppState>) -> AppResult<DbStats> {
    let (chats,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chats")
        .fetch_one(&state.db).await?;
    let (messages,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages")
        .fetch_one(&state.db).await?;
    let (zones,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM zones")
        .fetch_one(&state.db).await?;
    let (projects,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM projects")
        .fetch_one(&state.db).await?;
    let (tags,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tags")
        .fetch_one(&state.db).await?;
    Ok(DbStats { chats, messages, zones, projects, tags })
}

/// Closes all DB connections, deletes the database file and attachments
/// directory, then exits the process. On next launch everything starts fresh.
#[tauri::command]
pub async fn reset_database(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    // Cancel any in-flight streams so they don't hold the pool open.
    state.active_streams.write().await.clear();
    // Drain the connection pool before deleting the file.
    state.db.close().await;

    let db_path = state.app_data_dir.join("multizone.db");
    if db_path.exists() {
        std::fs::remove_file(&db_path)?;
    }
    // Remove SQLx's write-ahead-log and shared-memory sidecar files if present.
    for ext in &["-wal", "-shm"] {
        let p = state.app_data_dir.join(format!("multizone.db{ext}"));
        if p.exists() { let _ = std::fs::remove_file(p); }
    }
    if state.attachments_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.attachments_dir);
    }

    app.exit(0);
    Ok(())
}
