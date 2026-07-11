//! Dictation commands (release 0.8.0): capture the mic (`audio.rs`) and
//! transcribe the recording through a user-configured provider's
//! OpenAI-compatible endpoint (`stt_api.rs`). There is no embedded transcription
//! engine — "local" transcription is done by pointing the provider at a local
//! server (e.g. LM Studio serving a whisper model), the same way the rest of the
//! app treats providers.

use base64::Engine;
use serde::Deserialize;
use tauri::State;

use crate::audio::{self, CaptureHandle, VoiceInputDevice};
use crate::error::{AppError, AppResult};
use crate::llm::client::LlmClient;
use crate::llm::thinking::strip_thinking_blocks;
use crate::llm::types::{ChatMessage, ChatRequest, MessageContent};
use crate::state::AppState;

#[tauri::command]
pub fn list_voice_input_devices() -> AppResult<Vec<VoiceInputDevice>> {
    audio::list_input_devices()
}

/// Minimal read of the fields this feature needs out of the single
/// `app_settings` JSON blob (see `commands::settings`), rather than
/// introducing a separate settings row — mirrors how other backend code that
/// needs a setting value reads through the same key.
///
/// `stt_provider_id` is the id of one of the app's existing `Provider` rows
/// (base URL + API key) — the same providers zones already point at, so any
/// OpenAI-compatible transcription endpoint (OpenAI's hosted one, or a local
/// server like LM Studio) works the same way. `None` means the user hasn't
/// picked a dictation provider yet, and `stop_dictation` returns a typed error
/// prompting them to configure one.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SttSettings {
    stt_provider_id: Option<String>,
    stt_model: String,
    stt_language: String,
}

async fn read_stt_settings(state: &AppState) -> SttSettings {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let Some((raw,)) = row else {
        return SttSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

#[tauri::command]
pub async fn start_dictation(
    state: State<'_, AppState>,
    device_name: Option<String>,
) -> AppResult<String> {
    let mut sessions = state.voice_sessions.lock().await;
    if !sessions.is_empty() {
        return Err(AppError::Other(
            "a dictation session is already in progress".to_string(),
        ));
    }
    let handle = tokio::task::spawn_blocking(move || audio::start_capture(device_name))
        .await
        .map_err(|e| AppError::Other(format!("capture startup task failed: {e}")))??;
    let session_id = crate::commands::new_id();
    sessions.insert(session_id.clone(), handle);
    Ok(session_id)
}

fn take_session(
    sessions: &mut std::collections::HashMap<String, CaptureHandle>,
    session_id: &str,
) -> AppResult<CaptureHandle> {
    sessions
        .remove(session_id)
        .ok_or_else(|| AppError::NotFound(format!("no active dictation session: {session_id}")))
}

#[tauri::command]
pub async fn stop_dictation(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<String> {
    let handle = {
        let mut sessions = state.voice_sessions.lock().await;
        take_session(&mut sessions, &session_id)?
    };
    let samples = tokio::task::spawn_blocking(move || audio::stop_capture(handle))
        .await
        .map_err(|e| AppError::Other(format!("capture stop task failed: {e}")))??;
    if samples.is_empty() {
        return Ok(String::new());
    }

    let settings = read_stt_settings(&state).await;
    let lang = if settings.stt_language.is_empty() {
        None
    } else {
        Some(settings.stt_language.clone())
    };

    let provider_id = settings.stt_provider_id.ok_or_else(|| {
        AppError::Invalid(
            "no dictation provider configured — pick one in Settings → Voice".to_string(),
        )
    })?;
    if settings.stt_model.is_empty() {
        return Err(AppError::Invalid(
            "no dictation model selected for this provider — pick one in Settings → Voice".to_string(),
        ));
    }
    let provider: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT base_url, api_key FROM providers WHERE id = ?1")
            .bind(&provider_id)
            .fetch_optional(&state.db)
            .await?;
    let (base_url, api_key) = provider.ok_or_else(|| {
        AppError::NotFound(format!("dictation provider not found: {provider_id}"))
    })?;
    let wav_bytes = encode_wav(&samples)?;
    crate::stt_api::transcribe_via_provider(
        &state.http,
        &base_url,
        api_key.as_deref(),
        &settings.stt_model,
        wav_bytes,
        lang.as_deref(),
    )
    .await
}

/// Encodes 16kHz mono `f32` samples as an in-memory WAV file — the format
/// OpenAI-compatible transcription endpoints expect as the uploaded file
/// (they don't accept raw PCM floats directly).
fn encode_wav(samples: &[f32]) -> AppResult<Vec<u8>> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: crate::audio::WHISPER_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    {
        let mut writer = hound::WavWriter::new(&mut buf, spec)
            .map_err(|e| AppError::Other(format!("wav encode failed: {e}")))?;
        for &s in samples {
            let clamped = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer
                .write_sample(clamped)
                .map_err(|e| AppError::Other(format!("wav encode failed: {e}")))?;
        }
        writer
            .finalize()
            .map_err(|e| AppError::Other(format!("wav encode failed: {e}")))?;
    }
    Ok(buf.into_inner())
}

/// Text-to-speech settings, read out of the same `app_settings` JSON blob as
/// the STT ones. `tts_provider_id` is the id of an existing `Provider` row, so
/// any OpenAI-compatible `/audio/speech` endpoint (OpenAI's, or a local server)
/// works the same way. `None` means the user hasn't configured a TTS provider
/// yet, and `synthesize_speech` returns a typed error prompting them to.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct TtsSettings {
    tts_provider_id: Option<String>,
    tts_model: String,
    tts_voice: String,
    tts_rate: f32,
}

async fn read_tts_settings(state: &AppState) -> TtsSettings {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let Some((raw,)) = row else {
        return TtsSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Base64 audio plus its MIME type, so the webview can build a playable data
/// URL with the type the endpoint actually returned (MP3, WAV, …).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizedAudio {
    audio: String,
    mime: String,
}

/// Synthesizes `text` to speech through the configured TTS provider and returns
/// the base64-encoded audio and its MIME type. An optional `voice` override lets
/// a per-zone voice win over the global default.
#[tauri::command]
pub async fn synthesize_speech(
    state: State<'_, AppState>,
    text: String,
    voice: Option<String>,
) -> AppResult<SynthesizedAudio> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(SynthesizedAudio { audio: String::new(), mime: String::new() });
    }

    let settings = read_tts_settings(&state).await;
    let provider_id = settings.tts_provider_id.ok_or_else(|| {
        AppError::Invalid(
            "no speech provider configured — pick one in Settings → Voice".to_string(),
        )
    })?;
    if settings.tts_model.is_empty() {
        return Err(AppError::Invalid(
            "no speech model selected for this provider — pick one in Settings → Voice".to_string(),
        ));
    }
    let chosen_voice = voice
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| settings.tts_voice.clone());
    if chosen_voice.is_empty() {
        return Err(AppError::Invalid(
            "no voice selected for speech — pick one in Settings → Voice".to_string(),
        ));
    }
    let rate = if settings.tts_rate > 0.0 { settings.tts_rate } else { 1.0 };

    let provider: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT base_url, api_key FROM providers WHERE id = ?1")
            .bind(&provider_id)
            .fetch_optional(&state.db)
            .await?;
    let (base_url, api_key) = provider
        .ok_or_else(|| AppError::NotFound(format!("speech provider not found: {provider_id}")))?;

    let (bytes, mime) = crate::tts_api::synthesize_via_provider(
        &state.http,
        &base_url,
        api_key.as_deref(),
        &settings.tts_model,
        &chosen_voice,
        text,
        rate,
    )
    .await?;
    Ok(SynthesizedAudio {
        audio: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime,
    })
}

/// Resolves the configured TTS provider's (base_url, api_key), or a typed error
/// prompting configuration. Shared by the voice-cloning commands.
async fn tts_provider(state: &AppState) -> AppResult<(String, Option<String>)> {
    let settings = read_tts_settings(state).await;
    let provider_id = settings.tts_provider_id.ok_or_else(|| {
        AppError::Invalid("no speech provider configured — pick one in Settings → Voice".to_string())
    })?;
    let provider: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT base_url, api_key FROM providers WHERE id = ?1")
            .bind(&provider_id)
            .fetch_optional(&state.db)
            .await?;
    provider.ok_or_else(|| AppError::NotFound(format!("speech provider not found: {provider_id}")))
}

/// Lists the voices the configured speech provider offers (via its shim-only
/// `/audio/voices` endpoint). Empty when the provider doesn't expose one.
#[tauri::command]
pub async fn list_tts_voices(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let (base_url, api_key) = tts_provider(&state).await?;
    crate::tts_api::list_voices_via_provider(&state.http, &base_url, api_key.as_deref()).await
}

/// Registers a cloned voice: uploads the reference audio file at `audio_path`
/// (and optional transcript) to the provider under `name`.
#[tauri::command]
pub async fn create_cloned_voice(
    state: State<'_, AppState>,
    name: String,
    audio_path: String,
    ref_text: String,
) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("voice name is required".to_string()));
    }
    let (base_url, api_key) = tts_provider(&state).await?;
    let bytes = std::fs::read(&audio_path)
        .map_err(|e| AppError::Invalid(format!("could not read audio file {audio_path}: {e}")))?;
    let file_name = std::path::Path::new(&audio_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("sample.wav")
        .to_string();
    crate::tts_api::upload_voice_via_provider(
        &state.http,
        &base_url,
        api_key.as_deref(),
        name,
        ref_text.trim(),
        &file_name,
        bytes,
    )
    .await
}

/// Transcribes an existing audio file through the configured STT provider —
/// used to auto-fill a cloned voice's reference transcript from its sample.
#[tauri::command]
pub async fn transcribe_audio_file(
    state: State<'_, AppState>,
    audio_path: String,
) -> AppResult<String> {
    let settings = read_stt_settings(&state).await;
    let provider_id = settings.stt_provider_id.ok_or_else(|| {
        AppError::Invalid("no dictation provider configured — pick one in Settings → Voice".to_string())
    })?;
    if settings.stt_model.is_empty() {
        return Err(AppError::Invalid(
            "no dictation model selected — pick one in Settings → Voice".to_string(),
        ));
    }
    let provider: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT base_url, api_key FROM providers WHERE id = ?1")
            .bind(&provider_id)
            .fetch_optional(&state.db)
            .await?;
    let (base_url, api_key) = provider
        .ok_or_else(|| AppError::NotFound(format!("dictation provider not found: {provider_id}")))?;
    let bytes = std::fs::read(&audio_path)
        .map_err(|e| AppError::Invalid(format!("could not read audio file {audio_path}: {e}")))?;
    let lang = if settings.stt_language.is_empty() { None } else { Some(settings.stt_language.clone()) };
    crate::stt_api::transcribe_via_provider(
        &state.http,
        &base_url,
        api_key.as_deref(),
        &settings.stt_model,
        bytes,
        lang.as_deref(),
    )
    .await
}

/// Condenses a long assistant response into a short, speech-friendly summary
/// so text-to-speech doesn't read out massive verbose blocks (code, tables,
/// long enumerations). Runs through the chat's effective zone/provider — the
/// same model the chat already uses — so no extra configuration is needed.
#[tauri::command]
pub async fn summarize_for_speech(
    state: State<'_, AppState>,
    chat_id: String,
    text: String,
) -> AppResult<String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }

    let (zone, provider) =
        crate::commands::messages::effective_zone_and_provider(&state.db, &chat_id).await?;

    let prompt = format!(
        "Rewrite the following assistant response as a concise spoken summary suitable for text-to-speech. \
Drop code blocks, tables, URLs and markdown formatting; keep it to a few natural sentences that capture the key points. \
Respond with ONLY the spoken summary — no preamble, no markdown.\n\nResponse:\n{text}"
    );

    let req = ChatRequest {
        model: zone.model.clone(),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: Some(MessageContent::Text(prompt)),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }],
        temperature: Some(0.3),
        max_tokens: Some(1024),
        top_p: None,
        tools: None,
        reasoning_effort: None,
        stream: false,
    };

    let client = LlmClient::new(&state.http, &provider.base_url, provider.api_key.as_deref());
    let resp = client.chat_completion(&req).await?;
    let summary = resp
        .choices
        .first()
        .and_then(|c| match &c.message.content {
            Some(MessageContent::Text(s)) => Some(s.clone()),
            Some(MessageContent::Parts(parts)) => {
                let joined: String = parts
                    .iter()
                    .filter_map(|p| match p {
                        crate::llm::types::ContentPart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                if joined.is_empty() { None } else { Some(joined) }
            }
            None => None,
        })
        .unwrap_or_default();

    let summary = strip_thinking_blocks(&summary);
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        // Fall back to the original text if the model returned nothing usable.
        Ok(text.to_string())
    } else {
        Ok(summary)
    }
}

#[tauri::command]
pub async fn cancel_dictation(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let handle = {
        let mut sessions = state.voice_sessions.lock().await;
        take_session(&mut sessions, &session_id)?
    };
    tokio::task::spawn_blocking(move || audio::cancel_capture(handle))
        .await
        .map_err(|e| AppError::Other(format!("capture cancel task failed: {e}")))?;
    Ok(())
}
