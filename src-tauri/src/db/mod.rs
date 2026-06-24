pub mod models;

use crate::error::AppResult;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::time::Duration;

pub async fn init(app_data_dir: &Path) -> AppResult<SqlitePool> {
    let db_path = app_data_dir.join("multizone.db");

    // Use filename() directly to avoid Windows path issues with sqlite:// URL formatting.
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        // WAL permits one writer at a time. With perspective zones now writing
        // concurrently with the primary turn, make a blocked writer wait for the
        // lock instead of failing immediately with SQLITE_BUSY.
        .busy_timeout(Duration::from_secs(10))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use crate::db::models::Chat;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Regression guard for the send-breaking bug: every `SELECT ... FROM chats`
    /// that maps into the `Chat` struct must list ALL of the struct's columns,
    /// including the branching columns added in migration 013. The send path
    /// (`run_send`) does this query before persisting the user message, so a
    /// short column list silently broke message sending entirely.
    #[tokio::test]
    async fn chat_query_needs_all_struct_columns() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c1','t',0,0)")
            .execute(&pool)
            .await
            .unwrap();

        // The old list (missing parent_chat_id / branched_from_message_id) must
        // FAIL to decode into Chat — this is exactly what broke sending.
        let old_cols = "id, title, zone_id, project_id, project_context_enabled, perspective_mode, smart_routing, created_at, updated_at";
        let old = sqlx::query_as::<_, Chat>(&format!("SELECT {old_cols} FROM chats WHERE id='c1'"))
            .fetch_one(&pool)
            .await;
        assert!(old.is_err(), "short column list should fail to decode Chat");

        // The current constant must succeed.
        let new_cols = "id, title, zone_id, project_id, project_context_enabled, perspective_mode, smart_routing, parent_chat_id, branched_from_message_id, created_at, updated_at";
        let new = sqlx::query_as::<_, Chat>(&format!("SELECT {new_cols} FROM chats WHERE id='c1'"))
            .fetch_one(&pool)
            .await;
        assert!(new.is_ok(), "full column list should decode Chat: {new:?}");
    }
}
