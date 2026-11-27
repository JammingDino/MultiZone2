//! The workspace panel's file explorer (0.17.9).
//!
//! The right-hand panel shows the directory the chat's file tools are scoped
//! to — the project directory, or the app's default — as a tree the user can
//! open folder by folder. Listing is on demand per directory rather than a
//! whole-tree walk: a project with `node_modules` in it is not something to
//! read in one go.

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::grants::{ChatPath, PathContext, PathStat};
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

// ─── Paths handed to a chat (0.19.3) — see `grants` ───────────────────────────────

fn paths_changed(app: &AppHandle, chat_id: &str) {
    let _ = app.emit("chat-paths-changed", serde_json::json!({ "chatId": chat_id }));
}

/// Give the chat (and every agent under it) a folder or file. Takes effect from
/// the chat's next turn.
#[tauri::command]
pub async fn grant_chat_path(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    path: String,
    source: Option<String>,
) -> AppResult<ChatPath> {
    let out = crate::grants::grant(&state.db, &chat_id, &path, source.as_deref().unwrap_or("picker")).await?;
    paths_changed(&app, &chat_id);
    Ok(out)
}

#[tauri::command]
pub async fn revoke_chat_path(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    path: String,
) -> AppResult<bool> {
    let out = crate::grants::revoke(&state.db, &chat_id, &path).await?;
    paths_changed(&app, &chat_id);
    Ok(out)
}

/// Everything the chat may reach beyond its working directory, inherited
/// grants included and marked.
#[tauri::command]
pub async fn list_chat_paths(state: State<'_, AppState>, chat_id: String) -> AppResult<Vec<ChatPath>> {
    crate::grants::list(&state.db, &chat_id).await
}

/// Whether a pasted path exists, and is a folder. Metadata only.
#[tauri::command]
pub async fn stat_path(path: String) -> AppResult<PathStat> {
    off_runtime(move || Ok(crate::grants::stat(&path))).await
}

/// Run filesystem work on the blocking pool. An `open` can wait indefinitely —
/// a network share, or macOS holding it behind a privacy prompt nobody has
/// answered — and on an async worker that stalls every other request queued
/// behind it, the HTTP API's accept loop included.
async fn off_runtime<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Other(format!("filesystem task failed: {e}")))?
}

/// Which project, if any, a path belongs to — for opening a chat in it.
#[tauri::command]
pub async fn path_context(state: State<'_, AppState>, path: String) -> AppResult<PathContext> {
    crate::grants::path_context(&state.db, &path).await
}

/// One directory's children, folders first, each group by name. Hidden
/// entries are included — a `.env` is exactly the kind of file worth seeing
/// beside a project — but the reader decides what to open.
#[tauri::command]
pub async fn list_dir(path: String) -> AppResult<Vec<DirEntry>> {
    off_runtime(move || list_dir_now(path)).await
}

fn list_dir_now(path: String) -> AppResult<Vec<DirEntry>> {
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

// ─── Watching the explorer's root, so the tree follows the disk ───────────────────

/// Folders whose churn the tree never needs to hear about: a build or an
/// install rewrites thousands of files in them. The folder itself appearing is
/// still reported; only what happens inside it is not.
const QUIET_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "__pycache__", ".venv"];

// ponytail: one watch for the one window; key it by window label if there are ever several.
static EXPLORER_WATCH: std::sync::Mutex<Option<Debouncer<RecommendedWatcher>>> =
    std::sync::Mutex::new(None);

/// The folders whose listing changed, for a batch of changed paths: each
/// path's parent, deduped, skipping any inside a quiet folder below `root`.
fn changed_dirs(root: &Path, paths: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
    let mut out = BTreeSet::new();
    for p in paths {
        let Some(dir) = p.parent() else { continue };
        let Ok(rel) = dir.strip_prefix(root) else { continue };
        if rel.components().any(|c| QUIET_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref())) {
            continue;
        }
        out.insert(dir.to_string_lossy().into_owned());
    }
    out.into_iter().collect()
}

/// Watch the explorer's root recursively and emit `files-changed` with the
/// folders whose listing changed. Replaces the last watch; `None` stops it.
///
/// Sync on purpose: sync commands run in the order they arrive, so the stop a
/// closing tree sends cannot land after the watch the next one starts.
#[tauri::command]
pub fn watch_dir(app: AppHandle, root: Option<String>) -> AppResult<()> {
    let Some(root) = root else {
        *EXPLORER_WATCH.lock().unwrap() = None;
        return Ok(());
    };
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(AppError::Invalid(format!("{} is not a directory", root.display())));
    }
    let base = root.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let dirs = changed_dirs(&base, events.into_iter().map(|e| e.path));
        if !dirs.is_empty() {
            let _ = app.emit("files-changed", serde_json::json!({ "dirs": dirs }));
        }
    })
    .map_err(|e| AppError::Other(format!("watching {}: {e}", root.display())))?;
    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| AppError::Other(format!("watching {}: {e}", root.display())))?;
    // Swapped in only once it is watching, so a bad root leaves the last watch alone.
    *EXPLORER_WATCH.lock().unwrap() = Some(debouncer);
    Ok(())
}

/// What the panel's viewer gets for a file (0.17.9).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// The file as text. Always filled, even when `binary` — the viewer offers
    /// "open as text anyway" for a file whose bytes were misjudged, and it
    /// needs something to show.
    pub content: String,
    /// True when the bytes do not decode as text. Advisory: it picks the
    /// viewer's default, it does not forbid the editor.
    pub binary: bool,
    pub modified_ms: Option<u64>,
}

/// The largest file the viewer will load. The editor is for the files an agent
/// writes — reports, scripts, notes — not for a database dump.
const MAX_VIEW_BYTES: u64 = 4 * 1024 * 1024;

/// A file's bytes as text, and whether calling it text is a stretch.
///
/// The old rule was "a NUL in the first 8 KB means binary", which is a fine
/// rule for a UTF-8 world and wrong for the files Windows actually writes: a
/// `.ini`, a PowerShell profile or anything saved from Notepad as "Unicode" is
/// UTF-16, which is half NUL bytes by construction. Those were refused as
/// binary — a text file the app simply did not recognise, which is the one
/// case a text viewer must not get wrong.
///
/// So the BOM is read first, and only bytes that decode as nothing at all are
/// called binary. Text without a BOM is still decoded lossily rather than
/// strictly, because a latin-1 log with one stray byte in it is a file to read,
/// not a file to refuse.
fn decode_text(bytes: &[u8]) -> (String, bool) {
    // UTF-16, either way round. `chunks_exact` drops a trailing odd byte,
    // which is a truncated file, not a reason to fail.
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> =
            rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return (String::from_utf16_lossy(&units), false);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> =
            rest.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return (String::from_utf16_lossy(&units), false);
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let binary = body.iter().take(8192).any(|b| *b == 0);
    (String::from_utf8_lossy(body).into_owned(), binary)
}

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
    let (content, binary) = decode_text(&bytes);
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(FileText {
        name: p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
        path,
        size: meta.len(),
        content,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_dir_runs_off_the_runtime_and_puts_folders_first() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "x").unwrap();
        std::fs::create_dir(d.path().join("z")).unwrap();
        let got = list_dir(d.path().to_string_lossy().into_owned()).await.unwrap();
        let names: Vec<_> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["z", "a.txt"]);
        assert!(list_dir(d.path().join("a.txt").to_string_lossy().into_owned()).await.is_err());
    }

    /// The case that sent this back to the drawing board: a UTF-16 `.ini` is
    /// half NUL bytes, and the old sniff called it binary.
    #[test]
    fn a_utf16_file_is_text() {
        let mut le = vec![0xFF, 0xFE];
        for u in "[net]\r\nport=8080".encode_utf16() {
            le.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_text(&le), ("[net]\r\nport=8080".to_string(), false));

        let mut be = vec![0xFE, 0xFF];
        for u in "ok".encode_utf16() {
            be.extend_from_slice(&u.to_be_bytes());
        }
        assert_eq!(decode_text(&be), ("ok".to_string(), false));
    }

    #[test]
    fn a_bom_is_not_part_of_the_text() {
        assert_eq!(decode_text("hello".as_bytes()), ("hello".to_string(), false));
        let with_bom = [&[0xEF, 0xBB, 0xBF][..], "hello".as_bytes()].concat();
        assert_eq!(decode_text(&with_bom), ("hello".to_string(), false));
    }

    /// Still binary, and still decoded: the viewer offers the editor anyway,
    /// so the content is never thrown away on the way out.
    #[test]
    fn real_binary_is_flagged_but_not_emptied() {
        let png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D];
        let (content, binary) = decode_text(&png);
        assert!(binary, "a PNG header is not text");
        assert!(!content.is_empty(), "and the viewer still gets something to show");
    }

    /// A new `node_modules` shows up in its parent; what an install writes
    /// inside it does not, and neither does anything outside the root.
    #[test]
    fn changed_dirs_reports_parents_deduped_and_skips_quiet_folders() {
        let root = Path::new("proj");
        let dirs = changed_dirs(
            root,
            [
                root.join("a.txt"),
                root.join("b.txt"),
                root.join("node_modules"),
                root.join("node_modules").join("x").join("y.js"),
                root.join("src").join(".git").join("HEAD"),
                root.join("src").join("main.rs"),
                PathBuf::from("elsewhere").join("z.txt"),
            ],
        );
        let expect: Vec<String> = [root.to_path_buf(), root.join("src")]
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(dirs, expect);
    }

    /// A latin-1 log with one stray byte is a file to read, not to refuse.
    #[test]
    fn a_stray_byte_does_not_make_a_file_binary() {
        let (content, binary) = decode_text(&[b'c', b'a', b'f', b'\xe9', b'\n']);
        assert!(!binary);
        assert!(content.starts_with("caf"));
    }
}
