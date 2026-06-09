import { useState } from "react";
import { Copy, Check, RotateCcw, BarChart3, Pencil, Trash2 } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";

interface Props {
  /** Used for copy. */
  text: string;
  /** Assistant message id for stats lookup. */
  messageId?: string;
  /**
   * Required for regenerate / edit. The id of the first message to delete
   * before re-running the loop. For regenerate on a bot turn, this is the
   * first assistant message in the turn. For editing a user message, this is
   * the user message itself.
   */
  pivotMessageId?: string;
  chatId: string;
  variant: "user" | "assistant" | "perspective";
  onEdit?: () => void;
}

export function MessageActions({
  text,
  messageId,
  pivotMessageId,
  chatId,
  variant,
  onEdit,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const stats = useApp((s) => (messageId ? s.statsByMessage[messageId] : undefined));
  const isStreaming = useApp((s) => Boolean(s.streamingByChat[chatId]));
  const refreshChats = useApp((s) => s.refreshChats);
  const loadMessages = useApp((s) => s.loadMessages);

  async function onCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function onRegenerate() {
    if (!pivotMessageId || isStreaming) return;
    try {
      await api.deleteMessagesFrom(chatId, pivotMessageId);
      await loadMessages(chatId);
      await api.regenerateResponse(chatId);
      refreshChats();
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div
      className={`mt-1 flex items-center gap-1 text-xs text-[var(--color-text-muted)] ${
        variant === "user" ? "justify-end pr-10" : variant === "assistant" ? "pl-10" : ""
      }`}
    >
      <ActionButton onClick={onCopy} label={copied ? "Copied" : "Copy"}>
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </ActionButton>

      {variant === "assistant" && (
        <ActionButton
          onClick={onRegenerate}
          label="Regenerate"
          disabled={!pivotMessageId || isStreaming}
        >
          <RotateCcw size={11} />
        </ActionButton>
      )}

      {variant === "user" && onEdit && (
        <ActionButton onClick={onEdit} label="Edit" disabled={isStreaming}>
          <Pencil size={11} />
        </ActionButton>
      )}

      {variant !== "user" && stats && (
        <div className="relative">
          <ActionButton
            onClick={() => setShowStats((v) => !v)}
            label={`${formatDuration(stats.durationMs)} · ${formatTokenTotal(stats)} tok`}
          >
            <BarChart3 size={11} />
          </ActionButton>
          {showStats && (
            <div className="absolute bottom-full left-0 z-40 mb-1 min-w-[220px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-xs shadow-lg">
              {stats.timeToFirstTokenMs !== null && (
                <StatRow
                  label="Time to first token"
                  value={formatDuration(stats.timeToFirstTokenMs)}
                />
              )}
              <StatRow
                label="Generation time"
                value={formatDuration(stats.durationMs)}
              />
              <StatRow
                label="Output tokens (est.)"
                value={String(estimateTokens(stats.contentChars))}
              />
              {stats.reasoningChars > 0 && (
                <>
                  <StatRow
                    label="Thinking tokens (est.)"
                    value={String(estimateTokens(stats.reasoningChars))}
                  />
                  <StatRow
                    label="Total tokens (est.)"
                    value={String(
                      estimateTokens(stats.contentChars + stats.reasoningChars),
                    )}
                  />
                </>
              )}
              <StatRow label="Speed" value={formatSpeed(stats)} />
              <StatRow label="Chars" value={String(stats.contentChars)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  label,
  children,
  disabled,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
      title={label}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="font-mono text-[var(--color-text)]">{value}</span>
    </div>
  );
}

function estimateTokens(chars: number) {
  return Math.max(1, Math.round(chars / 4));
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function formatSpeed(stats: {
  durationMs: number;
  contentChars: number;
  reasoningChars: number;
}) {
  if (stats.durationMs <= 0) return "—";
  // Speed includes thinking tokens — that's still tokens the model produced.
  const tokens = estimateTokens(stats.contentChars + stats.reasoningChars);
  const tps = (tokens / (stats.durationMs / 1000)).toFixed(1);
  return `${tps} tok/s`;
}

function formatTokenTotal(stats: { contentChars: number; reasoningChars: number }) {
  return String(estimateTokens(stats.contentChars + stats.reasoningChars));
}
