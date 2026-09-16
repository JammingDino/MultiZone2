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

/// What the panel's viewer gets for a file (0.17.9).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Lossy UTF-8 of the whole file, or empty when `binary`.
    pub content: String,
    /// True when the first few kilobytes contain a NUL — not text, and not
    /// something a textarea should be handed.
    pub binary: bool,
    pub modified_ms: Option<u64>,
}

/// The largest file the viewer will load. The editor is for the files an agent
/// writes — reports, scripts, notes — not for a database dump.
const MAX_VIEW_BYTES: u64 = 4 * 1024 * 1024;

/// One file's text, for the workspace viewer and editor.
#[tauri::command]
pub async fn read_workspace_file(path: String) -> AppResult<FileText> {
    let p = Path::new(&path);
    let meta = tokio::fs::metadata(p)
        .await
        .map_err(|e| AppError::Other(format!("{path}: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::Invalid(format!("{path} is not a file")));
    }
    if meta.len() > MAX_VIEW_BYTES {
        return Err(AppError::Other(format!(
            "{path} is {} MB; the viewer opens files up to {} MB",
            meta.len() / 1024 / 1024,
            MAX_VIEW_BYTES / 1024 / 1024
        )));
    }
    let bytes = tokio::fs::read(p)
        .await
        .map_err(|e| AppError::Other(format!("{path}: {e}")))?;
    let binary = bytes.iter().take(8192).any(|b| *b == 0);
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(FileText {
        name: p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
        path,
        size: meta.len(),
        content: if binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() },
        binary,
        modified_ms,
    })
}

/// Save the editor's text back over the file. The file must already exist —
/// the editor edits what the tree shows; creating files is the agent's job —
/// and it is written whole, the way a text editor does.
#[tauri::command]
pub async fn write_workspace_file(path: String, content: String) -> AppResult<FileText> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(AppError::Invalid(format!("{path} is not an existing file")));
    }
    tokio::fs::write(p, content.as_bytes())
        .await
        .map_err(|e| AppError::Other(format!("{path}: {e}")))?;
    read_workspace_file(path).await
}
