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
