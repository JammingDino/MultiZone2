//! Remote text-to-speech via a configured provider (release 0.8.1).
//!
//! The mirror image of `stt_api`: rather than a fixed vendor list, TTS reuses
//! this app's existing `Provider` config (base URL + API key) — the same rows
//! zones already point at for chat completions. Any provider exposing the
//! OpenAI-compatible `POST {base_url}/audio/speech` endpoint works this way,
//! which covers OpenAI itself and local servers (e.g. an OpenAI-compatible
//! Kokoro / Piper server) that can synthesize speech on-device.

use reqwest::Client;

use crate::error::{AppError, AppResult};

/// POSTs `text` to a provider's OpenAI-compatible speech endpoint and returns
/// the synthesized audio bytes (MP3). `voice`, `model` and `speed` map onto the
/// standard `/audio/speech` request fields; `speed` is clamped to the range the
/// endpoint accepts (0.25–4.0).
pub async fn synthesize_via_provider(
    http: &Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    voice: &str,
    text: &str,
    speed: f32,
) -> AppResult<Vec<u8>> {
    let url = format!("{}/audio/speech", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": "mp3",
        "speed": speed.clamp(0.25, 4.0),
    });

    let mut req = http.post(&url).json(&body);
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    let res = req.send().await?;
    if !res.status().is_success() {
        let status = res.status();
        let msg = res.text().await.unwrap_or_default();
        return Err(AppError::Provider(format!("speech endpoint {status}: {msg}")));
    }

    let bytes = res.bytes().await?;
    Ok(bytes.to_vec())
}
