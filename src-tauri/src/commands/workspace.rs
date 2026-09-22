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

    /// A latin-1 log with one stray byte is a file to read, not to refuse.
    #[test]
    fn a_stray_byte_does_not_make_a_file_binary() {
        let (content, binary) = decode_text(&[b'c', b'a', b'f', b'\xe9', b'\n']);
        assert!(!binary);
        assert!(content.starts_with("caf"));
    }
}
