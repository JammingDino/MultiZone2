//! The terminal panel's commands (0.17.9).
//!
//! `tools::terminal` gave the agent long-lived processes it can start, watch and
//! type into — and left the user watching them second-hand, through whatever
//! the model chose to quote from `terminal_read`. This is the first-hand view:
//! the same terminals, the same session scope, listed and followed live, with
//! an input line so the user can answer a prompt the model is stuck on, or run
//! something themselves in a terminal the agent will then see.
//!
//! Thin by design: every rule (who sees what, the limit, the output window)
//! lives in the tool module, so the panel and the model can never disagree
//! about what a terminal is.

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::tools::terminal::{self, TerminalInfo, TerminalRead};

#[tauri::command]
pub async fn list_terminals(state: State<'_, AppState>, chat_id: String) -> AppResult<Vec<TerminalInfo>> {
    terminal::ui_list(&state.db, &chat_id).await
}

/// Follow a terminal: with a `cursor` the call holds until output arrives past
/// it (or the process exits, or `timeout_ms` passes), so a viewer loops on this
/// rather than polling on a timer.
#[tauri::command]
pub async fn read_terminal(
    state: State<'_, AppState>,
    chat_id: String,
    terminal_id: String,
    cursor: Option<u64>,
    timeout_ms: Option<u64>,
) -> AppResult<TerminalRead> {
    terminal::ui_read(&state.db, &chat_id, &terminal_id, cursor, timeout_ms).await
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    chat_id: String,
    terminal_id: String,
    input: String,
    submit: Option<bool>,
) -> AppResult<()> {
    terminal::ui_write(&state.db, &chat_id, &terminal_id, &input, submit.unwrap_or(true)).await
}

#[tauri::command]
pub async fn stop_terminal(
    state: State<'_, AppState>,
    chat_id: String,
    terminal_id: String,
) -> AppResult<()> {
    terminal::ui_stop(&state.db, &chat_id, &terminal_id).await
}

#[tauri::command]
pub async fn start_terminal(
    state: State<'_, AppState>,
    chat_id: String,
    command: Option<String>,
    shell: Option<String>,
    cwd: Option<String>,
    name: Option<String>,
) -> AppResult<TerminalInfo> {
    terminal::ui_start(&state.db, &chat_id, command, shell, cwd, name).await
}
