//! Normalising uploaded audio before it is transcribed (0.17.5).
//!
//! The desktop's own dictation path has always handed transcription endpoints
//! exactly one thing: 16 kHz mono WAV. `audio.rs` resamples at capture, on
//! purpose — "keeps the sample-rate conversion to the 16kHz mono that whisper
//! transcription endpoints expect close to the capture".
//!
//! The upload path did not. A phone records what its WebView can record, which
//! on every Android is `audio/webm;codecs=opus`, and until this release those
//! bytes went straight out to whatever `/audio/transcriptions` the user had
//! configured. Against OpenAI that happens to work. Against a local whisper.cpp
//! or an MLX server — the case this app is built around, and the case where the
//! recording never leaves the house — it fails, because those servers decode
//! WAV and little else. Two paths into the same endpoint, handing it two
//! different formats, one of which was only ever tested against a cloud.
//!
//! So the audio goes to the user's computer and the computer *prepares* it,
//! rather than relaying it. That is the same principle the whole remote design
//! rests on: the phone is a microphone and a screen, and the work happens on
//! the machine with the tools installed.
//!
//! **ffmpeg is used if it is there, and its absence is not an error.** Bundling
//! it would add ~80 MB to every installer for one feature, and the fallback —
//! send the original bytes — is exactly the behaviour of the release before
//! this one. What changes is that the failure is now explained: if the provider
//! then rejects the format, the error says ffmpeg was not found, which is the
//! one sentence that turns "dictation doesn't work" into something fixable.

use std::process::Stdio;

use tokio::io::AsyncWriteExt;

/// Audio, ready to send to a transcription endpoint.
pub struct Prepared {
    pub bytes: Vec<u8>,
    /// The name the upload travels under. The endpoint reads its extension to
    /// decide how to decode, so a converted file has to stop claiming to be
    /// the format it no longer is.
    pub file_name: String,
    /// Set when a conversion was wanted and could not happen, so the caller can
    /// say why if the provider goes on to refuse the upload.
    pub note: Option<String>,
}

/// What ffmpeg is asked to produce: mono, 16 kHz, signed 16-bit PCM in a WAV
/// container. Identical to what `audio.rs` produces from the desktop's own
/// microphone, which is the point — one format reaches the endpoint whichever
/// device the words were spoken into.
const TARGET_RATE: &str = "16000";

/// Formats that are already what a transcription endpoint wants, and are left
/// alone. WAV is what the desktop capture path produces; converting it again
/// would be a subprocess per dictation for no change in the bytes.
fn already_prepared(extension: &str) -> bool {
    matches!(extension, "wav")
}

fn extension_of(file_name: &str) -> String {
    std::path::Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Where to find ffmpeg.
///
/// `MULTIZONE_FFMPEG` first, for a build that ships one alongside itself or a
/// user who keeps it somewhere off `PATH`. Otherwise the bare name, which is
/// enough on all three platforms: unlike the `npx` case in `mcp/mod.rs`, ffmpeg
/// is a real executable rather than a shell shim, so Windows' `CreateProcess`
/// finds `ffmpeg.exe` without help.
fn ffmpeg_program() -> String {
    std::env::var("MULTIZONE_FFMPEG")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "ffmpeg".to_string())
}

/// Convert `bytes` to 16 kHz mono WAV, or hand them back unchanged.
///
/// Never fails: every failure path returns the originals with a `note`. A
/// recording that might still transcribe is worth more than an error, and the
/// caller is in a position to say something useful if it does not.
pub async fn prepare_for_transcription(bytes: Vec<u8>, file_name: &str) -> Prepared {
    let extension = extension_of(file_name);
    if already_prepared(&extension) {
        return Prepared { bytes, file_name: file_name.to_string(), note: None };
    }

    let program = ffmpeg_program();
    // `pipe:0` in, `pipe:1` out — nothing touches the disk. A dictation is a
    // recording of somebody's voice, and writing it to a temporary file leaves
    // a copy behind for the operating system to decide the lifetime of.
    let spawned = tokio::process::Command::new(&program)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            TARGET_RATE,
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "pipe:1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            tracing::warn!(
                "ffmpeg ({program}) could not be run, sending {file_name} to the transcription \
                 endpoint as it arrived: {e}"
            );
            return Prepared {
                bytes,
                file_name: file_name.to_string(),
                note: Some(format!(
                    "ffmpeg was not found on this computer, so the recording was sent as {extension} \
                     without being converted to the 16 kHz mono WAV most local transcription \
                     servers accept. Install ffmpeg (or set MULTIZONE_FFMPEG to its path) if the \
                     provider refuses the format."
                )),
            };
        }
    };

    // Written from its own task: ffmpeg starts producing output before it has
    // consumed all of its input, and a WAV of any length will fill the pipe
    // buffer. Writing and reading in sequence on one task deadlocks — both
    // sides blocked on a full pipe, waiting for the other to drain it.
    if let Some(mut stdin) = child.stdin.take() {
        let input = bytes.clone();
        tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
        });
    }

    let output = match child.wait_with_output().await {
        Ok(output) => output,
        Err(e) => {
            tracing::warn!("ffmpeg failed while converting {file_name}: {e}");
            return Prepared {
                bytes,
                file_name: file_name.to_string(),
                note: Some(format!("ffmpeg could not convert the recording: {e}")),
            };
        }
    };

    if !output.status.success() || output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim().lines().last().unwrap_or("no output").to_string();
        tracing::warn!("ffmpeg rejected {file_name}: {detail}");
        return Prepared {
            bytes,
            file_name: file_name.to_string(),
            note: Some(format!("ffmpeg could not read the recording ({detail}).")),
        };
    }

    tracing::info!(
        "converted {file_name} to 16 kHz mono WAV for transcription ({} → {} bytes)",
        bytes.len(),
        output.stdout.len(),
    );
    Prepared {
        bytes: output.stdout,
        file_name: converted_name(file_name),
        note: None,
    }
}

/// `dictation.webm` → `dictation.wav`. The extension is how the endpoint picks
/// a decoder, so it has to follow the bytes.
pub fn converted_name(file_name: &str) -> String {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("audio");
    format!("{stem}.wav")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_is_left_alone() {
        assert!(already_prepared("wav"));
        assert!(!already_prepared("webm"));
        assert!(!already_prepared("m4a"));
    }

    #[test]
    fn the_converted_name_carries_the_new_format() {
        assert_eq!(converted_name("dictation.webm"), "dictation.wav");
        assert_eq!(converted_name("meeting notes.m4a"), "meeting notes.wav");
        // No extension, and no name at all: neither should produce something
        // the multipart upload cannot be given a filename from.
        assert_eq!(converted_name("recording"), "recording.wav");
        assert_eq!(converted_name(""), "audio.wav");
    }

    #[test]
    fn the_extension_is_read_case_insensitively() {
        assert_eq!(extension_of("Recording.WEBM"), "webm");
        assert_eq!(extension_of("no-extension"), "");
    }

    /// A WAV goes through untouched without ever spawning anything, which is
    /// what keeps the desktop's own dictation path free of a subprocess.
    #[tokio::test]
    async fn a_wav_upload_is_returned_unchanged() {
        let bytes = b"RIFF....WAVEfmt ".to_vec();
        let prepared = prepare_for_transcription(bytes.clone(), "dictation.wav").await;
        assert_eq!(prepared.bytes, bytes);
        assert_eq!(prepared.file_name, "dictation.wav");
        assert!(prepared.note.is_none());
    }

    /// The real thing, when the machine running the tests has ffmpeg.
    ///
    /// Skips rather than fails without it: ffmpeg is optional by design, and a
    /// test that turned "not installed" into a red build would be asserting the
    /// opposite of what this module promises. What it does check is the part
    /// that cannot be checked by reasoning — that the bytes coming back are a
    /// WAV, and a 16 kHz mono one.
    #[tokio::test]
    async fn a_webm_recording_becomes_16k_mono_wav() {
        let program = ffmpeg_program();
        if tokio::process::Command::new(&program)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_err()
        {
            eprintln!("skipping: no ffmpeg on this machine");
            return;
        }

        // A second of silence in the container an Android WebView records in.
        let source = tokio::process::Command::new(&program)
            .args([
                "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-t", "1", "-c:a", "libopus", "-f", "webm", "pipe:1",
            ])
            .output()
            .await
            .expect("ffmpeg runs");
        if !source.status.success() || source.stdout.is_empty() {
            eprintln!("skipping: this ffmpeg has no libopus");
            return;
        }

        let prepared = prepare_for_transcription(source.stdout, "dictation.webm").await;
        // The name is the record of the conversion: a converted upload has to
        // stop claiming to be the format it no longer is.
        assert_eq!(prepared.file_name, "dictation.wav", "note: {:?}", prepared.note);
        assert!(prepared.note.is_none());

        let wav = &prepared.bytes;
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        // The `fmt ` chunk starts at 12: two bytes of format tag, then the
        // channel count, then the sample rate — the two numbers the whole
        // conversion exists to pin down.
        let channels = u16::from_le_bytes([wav[22], wav[23]]);
        let rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
        assert_eq!(channels, 1, "mono");
        assert_eq!(rate, 16_000, "16 kHz");
    }

    /// The no-ffmpeg path returns the originals and explains itself, rather
    /// than failing the transcription outright.
    #[tokio::test]
    async fn a_missing_ffmpeg_falls_back_to_the_original_bytes() {
        std::env::set_var("MULTIZONE_FFMPEG", "multizone-no-such-ffmpeg-binary");
        let bytes = b"not really webm".to_vec();
        let prepared = prepare_for_transcription(bytes.clone(), "dictation.webm").await;
        std::env::remove_var("MULTIZONE_FFMPEG");

        assert_eq!(prepared.bytes, bytes, "the recording is still sent");
        assert_eq!(prepared.file_name, "dictation.webm", "still claiming its real format");
        let note = prepared.note.expect("a reason to quote if the provider refuses");
        assert!(note.contains("ffmpeg"), "the note names what is missing: {note}");
    }
}
