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
/// The `visionOverrides` app setting lets the user force either answer per model.
///
/// Real model ids bury the family name mid-string ("gemma-4-26B-A4B-it-MLX-4bit",
/// "RavenX-...-Qwen3.6-..."), so beyond plain substring markers this also does
/// token-level "vl" detection and family+version matching (any gemma ≥ 3, any
/// llama ≥ 4, …) so new point releases of a known-multimodal family are caught
/// without a list update. Keep in sync with `src/lib/vision.ts`.
pub fn is_vision_capable(model: &str) -> bool {
    let m = model.to_ascii_lowercase();

    // Substring markers that reliably indicate a multimodal family.
    const MARKERS: &[&str] = &[
        // generic markers
        "vision", "multimodal", "omni",
        // open multimodal families
        "llava", "bakllava", "moondream", "minicpm-v", "internvl", "pixtral",
        "cogvlm", "smolvlm", "idefics", "fuyu", "kosmos", "paligemma", "molmo",
        "aria", "deepseek-ocr",
        // OpenAI multimodal
        "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "gpt-5", "o4-mini",
        // Anthropic (all Claude 3+ are multimodal; version rule covers the rest)
        "claude-opus", "claude-sonnet", "claude-haiku", "claude-fable", "claude-mythos",
        // Google
        "gemini",
        // others
        "grok-vision", "step-1v", "yi-vision", "phi-3.5-vision",
        "phi-4-multimodal", "llama-3.2", "llama3.2",
    ];
    if MARKERS.iter().any(|marker| m.contains(marker)) {
        return true;
    }

    // Token-level "vl" (vision-language): catches "qwen3-vl-8b", "deepseek-vl",
    // "Qwen2.5-VL-7B-Instruct-4bit" and the separator-free Ollama spelling
    // "qwen2.5vl:7b" (digit immediately followed by "vl"), while not firing on
    // words that merely contain the letters (e.g. "vllm" is a runtime, not a
    // model, but "ravl-chat" style names shouldn't match either).
    if has_vl_token(&m) {
        return true;
    }

    // Family + minimum version: every release of these families at or above the
    // given version accepts images, so "gemma-4-26B-…" matches without needing
    // "gemma-4" itself listed. (Qwen deliberately has no version rule — qwen3
    // text-only models exist; its vision variants all carry "vl" or "omni".)
    const FAMILY_MIN_VERSION: &[(&str, f32)] = &[
        ("gemma", 3.0),
        ("llama", 4.0), // llama-3.2 vision is covered by its explicit marker
        ("claude", 3.0),
        ("grok", 3.0),
    ];
    for (family, min) in FAMILY_MIN_VERSION {
        if let Some(v) = family_version(&m, family) {
            if v >= *min {
                return true;
            }
        }
    }

    // A handful of exact OpenAI reasoning-model ids that are too short to use as
    // safe substrings (e.g. "o1"/"o3" would match unrelated names).
    matches!(m.as_str(), "o1" | "o1-mini" | "o1-preview" | "o3" | "o3-mini")
}

/// True when the (lowercased) name contains "vl" as its own token — delimited by
/// non-alphanumerics ("qwen3-vl-8b") — or directly after a digit ("qwen2.5vl").
fn has_vl_token(m: &str) -> bool {
    let bytes = m.as_bytes();
    for (i, _) in m.match_indices("vl") {
        let before = if i == 0 { None } else { Some(bytes[i - 1]) };
        let after = bytes.get(i + 2);
        let before_ok = match before {
            None => true,
            Some(b) => !b.is_ascii_alphabetic() || b.is_ascii_digit(),
        };
        let after_ok = match after {
            None => true,
            Some(b) => !b.is_ascii_alphabetic(),
        };
        // A digit before counts as a boundary ("2.5vl"); a letter doesn't ("vllm"
        // needs a non-letter after, which "l" isn't).
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

/// Find `family` in the name at a word boundary and parse the version number
/// that follows it (optionally separated by one of `-`, `_`, ` `, `.`, or a `v`
/// prefix): "gemma-4-26b" → 4.0, "gemma3n" → 3.0, "claude-4.5" → 4.5. Returns
/// `None` when the family isn't present or no version digits follow it.
fn family_version(m: &str, family: &str) -> Option<f32> {
    let bytes = m.as_bytes();
    for (i, _) in m.match_indices(family) {
        // Word boundary before: reject "paligemma" for family "gemma".
        if i > 0 && bytes[i - 1].is_ascii_alphanumeric() {
            continue;
        }
        let mut j = i + family.len();
        // At most one separator, then optional "v", then digits.
        if j < bytes.len() && matches!(bytes[j], b'-' | b'_' | b' ' | b'.') {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'v' {
            j += 1;
        }
        let start = j;
        let mut seen_dot = false;
        while j < bytes.len()
            && (bytes[j].is_ascii_digit() || (bytes[j] == b'.' && !seen_dot))
        {
            if bytes[j] == b'.' {
                // Only consume the dot if a digit follows (avoid "4." from "4.bit").
                if !bytes.get(j + 1).is_some_and(|b| b.is_ascii_digit()) {
                    break;
                }
                seen_dot = true;
            }
            j += 1;
        }
        if j > start {
            if let Ok(v) = m[start..j].parse::<f32>() {
                return Some(v);
            }
        }
    }
    None
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

#[cfg(test)]
mod tests {
    use super::is_vision_capable;

    #[test]
    fn detects_vision_families_buried_in_long_names() {
        for name in [
            "gemma-4-26B-A4B-it-MLX-4bit",
            "gemma3n:e4b",
            "gemma3:12b",
            "qwen2.5vl:7b",     // Ollama's separator-free tag
            "qwen3-vl-8b",
            "Qwen/Qwen2.5-VL-7B-Instruct",
            "deepseek-vl2",
            "llama-4-scout-17b",
            "llama3.2-vision:11b",
            "claude-fable-5",
            "claude-3-5-sonnet-20241022",
            "gpt-4o-mini",
            "gemini-2.0-flash",
            "qwen3-omni-30b",
            "o3",
        ] {
            assert!(is_vision_capable(name), "{name} should be vision-capable");
        }
    }

    #[test]
    fn treats_text_models_as_text_only() {
        for name in [
            "qwen3:8b",
            "qwen2.5-coder-32b",
            "gemma2:9b",     // gemma < 3 is text-only
            "codegemma:7b",  // word boundary: not the gemma family
            "llama-3.3-70b", // 3.3 is text-only (3.2 vision is explicit)
            "mistral-7b-instruct",
            "deepseek-v4-flash",
            "vllm-hosted-model", // "vl" inside a word is not a vl token
            // Fine-tune names that hide the base family — stay text-only under
            // the heuristic; the visionOverrides setting is the escape hatch.
            "RavenX-CyberAgent-Qwen3.6-35B-A3B-mlx-4bit",
        ] {
            assert!(!is_vision_capable(name), "{name} should be text-only");
        }
    }
}
