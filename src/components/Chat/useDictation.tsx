import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Loader2, Mic } from "lucide-react";
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
 */
export function useDictation({
  taRef,
  setText,
  cancelKey,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>;
  setText: Dispatch<SetStateAction<string>>;
  cancelKey?: string;
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
  };
}

export type DictationController = ReturnType<typeof useDictation>;

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
