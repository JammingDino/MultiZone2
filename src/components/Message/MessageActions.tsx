import { useState } from "react";
import { Copy, Check, RotateCcw, BarChart3, Pencil, GitBranch } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { formatTokens } from "@/lib/format";

interface Props {
  /** Used for copy. */
  text: string;
  /** Assistant message id for stats lookup. */
  messageId?: string;
  /**
   * Editing a user message: the id of the user message to delete from before
   * resending. Only used for `variant === "user"`.
   */
  pivotMessageId?: string;
  chatId: string;
  variant: "user" | "assistant" | "perspective";
  /**
   * Regenerate target for assistant/perspective turns: `null` = the primary
   * turn, a zone id = that perspective zone. Only that participant is re-run.
   */
  regenerateZoneId?: string | null;
  /** Whether this turn is the latest round (regenerate is only offered there). */
  canRegenerate?: boolean;
  onEdit?: () => void;
  /**
   * Pivot message id for "Branch from here". When set, a branch button is shown
   * that forks the chat at this message into a new chat.
   */
  branchFromMessageId?: string;
  /** When true, show an "edited" marker (message content was hand-edited). */
  edited?: boolean;
}

export function MessageActions({
  text,
  messageId,
  pivotMessageId,
  chatId,
  variant,
  regenerateZoneId = null,
  canRegenerate = false,
  onEdit,
  branchFromMessageId,
  edited = false,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [branching, setBranching] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const stats = useApp((s) => (messageId ? s.statsByMessage[messageId] : undefined));
  // Busy if any participant (primary or a perspective) is streaming in this
  // chat — regenerate is disabled until the whole turn settles.
  const primaryStreaming = useApp((s) => Boolean(s.streamingByChat[chatId]));
  const perspStreaming = useApp(
    (s) => Object.keys(s.perspectiveStreamsByChat[chatId] ?? {}).length > 0,
  );
  const isBusy = primaryStreaming || perspStreaming;
  const refreshChats = useApp((s) => s.refreshChats);
  const loadMessages = useApp((s) => s.loadMessages);
  const branchFromMessage = useApp((s) => s.branchFromMessage);

  async function onCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function onBranch() {
    if (isBusy || branching || !branchFromMessageId) return;
    setBranching(true);
    try {
      await branchFromMessage(chatId, branchFromMessageId);
    } catch (e) {
      console.error(e);
    } finally {
      setBranching(false);
    }
  }

  async function onRegenerate() {
    if (isBusy || !canRegenerate) return;
    try {
      // Drop just this participant's latest-round messages, then re-run only it.
      await api.deleteParticipantMessages(chatId, regenerateZoneId);
      await loadMessages(chatId);
      await api.regenerateParticipant(chatId, regenerateZoneId);
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

      {variant !== "user" && canRegenerate && (
        <ActionButton
          onClick={onRegenerate}
          label="Regenerate"
          disabled={isBusy}
        >
          <RotateCcw size={11} />
        </ActionButton>
      )}

      {onEdit && (
        <ActionButton onClick={onEdit} label="Edit" disabled={isBusy}>
          <Pencil size={11} />
        </ActionButton>
      )}

      {branchFromMessageId && (
        <ActionButton
          onClick={onBranch}
          label={branching ? "Branching…" : "Branch"}
          disabled={isBusy || branching}
        >
          <GitBranch size={11} />
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
                value={formatTokens(estimateTokens(stats.contentChars))}
              />
              {stats.reasoningChars > 0 && (
                <>
                  <StatRow
                    label="Thinking tokens (est.)"
                    value={formatTokens(estimateTokens(stats.reasoningChars))}
                  />
                  <StatRow
                    label="Total tokens (est.)"
                    value={formatTokens(
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

      {edited && (
        <span className="px-1 italic text-[var(--color-text-muted)]/80" title="This message was edited">
          edited
        </span>
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
  toolMs?: number;
}) {
  // tok/s reflects generation throughput, so discount time spent executing
  // tools (the model isn't producing tokens then). Overall duration is shown
  // separately, in full.
  const genMs = stats.durationMs - (stats.toolMs ?? 0);
  if (genMs <= 0) return "—";
  // Speed includes thinking tokens — that's still tokens the model produced.
  const tokens = estimateTokens(stats.contentChars + stats.reasoningChars);
  const tps = (tokens / (genMs / 1000)).toFixed(1);
  return `${tps} tok/s`;
}

function formatTokenTotal(stats: { contentChars: number; reasoningChars: number }) {
  return formatTokens(estimateTokens(stats.contentChars + stats.reasoningChars));
}
