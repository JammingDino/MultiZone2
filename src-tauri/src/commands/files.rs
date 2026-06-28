//! File-presentation commands (0.5.2). Back the inline HTML report preview:
//! reading a saved output file for the preview iframe, and opening a file or
//! URL in the OS default app / browser (the "open in browser" button and local
//! file links inside HTML output).

use crate::error::{AppError, AppResult};

/// Largest output file we'll load into the inline preview. Reports are small;
/// this guards against accidentally slurping a huge file into the renderer.
const MAX_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;

/// Read a saved output file as text for the inline preview. Bounded so a large
/// file can't blow up the renderer. Invalid UTF-8 is replaced rather than erroring.
#[tauri::command]
pub async fn read_output_file(path: String) -> AppResult<String> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| AppError::Other(format!("could not stat file: {e}")))?;
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err(AppError::Other(format!(
            "file is too large to preview ({} MB; max {} MB)",
            meta.len() / 1024 / 1024,
            MAX_PREVIEW_BYTES / 1024 / 1024
        )));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Other(format!("could not read file: {e}")))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Open a path or URL in the OS default application / browser. Used by the
/// "open in browser" button and by local file links clicked inside an HTML
/// report preview.
#[tauri::command]
pub async fn open_path(path: String) -> AppResult<()> {
    opener::open(&path).map_err(|e| AppError::Other(format!("could not open '{path}': {e}")))?;
    Ok(())
}
