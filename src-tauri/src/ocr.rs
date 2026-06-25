//! OCR & model-capability support (release 0.4.0).
//!
//! Two responsibilities:
//!   1. `is_vision_capable` — a name-based heuristic for whether a model can
//!      accept image input directly. Used to decide when to fall back to OCR.
//!   2. `ocr_data_url` — extract text from an image (given as a base64 data URL)
//!      so a vision-incapable model still receives the content as text.
//!
//! The OCR engine is the pure-Rust `ocrs` stack (no native libtesseract), which
//! keeps the cross-platform build clean — consistent with this codebase's use of
//! rustls and `pdf-extract` over native dependencies. It needs two `.rten` model
//! files at runtime; they are looked up in `<app_data_dir>/ocr_models/`. When the
//! models are absent the OCR step degrades gracefully (returns `None`) rather than
//! breaking the turn, so a fresh install still functions until the models are
//! provided.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;

/// Directory holding the `.rten` OCR models, set once at startup.
static MODELS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Cache of OCR results keyed by a hash of the image bytes, so the same image is
/// not re-OCR'd on every turn of a long conversation (history is rebuilt each
/// turn). Bounded loosely below.
static CACHE: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();

const CACHE_CAP: usize = 256;

thread_local! {
    /// Per-thread engine: `None` = not yet attempted; `Some(None)` = attempted
    /// but unavailable (models missing / load failed); `Some(Some(_))` = ready.
    /// `ocrs::OcrEngine` is not `Sync`, so a thread-local sidesteps sharing it
    /// across the blocking-thread pool while still reusing it within a thread.
    static ENGINE: RefCell<Option<Option<ocrs::OcrEngine>>> = const { RefCell::new(None) };
}

/// Record where the OCR model files live. Called once during app startup.
pub fn set_models_dir(dir: PathBuf) {
    let _ = MODELS_DIR.set(dir);
}

/// Heuristic: can this model accept image input directly?
///
/// Matches known multimodal model families by name. Anything that doesn't match
/// is treated as **text-only**, so its image attachments are OCR'd rather than
/// silently dropped or sent to a model that errors on them. This deliberately
/// errs toward OCR for unrecognised models (the common case for local text-only
/// models like base llama / mistral / qwen-coder); a vision model mistakenly
/// classified as text-only only loses some image fidelity, never correctness.
pub fn is_vision_capable(model: &str) -> bool {
    let m = model.to_ascii_lowercase();

    // Substring markers that reliably indicate a multimodal family.
    const MARKERS: &[&str] = &[
        // generic markers
        "vision", "-vl", "vl-", "-vl-", "multimodal",
        // open multimodal families
        "llava", "bakllava", "moondream", "minicpm-v", "internvl", "pixtral",
        "cogvlm", "smolvlm", "idefics", "fuyu", "kosmos", "paligemma", "molmo",
        "aria", "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl",
        // OpenAI multimodal
        "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "gpt-5", "o3", "o4-mini",
        // Anthropic (all Claude 3+ are multimodal)
        "claude-3", "claude-4", "claude-opus", "claude-sonnet", "claude-haiku",
        // Google
        "gemini", "gemma-3", "gemma3", "paligemma",
        // others
        "grok-vision", "grok-2-vision", "step-1v", "yi-vision", "phi-3.5-vision",
        "phi-4-multimodal", "llama-3.2", "llama3.2",
    ];
    if MARKERS.iter().any(|marker| m.contains(marker)) {
        return true;
    }

    // A handful of exact OpenAI reasoning-model ids that are too short to use as
    // safe substrings (e.g. "o1" would match unrelated names).
    matches!(m.as_str(), "o1" | "o1-mini" | "o1-preview" | "o3" | "o3-mini")
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// Extract text from a base64 image data URL (e.g. `data:image/png;base64,...`)
/// or a bare base64 string. Returns `None` when OCR is unavailable or yields no
/// text. CPU-bound — call from a blocking context (see `ocr_data_url_blocking`).
fn run_ocr(data_url: &str, _lang: &str) -> Option<String> {
    let b64 = data_url.split(',').next_back().unwrap_or(data_url);
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;

    let key = hash_bytes(&bytes);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some(cached) = map.get(&key) {
            return non_empty(cached.clone());
        }
    }

    let text = ENGINE.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(init_engine());
        }
        let engine = slot.as_ref().unwrap().as_ref()?;

        let img = image::load_from_memory(&bytes).ok()?.into_rgb8();
        let source = ocrs::ImageSource::from_bytes(img.as_raw(), img.dimensions()).ok()?;
        let input = engine.prepare_input(source).ok()?;
        engine.get_text(&input).ok()
    });

    let text = text.map(|t| t.trim().to_string()).unwrap_or_default();

    if let Ok(mut map) = cache.lock() {
        if map.len() >= CACHE_CAP {
            map.clear();
        }
        map.insert(key, text.clone());
    }

    non_empty(text)
}

fn non_empty(s: String) -> Option<String> {
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

fn init_engine() -> Option<ocrs::OcrEngine> {
    let dir = MODELS_DIR.get()?;
    let detection = dir.join("text-detection.rten");
    let recognition = dir.join("text-recognition.rten");
    if !detection.exists() || !recognition.exists() {
        tracing::warn!(
            "OCR models not found in {}; image OCR fallback disabled. \
             Place text-detection.rten and text-recognition.rten there to enable it.",
            dir.display()
        );
        return None;
    }
    let detection_model = rten::Model::load_file(&detection).ok()?;
    let recognition_model = rten::Model::load_file(&recognition).ok()?;
    ocrs::OcrEngine::new(ocrs::OcrEngineParams {
        detection_model: Some(detection_model),
        recognition_model: Some(recognition_model),
        ..Default::default()
    })
    .ok()
}

/// Async wrapper: runs the CPU-bound OCR on a blocking thread.
pub async fn ocr_data_url(data_url: String, lang: String) -> Option<String> {
    tokio::task::spawn_blocking(move || run_ocr(&data_url, &lang))
        .await
        .ok()
        .flatten()
}
