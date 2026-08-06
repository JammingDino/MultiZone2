//! Checkpoint commands (0.10.1) — what the transcript calls to offer a way back.
//!
//! The engine lives in [`crate::checkpoints`]; this is the thin Tauri surface
//! over it. Two questions and one action: what did this chat's turns change,
//! and put one of them back.

use crate::checkpoints;
use crate::error::AppResult;
use crate::state::AppState;
use tauri::State;

/// Every checkpoint in a chat, newest first, each listing the paths it covers
/// and whether they have diverged since the assistant wrote them.
#[tauri::command]
pub async fn list_checkpoints(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<checkpoints::Checkpoint>> {
    checkpoints::list_for_chat(&state.db, &chat_id).await
}

/// Put a checkpoint's paths back.
///
/// `paths` restricts the restore to a subset — a turn that got three edits
/// right and one wrong is not thrown away whole. `force` proceeds past a file
/// that changed after the assistant left it; without it that path is reported
/// as a conflict and left exactly as found, so the user is never told an undo
/// succeeded when it quietly discarded their own edit.
#[tauri::command]
pub async fn restore_checkpoint(
    state: State<'_, AppState>,
    checkpoint_id: String,
    paths: Option<Vec<String>>,
    force: Option<bool>,
) -> AppResult<checkpoints::RestoreReport> {
    checkpoints::restore(
        &state.db,
        &checkpoint_id,
        paths.as_deref(),
        force.unwrap_or(false),
    )
    .await
}
