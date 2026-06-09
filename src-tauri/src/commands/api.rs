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
        return Ok(());
    }
    if token.trim().is_empty() {
        return Err(AppError::Invalid("API token must not be empty".into()));
    }

    let handle = crate::api::start(
        app.clone(),
        state.db.clone(),
        state.http.clone(),
        state.active_streams.clone(),
        state.tool_approvals.clone(),
        port,
        token,
    )
    .await
    .map_err(|e| AppError::Other(format!("failed to start API server: {e}")))?;

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
            *state.api_server.lock().await = Some(handle);
        }
        Err(e) => tracing::error!("API server failed to start on launch: {e}"),
    }
}
