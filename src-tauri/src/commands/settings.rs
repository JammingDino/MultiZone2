use crate::error::AppResult;
use crate::state::AppState;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

/// Settings keys mirrored to the installer-safe backup file. These are the
/// user-facing preferences (not seeding flags or transient state) that must
/// survive a version update even if the installer wipes the per-app data dir.
pub const BACKUP_KEYS: [&str; 3] = ["app_settings", "theme", "default_zone_id"];

/// Write the current values of [`BACKUP_KEYS`] to the installer-safe backup
/// file (a JSON map). The file lives *outside* the bundle-identifier app data
/// dir (see [`crate::state`]) so a reinstall/update that clears that dir doesn't
/// take the user's preferences with it. Best-effort: a failure here never blocks
/// the actual settings write.
pub async fn write_backup(db: &SqlitePool, backup_path: &Path) -> AppResult<()> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value FROM settings WHERE key IN ('app_settings', 'theme', 'default_zone_id')",
    )
    .fetch_all(db)
    .await?;
    let map: HashMap<String, String> = rows.into_iter().collect();
    if let Some(parent) = backup_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(backup_path, serde_json::to_string_pretty(&map)?)?;
    Ok(())
}

/// On startup, if the settings table has no `app_settings` row — i.e. a fresh or
/// installer-wiped database — restore the backed-up keys from the installer-safe
/// backup file. A genuine first-ever install has no backup, so this is a no-op
/// there. Best-effort: any error degrades to "start with defaults".
pub async fn restore_from_backup_if_empty(db: &SqlitePool, backup_path: &Path) -> AppResult<()> {
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await?;
    if existing.is_some() {
        return Ok(()); // DB already carries the user's settings — nothing to restore.
    }
    let Ok(raw) = std::fs::read_to_string(backup_path) else {
        return Ok(()); // No backup (first install) — start fresh.
    };
    let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&raw) else {
        return Ok(()); // Corrupt backup — don't block startup.
    };
    let mut restored = 0;
    for (k, v) in map {
        if !BACKUP_KEYS.contains(&k.as_str()) {
            continue;
        }
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(&k)
        .bind(&v)
        .execute(db)
        .await?;
        restored += 1;
    }
    if restored > 0 {
        tracing::info!("restored {restored} setting(s) from installer-safe backup");
    }
    Ok(())
}

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

/// Write one settings row.
///
/// `app` is here for the emit: a settings row is not only the window's own
/// state any more. The API and the `app_control` tool write these rows too, and
/// a theme the user asked a model to change has to actually change — otherwise
/// the write lands in the database and the open window keeps rendering the old
/// value until it is restarted, and then overwrites it on the next preference
/// the user touches. The window reloads the key it is told about; a write the
/// window itself made re-reads the value it just wrote, so there is no loop.
#[tauri::command]
pub async fn set_setting(
    app: AppHandle,
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
    // The default directory + auto-reindex toggle live in app_settings; re-sync
    // the knowledge watcher so a change takes effect immediately.
    if key == "app_settings" {
        crate::knowledge::watcher::resync().await;
        // Re-evaluate the markdown two-way-sync watch (mirror dir / enabled may
        // have changed).
        crate::commands::mirror::resync().await;
    }
    // Mirror user-facing preferences to the installer-safe backup so they survive
    // a version update that clears the per-app data dir. Best-effort — a failed
    // backup must not fail the settings write the user just made.
    if BACKUP_KEYS.contains(&key.as_str()) {
        if let Err(e) = write_backup(&state.db, &state.settings_backup_path).await {
            tracing::warn!("settings backup failed: {e}");
        }
    }
    let _ = app.emit("settings-updated", serde_json::json!({ "key": key }));
    Ok(())
}

/// Merge a JSON object into a settings row that already holds one, and return
/// the merged value.
///
/// Every user-facing preference lives in one of three JSON blobs (`theme`,
/// `app_settings`, and the per-key scalars), so "switch to dark mode" through
/// [`set_setting`] means read the blob, parse it, change one field, and write
/// the whole thing back — three round trips in which a preference the user
/// changes in the window is silently reverted by the stale copy the caller
/// started from. A merge is one call and only claims the keys it names.
///
/// Top-level merge only: a named key replaces its old value outright rather
/// than being merged into recursively. Deep-merging would make it impossible to
/// *remove* anything from a nested map (`colorsDark`, `visionOverrides`), and
/// "set this sub-map to exactly this" is the commoner intent.
pub async fn patch_setting(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    patch: serde_json::Map<String, serde_json::Value>,
) -> AppResult<serde_json::Value> {
    let existing: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?1")
        .bind(&key)
        .fetch_optional(&state.db)
        .await?;

    // An absent row starts from `{}` — the app's own defaults are applied on
    // read by whoever owns the blob, and inventing them here would be a second
    // copy of them.
    let mut merged = match existing.as_ref().map(|(v,)| serde_json::from_str(v)) {
        Some(Ok(serde_json::Value::Object(map))) => map,
        None => serde_json::Map::new(),
        Some(_) => {
            return Err(crate::error::AppError::Invalid(format!(
                "settings row '{key}' does not hold a JSON object, so it cannot be merged into; \
                 write it whole instead"
            )))
        }
    };
    for (k, v) in patch {
        merged.insert(k, v);
    }

    let value = serde_json::Value::Object(merged);
    set_setting(app, state, key, value.to_string()).await?;
    Ok(value)
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
    let (projects,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM projects WHERE id != ?1")
        .bind(crate::knowledge::GLOBAL_KB_ID)
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
    // Drop the installer-safe settings backup too, so the reset is a true fresh
    // start and isn't silently undone by restore-on-launch.
    if state.settings_backup_path.exists() {
        let _ = std::fs::remove_file(&state.settings_backup_path);
    }

    app.exit(0);
    Ok(())
}
