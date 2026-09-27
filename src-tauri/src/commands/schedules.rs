//! Scheduled runs, as the window and the API see them (0.18). See `schedule`.

use crate::error::{AppError, AppResult};
use crate::schedule::{self, ScheduleInput, ScheduledRun};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

fn changed(app: &AppHandle) {
    let _ = app.emit("schedules-changed", serde_json::json!({}));
}

#[tauri::command]
pub async fn list_scheduled_runs(state: State<'_, AppState>) -> AppResult<Vec<ScheduledRun>> {
    schedule::list(&state.db).await
}

#[tauri::command]
pub async fn upsert_scheduled_run(
    app: AppHandle,
    state: State<'_, AppState>,
    run: ScheduleInput,
) -> AppResult<ScheduledRun> {
    let out = schedule::upsert(&state.db, run).await?;
    changed(&app);
    Ok(out)
}

#[tauri::command]
pub async fn delete_scheduled_run(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    schedule::delete(&state.db, &id).await?;
    changed(&app);
    Ok(())
}

/// Fire a run now without touching its schedule. Returns once it has started;
/// the turn itself runs detached, like any scheduled firing.
#[tauri::command]
pub async fn run_scheduled_now(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let run = schedule::get(&state.db, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("scheduled run {id}")))?;
    tauri::async_runtime::spawn(async move { schedule::fire(&app, run).await });
    Ok(())
}
