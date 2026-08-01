//! Microphone capture for dictation (release 0.8.0).
//!
//! Capture happens in Rust via `cpal` rather than the webview (`getUserMedia`):
//! Tauri 2's mic-permission behaviour is inconsistent across WebView2/WebKit,
//! and capturing here keeps the sample-rate conversion to the 16kHz mono that
//! whisper transcription endpoints expect close to the capture, with device
//! enumeration/selection done through `cpal::Host::input_devices()` directly.
//! The resampled samples are WAV-encoded and uploaded to the configured STT
//! provider in `commands::voice` — there is no in-process inference here.
//!
//! This accumulates the whole session's raw audio and resamples once, at
//! `stop_capture`, since the transcript is only needed after the user stops
//! speaking (there are no live partials).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInputDevice {
    pub name: String,
    pub is_default: bool,
}

pub fn list_input_devices() -> AppResult<Vec<VoiceInputDevice>> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let mut out = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                let is_default = default_name.as_deref() == Some(name.as_str());
                out.push(VoiceInputDevice { name, is_default });
            }
        }
    }
    Ok(out)
}

fn resolve_device(host: &cpal::Host, device_name: Option<&str>) -> AppResult<cpal::Device> {
    if let Some(name) = device_name {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(found) = devices.find(|d| d.name().map(|n| n == name).unwrap_or(false)) {
                return Ok(found);
            }
        }
        // Named device no longer present — fall back to the system default
        // rather than failing outright, same "settings may reference
        // something that's gone" tolerance used elsewhere in this codebase.
        tracing::warn!("input device '{name}' not found, falling back to system default");
    }
    host.default_input_device()
        .ok_or_else(|| AppError::Other("no microphone / input device available".to_string()))
}

/// Handle to a live capture session. Dropping without calling `stop_capture`
/// (e.g. on cancel) simply stops the stream and discards the buffer.
pub struct CaptureHandle {
    stop_tx: std::sync::mpsc::Sender<()>,
    join: Option<std::thread::JoinHandle<()>>,
    buffer: Arc<Mutex<Vec<f32>>>,
    source_rate: u32,
    /// Peak amplitude of the most recent callback's samples, as `f32` bits.
    ///
    /// Transcription only needs the audio at the end, but the *user* needs to
    /// know the mic is live while they are still talking — a recording that
    /// looks identical whether or not the device is working is the whole
    /// complaint the meter answers. An atomic rather than the buffer mutex
    /// because this is read on a poll from the UI thread and must never make
    /// the realtime audio callback wait.
    level: Arc<AtomicU32>,
}

impl CaptureHandle {
    /// Most recent input peak, 0.0 (silence) to 1.0 (clipping).
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
}

/// Starts capturing from `device_name` (or the system default when `None`) on
/// a dedicated OS thread — `cpal` streams are not reliably `Send`, so the
/// stream is built, played, and torn down entirely on one thread, signalled
/// via a stop channel rather than moved across an await point.
pub fn start_capture(device_name: Option<String>) -> AppResult<CaptureHandle> {
    let host = cpal::default_host();
    let device = resolve_device(&host, device_name.as_deref())?;
    let config = device
        .default_input_config()
        .map_err(|e| AppError::Other(format!("failed to read input device config: {e}")))?;
    let source_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();

    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let buffer_for_thread = buffer.clone();
    let level: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
    let level_for_thread = level.clone();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<AppResult<()>>();

    let join = std::thread::spawn(move || {
        let err_fn = |e: cpal::StreamError| tracing::warn!("audio stream error: {e}");
        let build_result = build_stream(&device, &stream_config, sample_format, channels, buffer_for_thread, level_for_thread, err_fn);
        let stream = match build_result {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = ready_tx.send(Err(AppError::Other(format!("failed to start capture: {e}"))));
            return;
        }
        let _ = ready_tx.send(Ok(()));
        // Block this thread until told to stop; the stream keeps running (and
        // the buffer keeps filling) for the duration.
        let _ = stop_rx.recv();
        drop(stream);
    });

    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err(AppError::Other("capture thread exited unexpectedly".to_string())),
    }

    Ok(CaptureHandle { stop_tx, join: Some(join), buffer, source_rate, level })
}

fn build_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    channels: usize,
    buffer: Arc<Mutex<Vec<f32>>>,
    level: Arc<AtomicU32>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> AppResult<cpal::Stream> {
    macro_rules! build {
        ($ty:ty, $convert:expr) => {
            device.build_input_stream(
                config,
                move |data: &[$ty], _| {
                    let mono = to_mono(data, channels, $convert);
                    let peak = mono.iter().fold(0.0f32, |m, s| m.max(s.abs()));
                    level.store(peak.to_bits(), Ordering::Relaxed);
                    if let Ok(mut buf) = buffer.lock() {
                        buf.extend_from_slice(&mono);
                    }
                },
                err_fn,
                None,
            )
        };
    }
    let stream = match sample_format {
        cpal::SampleFormat::F32 => build!(f32, |s: f32| s),
        cpal::SampleFormat::I16 => build!(i16, |s: i16| s as f32 / i16::MAX as f32),
        cpal::SampleFormat::U16 => build!(u16, |s: u16| (s as f32 - 32768.0) / 32768.0),
        other => return Err(AppError::Other(format!("unsupported sample format: {other:?}"))),
    };
    stream.map_err(|e| AppError::Other(format!("failed to open input stream: {e}")))
}

fn to_mono<T: Copy>(data: &[T], channels: usize, convert: impl Fn(T) -> f32) -> Vec<f32> {
    if channels <= 1 {
        return data.iter().map(|&s| convert(s)).collect();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().map(|&s| convert(s)).sum::<f32>() / channels as f32)
        .collect()
}

pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// Simple linear-interpolation resampler. whisper.cpp needs exactly 16kHz
/// mono; device rates are typically 44.1/48kHz. Linear interpolation is not
/// as clean as a proper sinc resampler, but it's a small amount of dependency-
/// free code and is adequate for speech (the accuracy-sensitive content is
/// well below the Nyquist frequency at either rate).
fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = input[idx];
        let b = *input.get(idx + 1).unwrap_or(&a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Stops the capture thread and returns the full session's audio, resampled
/// to 16kHz mono for whisper.
pub fn stop_capture(mut handle: CaptureHandle) -> AppResult<Vec<f32>> {
    let _ = handle.stop_tx.send(());
    if let Some(j) = handle.join.take() {
        let _ = j.join();
    }
    let raw = handle.buffer.lock().map(|b| b.clone()).unwrap_or_default();
    Ok(resample_linear(&raw, handle.source_rate, WHISPER_SAMPLE_RATE))
}

/// Discards a capture session without transcribing (used by `cancel_dictation`).
pub fn cancel_capture(mut handle: CaptureHandle) {
    let _ = handle.stop_tx.send(());
    if let Some(j) = handle.join.take() {
        let _ = j.join();
    }
}
