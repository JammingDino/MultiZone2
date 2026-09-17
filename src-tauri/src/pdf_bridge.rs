//! Reading PDFs for the model (1.0): page images by default, with the rendering
//! done by the frontend's PDF.js.
//!
//! There is no pure-Rust PDF rasterizer worth shipping — every option pulls in a
//! native library (pdfium, mupdf), which this codebase deliberately avoids (see
//! the notes beside `ocrs` and `pdf-extract` in Cargo.toml). PDF.js is already in
//! the app and already rasterizes attached PDFs, so `read` borrows it: the
//! backend emits a request, the window renders the pages it asked for, and a
//! command hands the results back. Same shape as the tool-approval gate — emit,
//! then wait on a oneshot keyed by request id.
//!
//! Page *selection* lives on the frontend for both modes, because that's the
//! side that knows how many pages the document has: "all" and out-of-range
//! ranges are resolved against `numPages` rather than guessed at here.
//!
//! When no window answers (the headless HTTP API, or a request that outlives the
//! timeout) the caller falls back to `pdf-extract`'s text — degraded, but the
//! turn still gets something rather than an error.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

/// How long to wait for the window to render. Generous enough for a big scanned
/// document on a slow machine, short enough that a turn with no window attached
/// falls back to text rather than hanging until the model's own timeout.
const RENDER_TIMEOUT_SECS: u64 = 45;

/// Ceiling on pages returned in one call, whatever the model asked for. Page
/// images are the most expensive thing a tool can put in the context window, and
/// "read the whole 400-page manual" is a mistake worth capping rather than
/// honoring. The result says how many pages were left out and how to ask for
/// them.
pub const MAX_PAGES_PER_CALL: u32 = 30;

/// What the model gets back: rendered page images, or per-page text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PdfReadMode {
    Images,
    Text,
}

/// One page of the answer. `image` is a data URL in image mode; `text` is the
/// page's extracted text in text mode.
#[derive(Debug, Clone, Deserialize)]
pub struct PdfPage {
    pub page: u32,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfReadResponse {
    /// Total pages in the document, regardless of how many were returned.
    pub page_count: u32,
    pub pages: Vec<PdfPage>,
    /// True when the selection was cut short by [`MAX_PAGES_PER_CALL`].
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfReadRequest {
    id: String,
    /// Named only so the window can label progress; the bytes travel with the
    /// request, so the frontend never touches the filesystem itself.
    path: String,
    /// Raw page spec as the model wrote it ("3", "1-4,9", "all"), expanded
    /// against the real page count on the frontend.
    spec: String,
    mode: PdfReadMode,
    max_pages: u32,
    /// The file, base64-encoded. Same route attachment images already take over
    /// the IPC boundary in both directions.
    data: String,
}

type Pending = Mutex<HashMap<String, oneshot::Sender<Result<PdfReadResponse, String>>>>;

/// In-flight requests, keyed by request id. Process-global rather than threaded
/// through `EngineCtx`, so the HTTP API path gets it for free.
static PENDING: LazyLock<Pending> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Ask the window to read `pages` out of a PDF. `Err` means no usable answer
/// came back (no window, a render failure, or the timeout) — callers fall back
/// to Rust-side text extraction.
pub async fn read_pdf(
    app: &AppHandle,
    path: &str,
    spec: &str,
    mode: PdfReadMode,
    bytes: &[u8],
) -> Result<PdfReadResponse, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    PENDING.lock().await.insert(id.clone(), tx);

    let request = PdfReadRequest {
        id: id.clone(),
        path: path.to_string(),
        spec: spec.to_string(),
        mode,
        max_pages: MAX_PAGES_PER_CALL,
        data: STANDARD.encode(bytes),
    };
    if let Err(e) = app.emit("pdf-read-request", &request) {
        PENDING.lock().await.remove(&id);
        return Err(format!("could not reach the app window: {e}"));
    }

    let outcome = tokio::time::timeout(
        tokio::time::Duration::from_secs(RENDER_TIMEOUT_SECS),
        rx,
    )
    .await;
    PENDING.lock().await.remove(&id);

    match outcome {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("the PDF reader was dropped before it answered".into()),
        Err(_) => Err(format!("the PDF reader did not answer within {RENDER_TIMEOUT_SECS}s")),
    }
}

/// Called by the frontend once it has rendered (or failed to render) a request.
#[tauri::command]
pub async fn resolve_pdf_read(
    id: String,
    result: Option<PdfReadResponse>,
    error: Option<String>,
) -> Result<(), String> {
    if let Some(tx) = PENDING.lock().await.remove(&id) {
        let answer = match (result, error) {
            (Some(r), _) => Ok(r),
            (None, Some(e)) => Err(e),
            (None, None) => Err("the PDF reader returned nothing".to_string()),
        };
        let _ = tx.send(answer);
    }
    Ok(())
}
