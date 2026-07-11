import { Ear, Brain, AudioLines } from "lucide-react";
import { useApp } from "@/store/app";
import { useTts } from "@/store/tts";

/**
 * Chat-header state indicator for hands-free conversation mode (0.8.2). Shows
 * which phase of the STT → think → TTS loop the chat is in: listening (mic
 * capturing), thinking (assistant generating), or speaking (response playing).
 * Renders nothing unless conversation mode is active for this chat.
 */
export function ConversationIndicator({ chatId }: { chatId: string }) {
  const active = useApp((s) => s.conversationChatId === chatId);
  const recording = useApp((s) => s.voiceRecording);
  const streaming = useApp(
    (s) =>
      Boolean(s.streamingByChat[chatId]) ||
      Object.keys(s.perspectiveStreamsByChat[chatId] ?? {}).length > 0,
  );
  const ttsStatus = useTts((s) => s.status);

  if (!active) return null;

  let icon = <Ear size={12} className="animate-pulse" />;
  let label = "Listening…";
  if (ttsStatus === "playing" || ttsStatus === "loading" || ttsStatus === "paused") {
    icon = <AudioLines size={12} className="animate-pulse" />;
    label = "Speaking…";
  } else if (streaming) {
    icon = <Brain size={12} className="animate-pulse" />;
    label = "Thinking…";
  } else if (recording) {
    icon = <Ear size={12} className="animate-pulse" />;
    label = "Listening…";
  } else {
    label = "Ready";
  }

  return (
    <span
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2 py-0.5 text-xs text-[var(--color-accent)]"
      title="Hands-free conversation mode"
    >
      {icon}
      <span className="tabular-nums">{label}</span>
    </span>
  );
}
