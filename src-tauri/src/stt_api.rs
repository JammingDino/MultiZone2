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

/// POSTs the recorded audio to a provider's OpenAI-compatible transcription
/// endpoint and returns the transcript text.
///
/// `file_name` is the name the audio is uploaded under; its extension is what
/// most servers (and ffmpeg behind them) use to pick a decoder, so a caller
/// uploading an existing file should pass that file's real name rather than a
/// generic one.
pub async fn transcribe_via_provider(
    http: &Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    audio_bytes: Vec<u8>,
    file_name: &str,
    lang: Option<&str>,
) -> AppResult<String> {
    let url = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));
    let mime = mime_for(file_name);

    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(audio_bytes)
                .file_name(file_name.to_string())
                .mime_str(mime)?,
        );
    if let Some(l) = lang {
        if !l.is_empty() {
            form = form.text("language", l.to_string());
        }
    }

    // Same diagnostics as the TTS path: this prints to the `npm run tauri dev`
    // console and is the quickest way to separate a misconfigured
    // endpoint/model from an actual transcription failure.
    tracing::info!(
        "STT request → POST {url} (model={model:?}, file={file_name:?}, lang={lang:?}, auth={})",
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

    match extract_transcript(&body_text) {
        Some(text) => Ok(text.trim().to_string()),
        None => {
            tracing::error!("STT endpoint returned an unrecognized body ({content_type}): {body_text}");
            Err(AppError::Provider(format!(
                "transcription endpoint returned a response with no transcript in it (content-type: {content_type}). Body: {}",
                truncate(&body_text, 800)
            )))
        }
    }
}

/// Pulls the transcript out of whatever the endpoint answered with.
///
/// OpenAI's documented shape is `{"text": "..."}`, but the servers people point
/// this at in practice are not all faithful to it: some answer plain text, some
/// use `transcript`, some only return `verbose_json`-style `segments`, and some
/// wrap the payload one level deep. Accepting all of those is the difference
/// between dictation working and an opaque decode error, so parse leniently and
/// only give up when there is genuinely no text anywhere.
fn extract_transcript(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }

    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        // Not JSON at all — a server that answers `text/plain` with the
        // transcript itself. Anything that looks like markup is not a
        // transcript (an HTML error page from a reverse proxy, say).
        return if trimmed.starts_with('<') { None } else { Some(trimmed.to_string()) };
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
            // `verbose_json` without a top-level `text`: stitch the segments.
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

/// The MIME type to upload an audio file under, from its extension. Servers
/// generally sniff the filename anyway, but sending `audio/wav` for an MP3 is
/// the kind of mismatch a strict endpoint rejects outright.
fn mime_for(file_name: &str) -> &'static str {
    let ext = std::path::Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "mp4" | "m4a" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "webm" => "audio/webm",
        "mpeg" | "mpga" => "audio/mpeg",
        _ => "audio/wav",
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
    use super::extract_transcript;

    #[test]
    fn reads_the_openai_shape() {
        assert_eq!(extract_transcript(r#"{"text":"hello there"}"#).unwrap(), "hello there");
    }

    #[test]
    fn reads_plain_text_and_alternate_keys() {
        assert_eq!(extract_transcript("hello there").unwrap(), "hello there");
        assert_eq!(extract_transcript(r#"{"transcript":"hi"}"#).unwrap(), "hi");
        assert_eq!(extract_transcript(r#"{"data":{"text":"hi"}}"#).unwrap(), "hi");
    }

    #[test]
    fn stitches_segments_when_there_is_no_top_level_text() {
        let body = r#"{"segments":[{"text":"one"},{"text":"two"}]}"#;
        assert_eq!(extract_transcript(body).unwrap(), "one two");
    }

    #[test]
    fn rejects_bodies_with_no_transcript() {
        assert!(extract_transcript("").is_none());
        assert!(extract_transcript("<html>oops</html>").is_none());
        assert!(extract_transcript(r#"{"error":"nope"}"#).is_none());
    }
}
