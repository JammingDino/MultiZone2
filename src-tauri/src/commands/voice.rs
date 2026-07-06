//! Dictation commands (release 0.8.0): capture the mic (`audio.rs`) and
//! transcribe the recording through a user-configured provider's
//! OpenAI-compatible endpoint (`stt_api.rs`). There is no embedded transcription
//! engine — "local" transcription is done by pointing the provider at a local
//! server (e.g. LM Studio serving a whisper model), the same way the rest of the
//! app treats providers.

use serde::Deserialize;
use tauri::State;

use crate::audio::{self, CaptureHandle, VoiceInputDevice};
use crate::error::{AppError, AppResult};
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
