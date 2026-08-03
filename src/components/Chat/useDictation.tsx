import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Loader2, Mic } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { useTts } from "@/store/tts";

/**
 * Shared dictation controller for a text composer (0.8.0). Wires the mic
 * button's toggle/hold gesture to the store's capture session and splices the
 * final transcript into `setText` per the user's sttInsertionMode. Both the
 * in-chat InputBar and the new-chat HomeScreen composer use this so dictation
 * behaves identically wherever a message is typed.
 *
 * Transcription runs when recording stops (there are no live partials): the
 * recording is uploaded to the configured provider and the returned transcript
 * is committed in one shot.
 *
 * `cancelKey` cancels any in-progress recording when it changes — InputBar
 * passes the chat id so switching chats stops a recording left running — while
 * omitting it (HomeScreen) cancels only on unmount.
 *
 * `taRef` is any text field, not only a textarea: the ask_user card (0.9.13)
 * dictates into a single-line `<input>`, and only `selectionStart`/`value` are
 * read from it.
 */
export function useDictation({
  taRef,
  setText,
  cancelKey,
  onCommit,
}: {
  taRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  setText: Dispatch<SetStateAction<string>>;
  cancelKey?: string;
  /** Fired with the final transcript once a recording is transcribed. Used by
   *  conversation mode (0.8.2) to auto-send the utterance. */
  onCommit?: (finalText: string) => void;
}) {
  const sttActivationMode = useApp((s) => s.appSettings.sttActivationMode);
  const sttInsertionMode = useApp((s) => s.appSettings.sttInsertionMode);
  const voiceRecording = useApp((s) => s.voiceRecording);
  const startDictation = useApp((s) => s.startDictation);
  const stopDictationAction = useApp((s) => s.stopDictation);
  const cancelDictationAction = useApp((s) => s.cancelDictation);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Where the transcript is spliced in — captured at record start so later
  // typing/selection changes don't move the insertion point.
  const dictationCursorRef = useRef<number | null>(null);

  function commitTranscript(finalText: string) {
    if (!finalText) return;
    const pos = dictationCursorRef.current;
    if (sttInsertionMode === "replace" || pos == null) {
      setText(finalText);
    } else {
      setText((prev) => prev.slice(0, pos) + finalText + prev.slice(pos));
    }
  }

  async function beginDictation() {
    // Barge-in (0.8.2): starting to speak stops any in-progress spoken response
    // so the user isn't talking over the assistant.
    useTts.getState().stop();
    const el = taRef.current;
    dictationCursorRef.current = el?.selectionStart ?? el?.value.length ?? 0;
    setVoiceError(null);
    try {
      await startDictation();
    } catch (e) {
      setVoiceError(String(e));
    }
  }

  async function endDictation() {
    setTranscribing(true);
    try {
      const finalText = await stopDictationAction();
      commitTranscript(finalText);
      if (finalText && onCommit) onCommit(finalText);
    } catch (e) {
      setVoiceError(String(e));
    } finally {
      setTranscribing(false);
    }
  }

  function handleMicClick() {
    if (sttActivationMode === "hold") return; // driven by mouse/touch down+up instead
    if (voiceRecording) endDictation();
    else beginDictation();
  }

  function handleMicPressStart() {
    if (sttActivationMode !== "hold" || voiceRecording) return;
    beginDictation();
  }

  function handleMicPressEnd() {
    if (sttActivationMode !== "hold" || !voiceRecording) return;
    endDictation();
  }

  // Push-to-talk safety net: a mouseup after the pointer left the button still
  // stops the recording rather than leaving it stuck on.
  useEffect(() => {
    if (sttActivationMode !== "hold" || !voiceRecording) return;
    const onUp = () => endDictation();
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sttActivationMode, voiceRecording]);

  // Cancel an in-progress recording if the composer unmounts or cancelKey
  // changes — read via a ref so cleanup sees the latest recording state.
  const voiceRecordingRef = useRef(voiceRecording);
  useEffect(() => { voiceRecordingRef.current = voiceRecording; }, [voiceRecording]);
  useEffect(() => {
    return () => {
      if (voiceRecordingRef.current) cancelDictationAction().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelKey]);

  return {
    voiceRecording,
    transcribing,
    voiceError,
    dismissVoiceError: () => setVoiceError(null),
    sttActivationMode,
    handleMicClick,
    handleMicPressStart,
    handleMicPressEnd,
    // Programmatic controls for conversation mode (0.8.2).
    startListening: beginDictation,
    stopListening: endDictation,
    cancelListening: () => {
      if (voiceRecording) cancelDictationAction().catch(() => {});
    },
  };
}

export type DictationController = ReturnType<typeof useDictation>;

/** Bars in the level meter, and how often a new one is sampled. ~14Hz is fast
 *  enough to look like a waveform and slow enough that the poll is free. */
const METER_BARS = 32;
const METER_INTERVAL_MS = 70;

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The "something is happening" strip for dictation (0.9.12), shown above the
 * composer while the mic is live and while the recording is being transcribed.
 *
 * Transcription only runs once the user stops speaking — the provider is sent
 * one WAV at the end, so there are no live partials to show and no way to make
 * words appear as they are said. What the user actually needs in the meantime is
 * proof the microphone is working, so this scrolls a real level meter: each bar
 * is one peak sample polled from the live capture session, newest on the right.
 * A dead or muted device reads as a flat line, which is itself the answer.
 *
 * It polls inside this component rather than in `useDictation` so a 14Hz sample
 * re-renders thirty-two divs and not the whole composer.
 */
export function DictationMeter({ dictation }: { dictation: DictationController }) {
  const { voiceRecording, transcribing } = dictation;
  const sessionId = useApp((s) => s.voiceSessionId);
  const [levels, setLevels] = useState<number[]>([]);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!voiceRecording || !sessionId) return;
    setLevels([]);
    const startedAt = Date.now();
    let cancelled = false;
    const id = setInterval(async () => {
      let level = 0;
      try {
        level = await api.dictationLevel(sessionId);
      } catch {
        // The session ended between the poll and the read — the effect's
        // cleanup is about to run anyway.
      }
      if (cancelled) return;
      setLevels((prev) => [...prev, level].slice(-METER_BARS));
      setElapsed(Date.now() - startedAt);
    }, METER_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [voiceRecording, sessionId]);

  if (!voiceRecording && !transcribing) return null;

  return (
    <div
      className={`mb-2 flex w-fit max-w-full items-center gap-2.5 rounded-full border px-3 py-1 text-xs ${
        voiceRecording
          ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
          : "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
      }`}
    >
      {voiceRecording ? (
        <>
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="flex h-4 shrink-0 items-end gap-[2px]" aria-hidden>
            {Array.from({ length: METER_BARS }, (_, i) => {
              // Right-aligned: the newest sample is the last bar, and an empty
              // meter fills in from the right as the first samples arrive.
              const level = levels[i - (METER_BARS - levels.length)] ?? 0;
              // Speech sits low in a linear scale — the square root spreads a
              // quiet voice across the meter instead of pinning it to the floor.
              const height = Math.min(1, Math.sqrt(level) * 1.6);
              return (
                <span
                  key={i}
                  className="w-[2px] shrink-0 rounded-full bg-current transition-[height] duration-75"
                  style={{ height: `${2 + height * 14}px`, opacity: 0.45 + height * 0.55 }}
                />
              );
            })}
          </span>
          <span className="shrink-0 tabular-nums">Listening… {formatElapsed(elapsed)}</span>
        </>
      ) : (
        <>
          <Loader2 size={12} className="shrink-0 animate-spin" />
          <span className="shrink-0">Transcribing…</span>
        </>
      )}
    </div>
  );
}

/** The mic button, driven by a `useDictation` controller. */
export function MicButton({
  dictation,
  disabled,
  size = 16,
}: {
  dictation: DictationController;
  disabled?: boolean;
  size?: number;
}) {
  const {
    voiceRecording,
    transcribing,
    sttActivationMode,
    handleMicClick,
    handleMicPressStart,
    handleMicPressEnd,
  } = dictation;
  return (
    <button
      onClick={handleMicClick}
      onMouseDown={handleMicPressStart}
      onMouseUp={handleMicPressEnd}
      onMouseLeave={handleMicPressEnd}
      onTouchStart={handleMicPressStart}
      onTouchEnd={handleMicPressEnd}
      disabled={disabled || transcribing}
      title={
        transcribing
          ? "Transcribing…"
          : voiceRecording
            ? "Stop dictation"
            : sttActivationMode === "hold"
              ? "Hold to dictate"
              : "Start dictation"
      }
      className={`rounded p-1.5 hover:bg-[var(--color-panel-hover)] disabled:opacity-40 ${
        voiceRecording ? "text-red-500" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {transcribing ? (
        <Loader2 size={size} className="animate-spin" />
      ) : (
        <Mic size={size} className={voiceRecording ? "animate-pulse" : ""} />
      )}
    </button>
  );
}
