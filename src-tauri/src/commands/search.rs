//! Cross-chat search (0.15.0) — the command the search box calls.
//!
//! The query work is in [`crate::search`]; this is the thin Tauri surface over
//! it. Kept separate from `chats.rs` because searching is not an operation on a
//! chat: it is the thing you do when you do not know which chat you want.

use crate::error::AppResult;
use crate::search::{self, SearchHit};
use crate::state::AppState;
use tauri::State;

/// Search every message of every chat, newest-and-most-relevant first.
///
/// Returns an empty list rather than an error for a query with nothing
/// searchable in it (whitespace, punctuation alone), because the caller is a
/// search box that fires on every keystroke.
#[tauri::command]
pub async fn search_messages(state: State<'_, AppState>, query: String) -> AppResult<Vec<SearchHit>> {
    Ok(search::search_messages(&state.db, &query).await?)
}
