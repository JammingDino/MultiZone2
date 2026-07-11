import { create } from "zustand";
import * as api from "@/lib/tauri";

/**
 * Text-to-speech playback (0.8.1). A single-active-session player that
 * synthesizes text through the configured provider and plays the returned MP3
 * clips back to back.
 *
 * Two entry points feed the same queue:
 *  - `readAloud` — one-shot "Read aloud" of a finished message (optionally
 *    LLM-summarized first), split into sentences and queued all at once.
 *  - `startStreaming` / `feedStreaming` / `finishStreaming` — auto-speak, where
 *    sentences are queued as they arrive so speech starts before the full
 *    answer completes.
 *
 * Audio element + queue live in module scope (not the store) so token streaming
 * doesn't churn React; the store holds only the reactive status the UI reads.
 */

export type TtsStatus = "idle" | "loading" | "playing" | "paused";

interface TtsStore {
  /** The message currently being spoken (or loading), else null. */
  activeMessageId: string | null;
  status: TtsStatus;
  error: string | null;
  /** The message whose playback errored, so the UI can show it in context. */
  errorMessageId: string | null;
  clearError: () => void;

  readAloud: (messageId: string, chatId: string, text: string, voice: string | null) => Promise<void>;
  startStreaming: (messageId: string, voice: string | null) => void;
  feedStreaming: (fullTextSoFar: string) => void;
  finishStreaming: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

/** A zone's per-zone default voice (0.8.1), stored under `tts_voice` in its
 *  tool_config JSON. Returns null when unset so the global default wins. */
export function zoneVoice(toolConfig: string | null | undefined): string | null {
  if (!toolConfig) return null;
  try {
    const v = (JSON.parse(toolConfig) as Record<string, unknown>).tts_voice;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

// ── Module-scoped playback engine ────────────────────────────────────────────

/** Bumped on every new session / stop; in-flight async work checks it to bail. */
let sessionToken = 0;
let queue: string[] = [];
/** True while more chunks may still be fed (streaming not yet finished). */
let streamingOpen = false;
let workerRunning = false;
let paused = false;
let currentAudio: HTMLAudioElement | null = null;
let voice: string | null = null;
/** The message id of the active session, for attributing errors in the UI. */
let sessionMessageId: string | null = null;
/** Buffer of not-yet-sentence-complete streamed text. */
let pendingBuffer = "";
/** Count of sentences already queued for the active streaming session. */
let emittedCount = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip markdown so the synthesizer reads prose, not syntax. */
function cleanForSpeech(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>~]/g, "")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

const TERMINATORS = ".!?。！？\n";
const MAX_CHUNK = 240;

/**
 * Pulls complete sentences off the front of `buf`, leaving a remainder. With
 * `force`, the trailing remainder is emitted too (end of stream / one-shot).
 */
function drainSentences(buf: string, force: boolean): [string[], string] {
  const out: string[] = [];
  let start = 0;
  for (let p = 0; p < buf.length; p++) {
    const isEnd = TERMINATORS.includes(buf[p]);
    if (isEnd) {
      let e = p + 1;
      while (e < buf.length && (TERMINATORS.includes(buf[e]) || buf[e] === " ")) e++;
      const seg = buf.slice(start, e).trim();
      if (seg) out.push(seg);
      start = e;
      p = e - 1;
    } else if (p - start > MAX_CHUNK && buf[p] === " ") {
      const seg = buf.slice(start, p).trim();
      if (seg) out.push(seg);
      start = p + 1;
    }
  }
  let remainder = buf.slice(start);
  if (force && remainder.trim()) {
    out.push(remainder.trim());
    remainder = "";
  }
  return [out, remainder];
}

let store: {
  set: (partial: Partial<TtsStore>) => void;
  get: () => TtsStore;
} | null = null;

function setStatus(status: TtsStatus) {
  store?.set({ status });
}

function playBase64(b64: string, token: number): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(`data:audio/mp3;base64,${b64}`);
    currentAudio = audio;
    const done = () => {
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    if (token === sessionToken && !paused) {
      setStatus("playing");
      audio.play().catch(done);
    } else if (paused) {
      // Loaded but held; UI shows paused. Resume() will start it.
      setStatus("paused");
    }
  });
}

async function runWorker(token: number) {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (token === sessionToken) {
      while (paused && token === sessionToken) await sleep(120);
      if (token !== sessionToken) break;
      if (queue.length === 0) {
        if (!streamingOpen) break;
        setStatus((currentAudio ? "playing" : "loading"));
        await sleep(80);
        continue;
      }
      const raw = queue.shift()!;
      const chunk = cleanForSpeech(raw);
      if (!chunk) continue;
      if (!currentAudio) setStatus("loading");
      let b64 = "";
      try {
        b64 = await api.synthesizeSpeech(chunk, voice);
      } catch (e) {
        // Surfaced in the UI (Read-aloud button row) and logged to the webview
        // console; the backend logs the full request/response to the tauri dev
        // terminal. Between the two you can tell endpoint vs. model vs. voice.
        console.error("[tts] synthesis failed:", e);
        const failedId = sessionMessageId;
        stopEngine();
        store?.set({ error: String(e), errorMessageId: failedId });
        return;
      }
      if (token !== sessionToken) break;
      if (b64) await playBase64(b64, token);
    }
  } finally {
    workerRunning = false;
    if (token === sessionToken && queue.length === 0 && !streamingOpen && !currentAudio) {
      store?.set({ activeMessageId: null, status: "idle" });
    }
  }
}

function stopEngine() {
  sessionToken++;
  queue = [];
  streamingOpen = false;
  paused = false;
  pendingBuffer = "";
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  store?.set({ activeMessageId: null, status: "idle" });
}

function beginSession(messageId: string, v: string | null, open: boolean) {
  stopEngine();
  const token = ++sessionToken;
  queue = [];
  streamingOpen = open;
  paused = false;
  pendingBuffer = "";
  emittedCount = 0;
  voice = v;
  sessionMessageId = messageId;
  store?.set({ activeMessageId: messageId, status: "loading", error: null, errorMessageId: null });
  runWorker(token);
  return token;
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useTts = create<TtsStore>((set, get) => {
  store = { set, get };
  return {
    activeMessageId: null,
    status: "idle",
    error: null,
    errorMessageId: null,
    clearError: () => set({ error: null, errorMessageId: null }),

    async readAloud(messageId, chatId, text, v) {
      // Toggle off if this message is already the active one.
      if (get().activeMessageId === messageId && get().status !== "idle") {
        stopEngine();
        return;
      }
      const token = beginSession(messageId, v, false);
      let toSpeak = text;
      const settings = (await import("@/store/app")).useApp.getState().appSettings;
      if (settings.ttsAutoSummarize && text.length > settings.ttsSummarizeThreshold) {
        try {
          const summary = await api.summarizeForSpeech(chatId, text);
          if (token !== sessionToken) return; // stopped while summarizing
          if (summary) toSpeak = summary;
        } catch {
          /* fall back to full text */
        }
      }
      const [sentences] = drainSentences(toSpeak, true);
      if (token !== sessionToken) return;
      queue.push(...sentences);
      streamingOpen = false;
      runWorker(token);
    },

    startStreaming(messageId, v) {
      beginSession(messageId, v, true);
    },

    feedStreaming(fullTextSoFar) {
      if (!streamingOpen) return;
      // Recompute from the full accumulated text each call — cheap and avoids
      // drift versus tracking deltas across React renders.
      const [sentences, remainder] = drainSentences(fullTextSoFar, false);
      // Only enqueue sentences we haven't queued before: track by consuming from
      // pendingBuffer length. Simplest correct approach: derive newly-complete
      // sentences by diffing against what we've already emitted.
      const alreadyEmitted = emittedCount;
      if (sentences.length > alreadyEmitted) {
        const fresh = sentences.slice(alreadyEmitted);
        queue.push(...fresh);
        emittedCount = sentences.length;
      }
      pendingBuffer = remainder;
    },

    finishStreaming() {
      if (!streamingOpen) return;
      if (pendingBuffer.trim()) queue.push(pendingBuffer.trim());
      pendingBuffer = "";
      emittedCount = 0;
      streamingOpen = false;
    },

    pause() {
      paused = true;
      if (currentAudio) currentAudio.pause();
      set({ status: "paused" });
    },

    resume() {
      paused = false;
      if (currentAudio) {
        currentAudio.play().catch(() => {});
        set({ status: "playing" });
      } else {
        set({ status: "loading" });
      }
    },

    stop() {
      stopEngine();
    },
  };
});
