//! Remote speech-to-text via a configured provider (release 0.8.0).
//!
//! Rather than hardcoding named API providers (OpenAI, Deepgram, ...), STT
//! reuses this app's existing `Provider` config (base URL + API key) — the
//! same rows zones already point at for chat completions. Any provider
//! exposing the OpenAI-compatible `POST {base_url}/audio/transcriptions`
//! endpoint works this way, which covers OpenAI itself and local servers like
//! LM Studio that can also serve a whisper model. This mirrors how
//! `llm::client::LlmClient` treats "provider" as base_url + key, not a fixed
//! vendor list (see its `embed` doc comment).

use reqwest::Client;

use crate::error::{AppError, AppResult};

/// POSTs the recorded audio (WAV-encoded) to a provider's OpenAI-compatible
/// transcription endpoint and returns the transcript text.
pub async fn transcribe_via_provider(
    http: &Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    wav_bytes: Vec<u8>,
    lang: Option<&str>,
) -> AppResult<String> {
    let url = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));

    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(wav_bytes)
                .file_name("dictation.wav")
                .mime_str("audio/wav")?,
        );
    if let Some(l) = lang {
        if !l.is_empty() {
            form = form.text("language", l.to_string());
        }
    }

    let mut req = http.post(&url).multipart(form);
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    let res = req.send().await?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(AppError::Provider(format!("transcription endpoint {status}: {body}")));
    }

    #[derive(serde::Deserialize)]
    struct TranscriptionResponse {
        text: String,
    }
    let parsed: TranscriptionResponse = res.json().await?;
    Ok(parsed.text.trim().to_string())
}
