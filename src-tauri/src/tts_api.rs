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
) -> AppResult<(Vec<u8>, String)> {
    let url = format!("{}/audio/speech", base_url.trim_end_matches('/'));
    let speed = speed.clamp(0.25, 4.0);

    let body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": "mp3",
        "speed": speed,
    });

    // Diagnostics: this whole path prints to the `npm run tauri dev` console
    // (debug builds log at `multizone=debug`). It's the quickest way to tell a
    // misconfigured endpoint/model/voice from an actual synthesis failure —
    // e.g. an LM Studio server that hasn't loaded a TTS model, or one that
    // doesn't implement `/audio/speech` at all.
    tracing::info!(
        "TTS request → POST {url} (model={model:?}, voice={voice:?}, speed={speed}, auth={}, chars={})",
        api_key.map(|k| !k.is_empty()).unwrap_or(false),
        text.chars().count(),
    );

    let mut req = http.post(&url).json(&body);
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            // Connection refused / DNS / timeout — almost always the base URL is
            // wrong or the server isn't running. Surface the URL so it's obvious.
            tracing::error!("TTS request to {url} failed to send: {e}");
            return Err(AppError::Provider(format!(
                "could not reach speech endpoint {url}: {e} — is the server running and the provider base URL correct?"
            )));
        }
    };

    let status = res.status();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    tracing::info!("TTS response ← {status} (content-type: {content_type})");

    if !status.is_success() {
        let msg = res.text().await.unwrap_or_default();
        tracing::error!("TTS endpoint {status} error body: {msg}");
        return Err(AppError::Provider(format!("speech endpoint {status}: {msg}")));
    }

    // A 200 that's actually JSON/text (not audio) means the server accepted the
    // request but didn't synthesize — e.g. it echoed an error or the route is
    // handled by a chat model. Catch it here rather than handing the webview a
    // Blob it can't play.
    if content_type.contains("json") || content_type.starts_with("text/") {
        let msg = res.text().await.unwrap_or_default();
        tracing::error!("TTS endpoint returned non-audio body ({content_type}): {msg}");
        return Err(AppError::Provider(format!(
            "speech endpoint returned {content_type}, not audio — the model likely isn't a TTS model. Body: {msg}"
        )));
    }

    let bytes = res.bytes().await?;
    tracing::info!("TTS received {} bytes of audio", bytes.len());
    if bytes.is_empty() {
        return Err(AppError::Provider(
            "speech endpoint returned an empty audio body".to_string(),
        ));
    }
    // Pass the real MIME back so the webview plays it with the right type — some
    // endpoints (e.g. a local F5-TTS shim) return WAV, not MP3. Default to
    // audio/mpeg when the header is missing or generic.
    let mime = if content_type.is_empty() || content_type == "application/octet-stream" {
        "audio/mpeg".to_string()
    } else {
        // Strip any "; charset=..." parameter.
        content_type.split(';').next().unwrap_or("audio/mpeg").trim().to_string()
    };
    Ok((bytes.to_vec(), mime))
}
