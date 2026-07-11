import { create } from "zustand";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";

/**
 * Text-to-speech playback (0.8.1). A single-active-session player that
 * synthesizes text through the configured provider and plays the returned audio
 * clips back to back.
 *
 * Synthesis is pipelined ahead of playback: while a clip is playing, the next
 * few sentences are synthesized in parallel (up to a configurable batch), so
 * playback of clip N+1 can begin the instant clip N finishes rather than
 * waiting for a fresh round-trip. Clips are always *played* in order, even
 * though their synthesis may finish out of order.
 *
 * Two entry points feed the same queue:
 *  - `readAloud` — one-shot "Read aloud" of a finished message (optionally
 *    LLM-summarized first), split into sentences.
 *  - `startStreaming` / `feedStreaming` / `finishStreaming` — auto-speak, where
 *    sentences are queued as they arrive so speech starts before the full
 *    answer completes.
 *
 * Audio element + buffers live in module scope (not the store) so token
 * streaming doesn't churn React; the store holds only the reactive status.
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

/** A/A/A prefetch/concurrency default when the setting isn't available. */
const DEFAULT_PREFETCH = 3;

/** A synthesized clip, ready to play. */
type Clip = { audio: string; mime: string };

/** `zoneVoice` — a zone's per-zone default voice (0.8.1), stored under
 *  `tts_voice` in its tool_config JSON. Returns null when unset. */
export function zoneVoice(toolConfig: string | null | undefined): string | null {
  if (!toolConfig) return null;
  try {
    const v = (JSON.parse(toolConfig) as Record<string, unknown>).tts_voice;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

// ── Module-scoped pipelined playback engine ──────────────────────────────────

/** Bumped on every new session / stop; in-flight async work checks it to bail. */
let sessionToken = 0;
/** All text chunks appended so far (append-only within a session). */
let chunksList: string[] = [];
/** Next chunk index to hand to synthesis. */
let nextSynthIndex = 0;
/** Next clip index to play (playback is strictly in order). */
let nextPlayIndex = 0;
/** Synthesized-but-not-yet-played clips, keyed by chunk index. */
const results = new Map<number, Clip>();
/** Count of synthesis requests currently in flight. */
let inFlight = 0;
/** True while more chunks may still be fed (streaming not yet finished). */
let streamingOpen = false;
let consumerRunning = false;
let paused = false;
let currentAudio: HTMLAudioElement | null = null;
let voice: string | null = null;
let batchSize = DEFAULT_PREFETCH;
/** The message id of the active session, for attributing errors in the UI. */
let sessionMessageId: string | null = null;
/** Buffer of not-yet-sentence-complete streamed text. */
let pendingBuffer = "";
/** Count of sentences already appended for the active streaming session. */
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

/**
 * Kick off as many synthesis requests as the batch allows. Requests run in
 * parallel (`inFlight` capped at `batchSize`) and never get more than
 * `batchSize` chunks ahead of playback, so memory stays bounded. Results land
 * in `results` keyed by index; the consumer plays them in order.
 */
function pump(token: number) {
  while (
    token === sessionToken &&
    inFlight < batchSize &&
    nextSynthIndex < chunksList.length &&
    nextSynthIndex < nextPlayIndex + batchSize
  ) {
    const idx = nextSynthIndex++;
    const chunk = cleanForSpeech(chunksList[idx]);
    if (!chunk) {
      // Nothing speakable — store an empty clip so the consumer skips it.
      results.set(idx, { audio: "", mime: "" });
      continue;
    }
    inFlight++;
    api
      .synthesizeSpeech(chunk, voice)
      .then((res) => {
        if (token !== sessionToken) return;
        results.set(idx, res);
      })
      .catch((e) => {
        if (token !== sessionToken) return;
        console.error("[tts] synthesis failed:", e);
        const failedId = sessionMessageId;
        stopEngine();
        store?.set({ error: String(e), errorMessageId: failedId });
      })
      .finally(() => {
        inFlight--;
        pump(token);
      });
  }
}

function playClip(clip: Clip, token: number): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(`data:${clip.mime || "audio/mpeg"};base64,${clip.audio}`);
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
      setStatus("paused");
    }
  });
}

/** The single ordered playback loop for a session. */
async function runConsumer(token: number) {
  if (consumerRunning) return;
  consumerRunning = true;
  try {
    while (token === sessionToken) {
      while (paused && token === sessionToken) await sleep(120);
      if (token !== sessionToken) break;

      const clip = results.get(nextPlayIndex);
      if (clip) {
        results.delete(nextPlayIndex);
        nextPlayIndex++;
        pump(token); // window advanced — prefetch further ahead
        if (clip.audio) await playClip(clip, token);
        continue;
      }

      // Nothing ready to play at the front of the queue.
      const allChunksKnown = !streamingOpen;
      if (allChunksKnown && nextPlayIndex >= chunksList.length) break; // done
      // Otherwise we're waiting on synthesis (or more streamed text).
      setStatus(currentAudio ? "playing" : "loading");
      pump(token);
      await sleep(60);
    }
  } finally {
    consumerRunning = false;
    if (token === sessionToken && nextPlayIndex >= chunksList.length && !streamingOpen && !currentAudio) {
      store?.set({ activeMessageId: null, status: "idle" });
    }
  }
}

function resetBuffers() {
  chunksList = [];
  nextSynthIndex = 0;
  nextPlayIndex = 0;
  results.clear();
  inFlight = 0;
  pendingBuffer = "";
  emittedCount = 0;
}

function stopEngine() {
  sessionToken++;
  streamingOpen = false;
  paused = false;
  resetBuffers();
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  store?.set({ activeMessageId: null, status: "idle" });
}

function currentPrefetch(): number {
  const n = useApp.getState().appSettings.ttsPrefetch;
  return typeof n === "number" && n >= 1 ? Math.min(n, 8) : DEFAULT_PREFETCH;
}

function beginSession(messageId: string, v: string | null, open: boolean) {
  stopEngine();
  const token = ++sessionToken;
  streamingOpen = open;
  paused = false;
  resetBuffers();
  voice = v;
  batchSize = DEFAULT_PREFETCH;
  sessionMessageId = messageId;
  store?.set({ activeMessageId: messageId, status: "loading", error: null, errorMessageId: null });
  runConsumer(token);
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
      const settings = useApp.getState().appSettings;
      const token = beginSession(messageId, v, false);
      batchSize = currentPrefetch();
      let toSpeak = text;
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
      chunksList.push(...sentences);
      streamingOpen = false;
      pump(token);
    },

    startStreaming(messageId, v) {
      const token = beginSession(messageId, v, true);
      batchSize = currentPrefetch();
      void token;
    },

    feedStreaming(fullTextSoFar) {
      if (!streamingOpen) return;
      const [sentences, remainder] = drainSentences(fullTextSoFar, false);
      if (sentences.length > emittedCount) {
        const fresh = sentences.slice(emittedCount);
        chunksList.push(...fresh);
        emittedCount = sentences.length;
        pump(sessionToken);
      }
      pendingBuffer = remainder;
    },

    finishStreaming() {
      if (!streamingOpen) return;
      if (pendingBuffer.trim()) chunksList.push(pendingBuffer.trim());
      pendingBuffer = "";
      emittedCount = 0;
      streamingOpen = false;
      pump(sessionToken);
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
