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

    // Same diagnostics as the TTS path: this prints to the `npm run tauri dev`
    // console and is the quickest way to separate a misconfigured
    // endpoint/model from an actual transcription failure.
    tracing::info!(
        "STT request → POST {url} (model={model:?}, file={file_name:?}, lang={lang:?}, verbose={verbose}, auth={})",
        api_key.map(|k| !k.is_empty()).unwrap_or(false),
    );

    let mut req = http.post(&url).multipart(form);
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("STT request to {url} failed to send: {e}");
            return Err(AppError::Provider(format!(
                "could not reach transcription endpoint {url}: {e} — is the server running and the provider base URL correct?"
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

    // Read the body ourselves instead of `res.json()`: reqwest collapses every
    // body/decode failure into the opaque "error decoding response body", which
    // hides both the server's actual reply and whether the failure was the read
    // or the parse. Reading to bytes first means an unexpected response shape is
    // reported with the body that caused it.
    let body = match res.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("STT response body from {url} could not be read: {e}");
            return Err(AppError::Provider(format!(
                "transcription endpoint {url} returned {status} but the response body could not be read: {e}"
            )));
        }
    };
    let body_text = String::from_utf8_lossy(&body).into_owned();
    tracing::info!(
        "STT response ← {status} (content-type: {content_type}, {} bytes)",
        body.len()
    );

    if !status.is_success() {
        tracing::error!("STT endpoint {status} error body: {body_text}");
        return Err(AppError::Provider(format!(
            "transcription endpoint {status}: {body_text}"
        )));
    }

    match parse_transcription(&body_text) {
        Some(t) => Ok(t),
        None => {
            tracing::error!("STT endpoint returned an unrecognized body ({content_type}): {body_text}");
            Err(AppError::Provider(format!(
                "transcription endpoint returned a response with no transcript in it (content-type: {content_type}). Body: {}",
                truncate(&body_text, 800)
            )))
        }
    }
}

/// Pulls a `Transcription` out of whatever the endpoint answered with.
///
/// The documented shape is tried first so `verbose_json`'s metadata survives.
/// Everything after it is salvage: the servers people point this at are not all
/// faithful to the spec — some answer plain text, some use `transcript`, some
/// only return segments, some wrap the payload one level deep — and accepting
/// those is the difference between transcription working and an opaque decode
/// error. Metadata is lost on the salvage paths, which is why they are the
/// fallback rather than the primary parse.
fn parse_transcription(body: &str) -> Option<Transcription> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<TranscriptionResponse>(trimmed) {
        return Some(Transcription {
            text: parsed.text.trim().to_string(),
            language: parsed.language.filter(|l| !l.is_empty()),
            duration_secs: parsed.duration,
            segments: parsed.segments,
        });
    }
    extract_transcript(trimmed).map(|text| Transcription {
        text: text.trim().to_string(),
        ..Default::default()
    })
}

/// Best-effort transcript text from a body that isn't the documented shape.
fn extract_transcript(body: &str) -> Option<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        // Not JSON at all — a server that answers `text/plain` with the
        // transcript itself. Anything that looks like markup is not a
        // transcript (an HTML error page from a reverse proxy, say).
        return if body.starts_with('<') { None } else { Some(body.to_string()) };
    };
    transcript_from_value(&value)
}

fn transcript_from_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(map) => {
            for key in ["text", "transcript", "transcription"] {
                if let Some(s) = map.get(key).and_then(|v| v.as_str()) {
                    if !s.trim().is_empty() {
                        return Some(s.to_string());
                    }
                }
            }
            // Segments without a top-level `text`: stitch them together.
            for key in ["segments", "chunks", "results"] {
                if let Some(items) = map.get(key).and_then(|v| v.as_array()) {
                    let joined = items
                        .iter()
                        .filter_map(transcript_from_value)
                        .collect::<Vec<_>>()
                        .join(" ");
                    if !joined.trim().is_empty() {
                        return Some(joined);
                    }
                }
            }
            // One level of wrapping (`{"data": {"text": ...}}` and friends).
            for key in ["data", "result", "response", "output"] {
                if let Some(inner) = map.get(key) {
                    if let Some(s) = transcript_from_value(inner) {
                        return Some(s);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::{audio_mime_for, parse_transcription};

    #[test]
    fn reads_the_openai_shape() {
        let t = parse_transcription(r#"{"text":"hello there"}"#).unwrap();
        assert_eq!(t.text, "hello there");
        assert!(t.segments.is_empty());
    }

    #[test]
    fn keeps_verbose_metadata() {
        let body = r#"{"text":"hi","language":"en","duration":1.5,
            "segments":[{"start":0.0,"end":1.5,"text":"hi","no_speech_prob":0.01}]}"#;
        let t = parse_transcription(body).unwrap();
        assert_eq!(t.language.as_deref(), Some("en"));
        assert_eq!(t.duration_secs, Some(1.5));
        assert_eq!(t.segments.len(), 1);
    }

    #[test]
    fn salvages_plain_text_and_alternate_keys() {
        assert_eq!(parse_transcription("hello there").unwrap().text, "hello there");
        assert_eq!(parse_transcription(r#"{"transcript":"hi"}"#).unwrap().text, "hi");
        assert_eq!(parse_transcription(r#"{"data":{"text":"hi"}}"#).unwrap().text, "hi");
    }

    #[test]
    fn stitches_segments_when_there_is_no_top_level_text() {
        let body = r#"{"segments":[{"text":"one"},{"text":"two"}]}"#;
        assert_eq!(parse_transcription(body).unwrap().text, "one two");
    }

    #[test]
    fn rejects_bodies_with_no_transcript() {
        assert!(parse_transcription("").is_none());
        assert!(parse_transcription("<html>oops</html>").is_none());
        assert!(parse_transcription(r#"{"error":"nope"}"#).is_none());
    }

    #[test]
    fn maps_extensions_to_mime_types() {
        assert_eq!(audio_mime_for("notes.m4a"), "audio/mp4");
        assert_eq!(audio_mime_for("dictation.wav"), "audio/wav");
        assert_eq!(audio_mime_for("mystery.bin"), "application/octet-stream");
    }
}
