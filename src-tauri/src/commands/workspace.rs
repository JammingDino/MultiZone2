//! The workspace panel's file explorer (0.17.9).
//!
//! The right-hand panel shows the directory the chat's file tools are scoped
//! to — the project directory, or the app's default — as a tree the user can
//! open folder by folder. Listing is on demand per directory rather than a
//! whole-tree walk: a project with `node_modules` in it is not something to
//! read in one go.

use serde::Serialize;
use std::path::Path;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Bytes, for files; `None` for directories.
    pub size: Option<u64>,
    /// Unix milliseconds of the last write, when the filesystem says.
    pub modified_ms: Option<u64>,
}

/// The directory the chat's file tools resolve paths against, if it has one.
#[tauri::command]
pub async fn chat_working_dir(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<Option<String>> {
    crate::commands::messages::resolve_working_dir(&state.db, &chat_id).await
}

/// One directory's children, folders first, each group by name. Hidden
/// entries are included — a `.env` is exactly the kind of file worth seeing
/// beside a project — but the reader decides what to open.
#[tauri::command]
pub async fn list_dir(path: String) -> AppResult<Vec<DirEntry>> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(AppError::Invalid(format!("{path} is not a directory")));
    }
    let mut out = Vec::new();
    let read = std::fs::read_dir(dir).map_err(|e| AppError::Other(format!("{path}: {e}")))?;
    for entry in read.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { None } else { Some(meta.len()) },
            modified_ms,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}
