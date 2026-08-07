//! Review-queue commands (0.10.2) — the surface the review panel drives.
//!
//! The engine lives in [`crate::review`]; this is the thin Tauri layer over it.
//! Four questions and answers: what is queued, apply this (or these hunks of
//! it), throw this away, and the same two for the whole batch.

use crate::error::AppResult;
use crate::review::{self, ApplyOutcome, StagedEdit};
use crate::state::AppState;
use tauri::State;

/// Every change queued in this chat, oldest first, each with its diff computed
/// against the disk as it stands right now — so a file edited since staging
/// reads as diverged before the user clicks rather than after.
#[tauri::command]
pub async fn list_staged_edits(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<StagedEdit>> {
    review::list(&state.db, &chat_id).await
}

/// Write one queued change to disk.
///
/// `hunks` applies only part of it; `force` proceeds past a file that changed
/// after the change was queued, which is otherwise reported as a conflict and
/// left exactly as found.
#[tauri::command]
pub async fn apply_staged_edit(
    state: State<'_, AppState>,
    id: String,
    hunks: Option<Vec<usize>>,
    force: Option<bool>,
) -> AppResult<ApplyOutcome> {
    review::apply(&state.db, &id, hunks.as_deref(), force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn discard_staged_edit(state: State<'_, AppState>, id: String) -> AppResult<()> {
    review::discard(&state.db, &id).await
}

/// Apply every queued change in a chat, in the order they were proposed —
/// which is the order they have to go in when they build on each other.
///
/// Conflicts don't stop the batch: each is reported and its file left as found,
/// so one file somebody else touched doesn't hold up the four that are fine.
#[tauri::command]
pub async fn apply_all_staged_edits(
    state: State<'_, AppState>,
    chat_id: String,
    force: Option<bool>,
) -> AppResult<Vec<ApplyOutcome>> {
    let force = force.unwrap_or(false);
    let mut out = Vec::new();
    for id in review::ids_for_chat(&state.db, &chat_id).await? {
        out.push(review::apply(&state.db, &id, None, force).await?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn discard_all_staged_edits(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<()> {
    for id in review::ids_for_chat(&state.db, &chat_id).await? {
        review::discard(&state.db, &id).await?;
    }
    Ok(())
}
