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

/// One timed span of a transcript, as `verbose_json` reports it.
///
/// `no_speech_prob` is whisper's own confidence that the span is *not* speech —
/// the closest thing the endpoint gives us to a per-segment confidence score, and
/// what the UI's metadata header surfaces so a user can see which passages the
/// model was unsure about rather than trusting a flat wall of text.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    #[serde(default)]
    pub start: f64,
    #[serde(default)]
    pub end: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default, alias = "no_speech_prob")]
    pub no_speech_prob: Option<f64>,
}

/// A finished transcription. The metadata fields are only populated when the
/// caller asked for `verbose_json` *and* the provider actually implements it —
/// a plain-`json` provider (or a shim that ignores the parameter) still yields a
/// usable `text` with everything else empty, which is why they are all optional
/// rather than a separate result type.
#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    pub text: String,
    /// Detected (or forced) language, as the endpoint names it.
    pub language: Option<String>,
    /// Audio duration in seconds, per the endpoint.
    pub duration_secs: Option<f64>,
    pub segments: Vec<TranscriptSegment>,
}

/// `verbose_json`'s response. Every field past `text` is optional so a provider
/// that answers a plain `{"text": ...}` to a verbose request still parses.
#[derive(serde::Deserialize)]
struct TranscriptionResponse {
    text: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    segments: Vec<TranscriptSegment>,
}

/// The MIME type to upload a given audio file extension as.
///
/// The endpoint dispatches on the uploaded part's filename and content type, so
/// sending every recording as `audio/wav` (as dictation used to, having only ever
/// produced WAVs) makes a strict endpoint reject a perfectly valid `.m4a`. The
/// list is exactly the set OpenAI's `/audio/transcriptions` documents as
/// accepted; an unknown extension falls back to `application/octet-stream` and is
/// left for the endpoint to accept or refuse on its own terms, rather than being
/// blocked here on a guess.
pub fn audio_mime_for(file_name: &str) -> &'static str {
    let ext = std::path::Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "wav" => "audio/wav",
        "mp3" | "mpga" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mpeg" => "video/mpeg",
        "flac" => "audio/flac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "webm" => "audio/webm",
        "aac" => "audio/aac",
        _ => "application/octet-stream",
    }
}

/// POSTs audio to a provider's OpenAI-compatible transcription endpoint.
///
/// `file_name` travels with the upload rather than being invented here: the
/// endpoint reads the extension to decide how to decode the bytes, so an
/// uploaded `notes.m4a` has to arrive called that.
///
/// `verbose` asks for `response_format=verbose_json` (per-segment timings, the
/// detected language, the duration). A provider that doesn't implement it
/// answers ordinary JSON, which still deserializes — so verbose is a request,
/// not a requirement, and the caller checks whether the metadata came back
/// rather than assuming it did.
pub async fn transcribe_via_provider(
    http: &Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    audio_bytes: Vec<u8>,
    file_name: &str,
    lang: Option<&str>,
    verbose: bool,
) -> AppResult<Transcription> {
    let url = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));

    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(audio_bytes)
                .file_name(file_name.to_string())
                .mime_str(audio_mime_for(file_name))?,
        );
    if let Some(l) = lang {
        if !l.is_empty() {
            form = form.text("language", l.to_string());
        }
    }
    if verbose {
        form = form.text("response_format", "verbose_json");
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
        return Err(AppError::Provider(format!(
            "transcription endpoint {status}: {body}"
        )));
    }

    let parsed: TranscriptionResponse = res.json().await?;
    Ok(Transcription {
        text: parsed.text.trim().to_string(),
        language: parsed.language.filter(|l| !l.is_empty()),
        duration_secs: parsed.duration,
        segments: parsed.segments,
    })
}
