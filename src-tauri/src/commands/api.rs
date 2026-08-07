//! Tauri commands controlling the embedded HTTP API server lifecycle, plus a
//! startup helper that launches it if enabled in the persisted settings.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::{AppHandle, Manager, State};

/// Persisted API config, read from the `app_settings` JSON blob.
struct ApiConfig {
    enabled: bool,
    port: u16,
    token: String,
}

fn read_api_config(app_settings_json: Option<&str>) -> ApiConfig {
    let v: serde_json::Value = app_settings_json
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Null);
    ApiConfig {
        enabled: v.get("apiEnabled").and_then(|b| b.as_bool()).unwrap_or(false),
        port: v
            .get("apiPort")
            .and_then(|p| p.as_u64())
            .filter(|p| *p > 0 && *p <= 65535)
            .map(|p| p as u16)
            .unwrap_or(8765),
        token: v
            .get("apiToken")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

/// What happened the last time the app tried to bind the API socket (0.11.0).
///
/// Previously the bind result was reported once, synchronously, to whoever
/// called `apply_api_settings` — and then forgotten. A port already in use left
/// the Settings toggle reading "on" with nothing behind it, and neither a
/// script nor a model could find out. It is a settings row now, so `/api/health`
/// and the Settings panel read the same answer.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindState {
    pub ok: bool,
    pub port: u16,
    /// Why the bind failed, in the OS's own words.
    pub error: Option<String>,
    pub at: i64,
}

const BIND_STATE_KEY: &str = "api_bind_state";

pub async fn read_bind_state(db: &sqlx::SqlitePool) -> Option<BindState> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(BIND_STATE_KEY)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    raw.and_then(|s| serde_json::from_str(&s).ok())
}

async fn write_bind_state(db: &sqlx::SqlitePool, state: &BindState) {
    let Ok(json) = serde_json::to_string(state) else { return };
    let _ = sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(BIND_STATE_KEY)
    .bind(json)
    .execute(db)
    .await;
}

/// The bind outcome, for the Settings panel — the same row `/api/health`
/// reports, so the two can't tell different stories.
#[tauri::command]
pub async fn api_bind_state(state: State<'_, AppState>) -> AppResult<Option<BindState>> {
    Ok(read_bind_state(&state.db).await)
}

/// Stop the running server (if any).
async fn stop_running(state: &AppState) {
    if let Some(handle) = state.api_server.lock().await.take() {
        handle.stop();
    }
}

/// (Re)start or stop the server to match the requested settings. Called by the
/// Settings UI whenever the API config changes.
#[tauri::command]
pub async fn apply_api_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    port: u16,
    token: String,
) -> AppResult<()> {
    stop_running(&state).await;

    if !enabled {
        // Off is not a failed bind — record it as such rather than leaving the
        // last run's outcome sitting there looking current.
        write_bind_state(
            &state.db,
            &BindState { ok: false, port, error: Some("disabled in settings".into()), at: crate::commands::now_ts() },
        )
        .await;
        return Ok(());
    }
    if token.trim().is_empty() {
        return Err(AppError::Invalid("API token must not be empty".into()));
    }

    let started = crate::api::start(
        app.clone(),
        state.db.clone(),
        state.http.clone(),
        state.active_streams.clone(),
        state.tool_approvals.clone(),
        port,
        token,
    )
    .await;

    let handle = match started {
        Ok(handle) => handle,
        Err(e) => {
            let message = e.to_string();
            write_bind_state(
                &state.db,
                &BindState { ok: false, port, error: Some(message.clone()), at: crate::commands::now_ts() },
            )
            .await;
            return Err(AppError::Other(format!("failed to start API server: {message}")));
        }
    };

    write_bind_state(
        &state.db,
        &BindState { ok: true, port, error: None, at: crate::commands::now_ts() },
    )
    .await;
    *state.api_server.lock().await = Some(handle);
    Ok(())
}

/// Generate a fresh random bearer token for the API.
#[tauri::command]
pub fn generate_api_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Launch the server on app startup if it is enabled in persisted settings.
pub async fn start_if_enabled(app: &AppHandle) {
    let state = app.state::<AppState>();

    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let cfg = read_api_config(raw.as_deref());
    if !cfg.enabled || cfg.token.trim().is_empty() {
        let why = if cfg.enabled { "no API token is set" } else { "disabled in settings" };
        write_bind_state(
            &state.db,
            &BindState { ok: false, port: cfg.port, error: Some(why.into()), at: crate::commands::now_ts() },
        )
        .await;
        return;
    }

    match crate::api::start(
        app.clone(),
        state.db.clone(),
        state.http.clone(),
        state.active_streams.clone(),
        state.tool_approvals.clone(),
        cfg.port,
        cfg.token,
    )
    .await
    {
        Ok(handle) => {
            write_bind_state(
                &state.db,
                &BindState { ok: true, port: cfg.port, error: None, at: crate::commands::now_ts() },
            )
            .await;
            *state.api_server.lock().await = Some(handle);
        }
        Err(e) => {
            // The failure a user actually hits: the port is taken, and until
            // now the only trace was a log line nobody reads while the toggle
            // still said "on".
            tracing::error!("API server failed to start on launch: {e}");
            write_bind_state(
                &state.db,
                &BindState {
                    ok: false,
                    port: cfg.port,
                    error: Some(e.to_string()),
                    at: crate::commands::now_ts(),
                },
            )
            .await;
        }
    }
}
