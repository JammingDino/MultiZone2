/**
 * Dictation, wherever the microphone happens to be (0.17.4).
 *
 * On the desktop this is unchanged: `cpal` captures, the Rust side holds the
 * session, and the transcript comes back from `stop_dictation`.
 *
 * On a phone there is no `cpal` — the mobile build has no audio stack at all,
 * by design — and there is a much better microphone in the user's hand than in
 * their laptop. So the phone captures in the WebView with `MediaRecorder` and
 * posts the bytes to the desktop, which transcribes them with the provider it
 * is already configured with.
 *
 * That keeps the line the whole remote design is built on: **the phone is an
 * input device and a screen, and nothing is inferred on it.** Speaking into a
 * phone and having the machine at home turn it into text is arguably the single
 * thing this app does better *because* it is a remote rather than despite it.
 *
 * Two honest differences from the desktop path, both surfaced rather than
 * papered over:
 *
 * - **No live partial transcript.** The desktop re-transcribes the utterance so
 *   far every couple of seconds; doing that over a LAN would upload the whole
 *   recording repeatedly. [`partial`] returns "" on a phone and the composer
 *   simply shows no preview.
 * - **The level meter is local.** It comes from a `AnalyserNode` on the live
 *   stream rather than from the recorder, which is if anything more responsive.
 */

import * as api from "@/lib/tauri";
import { isRemote } from "@/lib/remote/transport";

/** A capture in progress in the WebView. */
interface WebSession {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  audioContext: AudioContext;
  analyser: AnalyserNode;
  /** Resolves when the recorder has flushed everything it holds. */
  finished: Promise<void>;
}

const webSessions = new Map<string, WebSession>();

/** True when capture has to happen in this window rather than on the machine
 *  the app is running on. */
function capturesLocally(): boolean {
  return isRemote();
}

/**
 * The container to record in.
 *
 * `audio/webm` on every Chromium — which is every Android WebView — and
 * `audio/mp4` on Safari. Both are formats the transcription endpoint accepts,
 * and `stt_api::audio_mime_for` maps the extension for the upload. An empty
 * string lets the browser pick, which is better than insisting on a type it has
 * just told us it cannot produce.
 */
function pickMimeType(): { mimeType: string; extension: string } {
  const candidates = [
    { mimeType: "audio/webm;codecs=opus", extension: "webm" },
    { mimeType: "audio/webm", extension: "webm" },
    { mimeType: "audio/mp4", extension: "m4a" },
    { mimeType: "audio/ogg;codecs=opus", extension: "ogg" },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mimeType)) {
      return c;
    }
  }
  return { mimeType: "", extension: "webm" };
}

export async function start(deviceName: string | null): Promise<string> {
  if (!capturesLocally()) return api.startDictation(deviceName);

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("This device has no microphone available to the app.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e: any) {
    // The overwhelmingly common cause, and the one the user can fix. Worth
    // naming rather than passing a DOMException through to a toast.
    if (e?.name === "NotAllowedError") {
      throw new Error("Microphone access was denied. Allow it for MultiZone in your device settings.");
    }
    throw new Error(e?.message || String(e));
  }

  const { mimeType } = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  // The meter reads the live stream rather than the recorder: the recorder only
  // surfaces data in chunks, and a meter that updates once a second is not a
  // meter.
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);

  recorder.start();
  const id = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  webSessions.set(id, { recorder, stream, chunks, audioContext, analyser, finished });
  return id;
}

export async function stop(sessionId: string): Promise<string> {
  const session = webSessions.get(sessionId);
  if (!session) return api.stopDictation(sessionId);

  webSessions.delete(sessionId);
  if (session.recorder.state !== "inactive") session.recorder.stop();
  await session.finished;
  teardown(session);

  const { extension } = pickMimeType();
  const blob = new Blob(session.chunks, { type: session.recorder.mimeType || "audio/webm" });
  if (blob.size === 0) return "";

  const transcription = await api.transcribeAudioUpload(
    `dictation.${extension}`,
    await toBase64(blob),
    false,
    null,
  );
  return transcription.text ?? "";
}

export async function cancel(sessionId: string): Promise<void> {
  const session = webSessions.get(sessionId);
  if (!session) return api.cancelDictation(sessionId);
  webSessions.delete(sessionId);
  if (session.recorder.state !== "inactive") session.recorder.stop();
  teardown(session);
}

/** Input peak, 0–1, for the meter. */
export async function level(sessionId: string): Promise<number> {
  const session = webSessions.get(sessionId);
  if (!session) return api.dictationLevel(sessionId);

  const data = new Uint8Array(session.analyser.fftSize);
  session.analyser.getByteTimeDomainData(data);
  let peak = 0;
  for (const sample of data) {
    // 128 is silence in unsigned 8-bit PCM, so distance from it is amplitude.
    peak = Math.max(peak, Math.abs(sample - 128) / 128);
  }
  return peak;
}

/**
 * A provisional transcript, on the desktop only.
 *
 * The desktop re-transcribes the whole utterance every couple of seconds, which
 * is cheap against a local model and would mean re-uploading the entire
 * recording over a LAN on every tick. Empty rather than approximated: the
 * composer shows no preview, which is honest, instead of a stale one.
 */
export async function partial(sessionId: string): Promise<string> {
  if (webSessions.has(sessionId)) return "";
  return api.dictationPartial(sessionId);
}

/** Whether a live preview is available at all, so the UI can leave the space
 *  out instead of rendering an empty box that never fills. */
export function supportsPartials(): boolean {
  return !capturesLocally();
}

function teardown(session: WebSession) {
  // Both matter on a phone: an un-stopped track leaves the recording indicator
  // in the status bar, and an un-closed AudioContext keeps the mic warm.
  for (const track of session.stream.getTracks()) track.stop();
  void session.audioContext.close().catch(() => {});
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read the recording"));
    reader.onload = () => {
      const result = String(reader.result);
      // `data:audio/webm;base64,AAAA…` — the payload is what the API wants.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}
