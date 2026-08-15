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

/// The turns that changed files *after* this message — what a rewind to it
/// would have to undo. Read before offering the choice, so "branch from here"
/// can say how many turns and how many files are involved rather than asking a
/// question in the abstract.
#[tauri::command]
pub async fn checkpoints_since_message(
    state: State<'_, AppState>,
    chat_id: String,
    message_id: String,
) -> AppResult<Vec<checkpoints::Checkpoint>> {
    checkpoints::since_message(&state.db, &chat_id, &message_id).await
}

/// Put the working tree back to how it stood at `message_id`.
///
/// The file-side counterpart to "Branch from here": a branch taken three turns
/// back otherwise starts with history from then and a tree from now. Restores
/// newest-first so each turn hands the one before it the state it expects; a
/// file edited outside the app still reports a conflict and is left as found.
#[tauri::command]
pub async fn restore_to_message(
    state: State<'_, AppState>,
    chat_id: String,
    message_id: String,
    force: Option<bool>,
) -> AppResult<Vec<checkpoints::RestoreReport>> {
    checkpoints::restore_to_message(&state.db, &chat_id, &message_id, force.unwrap_or(false)).await
}

/// Rewind the working tree to how it stood at `message_id`, reversibly.
///
/// [`restore_to_message`] is the one-way version kept for branching. This one
/// leaves a mark first, so [`rewind_forward`] can put the tree back the way it
/// was — "undo that run" and "no, I did want it after all" are the same button
/// pointed in two directions.
#[tauri::command]
pub async fn rewind_to_message(
    state: State<'_, AppState>,
    chat_id: String,
    message_id: String,
    force: Option<bool>,
) -> AppResult<checkpoints::RewindReport> {
    checkpoints::rewind_to_message(&state.db, &chat_id, &message_id, force.unwrap_or(false)).await
}

/// Walk the most recent rewind in this chat forward again. `null` when there is
/// no rewind left to undo.
#[tauri::command]
pub async fn rewind_forward(
    state: State<'_, AppState>,
    chat_id: String,
    force: Option<bool>,
) -> AppResult<Option<checkpoints::RestoreReport>> {
    checkpoints::rewind_forward(&state.db, &chat_id, force.unwrap_or(false)).await
}

/// Whether this chat has a rewind that can be walked forward, and how big it is.
#[tauri::command]
pub async fn rewind_status(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<checkpoints::RewindStatus> {
    checkpoints::rewind_status(&state.db, &chat_id).await
}

/// What the checkpoint store is holding, for Settings → Data.
#[tauri::command]
pub async fn checkpoint_usage(state: State<'_, AppState>) -> AppResult<checkpoints::CheckpointUsage> {
    checkpoints::usage(&state.db).await
}

/// Apply the configured retention limits now.
///
/// The same prune that runs at startup and after a turn that changed files —
/// exposed as a button because a user who has just lowered the ceiling wants to
/// see the number move, not wait for their next agentic turn to trigger it.
#[tauri::command]
pub async fn prune_checkpoints(state: State<'_, AppState>) -> AppResult<checkpoints::PruneOutcome> {
    checkpoints::prune_to_settings(&state.db).await
}
