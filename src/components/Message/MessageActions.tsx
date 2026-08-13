import { useState } from "react";
import { Copy, Check, RotateCcw, BarChart3, Pencil, GitBranch, Volume2, Pause, Play, Square, TriangleAlert } from "lucide-react";
import type { Checkpoint } from "@/lib/types";
import { useApp } from "@/store/app";
import { useTts, zoneVoice } from "@/store/tts";
import * as api from "@/lib/tauri";
import { formatTokens } from "@/lib/format";
import { estimateTokens } from "@/lib/tokens";
import { ACTION_ICON, CHROME_OUTLINED, CHROME_QUIET } from "@/lib/chrome";

interface Props {
  /** Used for copy. */
  text: string;
  /** Assistant message id for stats lookup. */
  messageId?: string;
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
   * Send this user turn again as-is (1.0). The counterpart to regenerating an
   * answer: when a turn failed on something outside the message — a provider
   * error, a tool that wasn't reachable, a model that wasn't loaded — the fix is
   * to send the same thing again, and until now that meant opening the editor
   * and making a pointless edit to get the resend.
   */
  onResend?: () => void;
  /**
   * Pivot message id for "Branch from here". When set, a branch button is shown
   * that forks the chat at this message into a new chat.
   */
  branchFromMessageId?: string;
  /**
   * Branch this participant's thread alone (1.0). In a chat where several zones
   * answer every turn, "branch from here" means the response you clicked on:
   * the new chat keeps the full history — every zone's answers stay readable —
   * but continues with this responder only. `branchSoloZoneId` names the
   * perspective zone; null on the primary card, which pins the chat's own zone.
   */
  branchSolo?: boolean;
  branchSoloZoneId?: string | null;
  /** When true, show an "edited" marker (message content was hand-edited). */
  edited?: boolean;
}

export function MessageActions({
  text,
  messageId,
  chatId,
  variant,
  regenerateZoneId = null,
  canRegenerate = false,
  onEdit,
  onResend,
  branchFromMessageId,
  branchSolo = false,
  branchSoloZoneId = null,
  edited = false,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [branching, setBranching] = useState(false);
  /** Later turns that changed files, when a branch has to ask about them. */
  const [rewind, setRewind] = useState<Checkpoint[] | null>(null);
  const [rewindNote, setRewindNote] = useState<string | null>(null);
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

  /**
   * Branching forks the conversation at this message. Later turns may also have
   * changed files, and until 0.10.1 the branch said nothing about them — so a
   * branch taken three turns back started with history from then and a working
   * tree from now, which is true of no moment that ever existed. When there is
   * anything to rewind, the choice is put to the user rather than guessed:
   * silently reverting their files would be worse than either option.
   */
  async function onBranch() {
    if (isBusy || branching || !branchFromMessageId) return;
    try {
      const later = await api.checkpointsSinceMessage(chatId, branchFromMessageId);
      if (later.length > 0) {
        setRewind(later);
        return;
      }
    } catch (e) {
      // The count is a courtesy; failing to get it must not block a branch.
      console.error(e);
    }
    void runBranch(false);
  }

  async function runBranch(restoreFiles: boolean) {
    if (!branchFromMessageId) return;
    setRewind(null);
    setBranching(true);
    try {
      const reports = await branchFromMessage(
        chatId,
        branchFromMessageId,
        branchSolo,
        branchSoloZoneId,
        restoreFiles,
      );
      // A file edited outside the app is left exactly as found; the branch
      // still happened, so say which paths didn't come back rather than
      // letting the user assume the tree matches the history.
      const conflicts = reports
        .flatMap((r) => r.files)
        .filter((f) => f.outcome === "conflict");
      setRewindNote(
        conflicts.length > 0
          ? `${conflicts.length} file${conflicts.length === 1 ? " was" : "s were"} edited outside the app and left as found.`
          : null,
      );
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
      // The inset matches the avatar column, so the bar lines up with the rule
      // (or the bubble's edge) rather than with the avatar. `mz-actions-inset`
      // drops it again on a wide thread, where the avatar hangs outside the
      // column and there is no column to skip past — see styles.css.
      className={`mz-actions-inset mt-1 flex items-center gap-1 text-xs text-[var(--color-text-muted)] ${
        variant === "user" ? "justify-end pr-10" : variant === "assistant" ? "pl-10" : ""
      }`}
    >
      <ActionButton onClick={onCopy} label={copied ? "Copied" : "Copy"}>
        {copied ? <Check size={ACTION_ICON} /> : <Copy size={ACTION_ICON} />}
      </ActionButton>

      {variant !== "user" && messageId && (
        <ReadAloudButton
          messageId={messageId}
          chatId={chatId}
          text={text}
          zoneId={regenerateZoneId ?? null}
        />
      )}

      {variant !== "user" && canRegenerate && (
        <ActionButton
          onClick={onRegenerate}
          label="Regenerate"
          disabled={isBusy}
        >
          <RotateCcw size={ACTION_ICON} />
        </ActionButton>
      )}

      {/* Sits where Regenerate sits on an answer, and carries the same icon:
          both mean "run this again". */}
      {onResend && (
        <ActionButton
          onClick={onResend}
          label="Resend"
          disabled={isBusy}
        >
          <RotateCcw size={ACTION_ICON} />
        </ActionButton>
      )}

      {onEdit && (
        <ActionButton onClick={onEdit} label="Edit" disabled={isBusy}>
          <Pencil size={ACTION_ICON} />
        </ActionButton>
      )}

      {branchFromMessageId && (
        <div className="relative">
          <ActionButton
            onClick={onBranch}
            label={branching ? "Branching…" : "Branch"}
            disabled={isBusy || branching}
          >
            <GitBranch size={ACTION_ICON} />
          </ActionButton>
          {rewind && (
            <RewindPrompt
              checkpoints={rewind}
              onChoose={(restoreFiles) => void runBranch(restoreFiles)}
              onCancel={() => setRewind(null)}
            />
          )}
        </div>
      )}

      {rewindNote && (
        <span
          className="max-w-[420px] truncate text-[11px] text-amber-500"
          title={rewindNote}
          onClick={() => setRewindNote(null)}
          role="button"
        >
          {rewindNote}
        </span>
      )}

      {variant !== "user" && stats && (
        <div className="relative">
          <ActionButton
            onClick={() => setShowStats((v) => !v)}
            label="Timing and token count for this answer"
            readout={`${formatDuration(stats.durationMs)} · ${formatTokenTotal(stats)} tok`}
          >
            <BarChart3 size={ACTION_ICON} />
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
                <StatRow
                  label="Thinking tokens (est.)"
                  value={formatTokens(estimateTokens(stats.reasoningChars))}
                />
              )}
              {(stats.toolCallChars ?? 0) > 0 && (
                <StatRow
                  label="Tool call tokens (est.)"
                  value={formatTokens(estimateTokens(stats.toolCallChars ?? 0))}
                />
              )}
              {(stats.reasoningChars > 0 || (stats.toolCallChars ?? 0) > 0) && (
                <StatRow
                  label="Total tokens (est.)"
                  value={formatTokens(
                    estimateTokens(
                      stats.contentChars + stats.reasoningChars + (stats.toolCallChars ?? 0),
                    ),
                  )}
                />
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

/**
 * The choice a branch has to put to the user when later turns changed files
 * (0.10.1): keep the tree as it stands, or rewind it to match the history the
 * branch is about to copy. Neither is the obvious default — the files may be
 * work the user wants to keep — so it is asked rather than assumed, and only
 * when there is actually something to undo.
 */
function RewindPrompt({
  checkpoints,
  onChoose,
  onCancel,
}: {
  checkpoints: Checkpoint[];
  onChoose: (restoreFiles: boolean) => void;
  onCancel: () => void;
}) {
  const paths = new Set(checkpoints.flatMap((c) => c.files.map((f) => f.path)));
  const diverged = checkpoints
    .flatMap((c) => c.files)
    .filter((f) => f.diverged).length;

  return (
    <div className="absolute bottom-full left-0 z-40 mb-1 w-[300px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-2.5 text-xs shadow-lg">
      <p className="text-[var(--color-text)]">
        {checkpoints.length} later turn{checkpoints.length === 1 ? "" : "s"} changed {paths.size} file
        {paths.size === 1 ? "" : "s"}.
      </p>
      <p className="mt-1 text-[var(--color-text-muted)]">
        The branch copies the conversation up to this point. Put those files back to match it?
      </p>
      {diverged > 0 && (
        <p className="mt-1 flex items-start gap-1 text-amber-500">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {diverged} {diverged === 1 ? "has" : "have"} been edited outside the app and will be left as found.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          onClick={() => onChoose(true)}
          className={`rounded px-2 py-1 ${CHROME_OUTLINED}`}
        >
          Branch and rewind files
        </button>
        <button
          onClick={() => onChoose(false)}
          className={`rounded px-2 py-1 ${CHROME_OUTLINED}`}
        >
          Branch only
        </button>
        <button
          onClick={onCancel}
          className="rounded px-2 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * "Read aloud" (0.8.1): speaks this message through the configured TTS
 * provider. Once playing it swaps to pause/resume + stop controls. The voice is
 * the message's zone default (if set) falling back to the global default.
 */
function ReadAloudButton({
  messageId,
  chatId,
  text,
  zoneId,
}: {
  messageId: string;
  chatId: string;
  text: string;
  zoneId: string | null;
}) {
  const ttsConfigured = useApp((s) => !!s.appSettings.ttsProviderId && !!s.appSettings.ttsModel);
  const globalVoice = useApp((s) => s.appSettings.ttsVoice);
  const chatZoneId = useApp((s) => s.chats.find((c) => c.id === chatId)?.zoneId ?? null);
  const zone = useApp((s) => s.zones.find((z) => z.id === (zoneId ?? chatZoneId)));
  const activeMessageId = useTts((s) => s.activeMessageId);
  const status = useTts((s) => s.status);
  const error = useTts((s) => s.error);
  const errorMessageId = useTts((s) => s.errorMessageId);
  const clearError = useTts((s) => s.clearError);
  const readAloud = useTts((s) => s.readAloud);
  const pause = useTts((s) => s.pause);
  const resume = useTts((s) => s.resume);
  const stop = useTts((s) => s.stop);

  if (!ttsConfigured) return null;
  const isActive = activeMessageId === messageId && status !== "idle";
  const voice = zoneVoice(zone?.toolConfig) ?? (globalVoice || null);

  if (!isActive) {
    return (
      <>
        <ActionButton
          onClick={() => readAloud(messageId, chatId, text, voice)}
          label="Read aloud"
        >
          <Volume2 size={ACTION_ICON} />
        </ActionButton>
        {error && errorMessageId === messageId && (
          <span
            className="max-w-[420px] truncate text-[11px] text-red-500"
            title={error}
            onClick={clearError}
            role="button"
          >
            {error}
          </span>
        )}
      </>
    );
  }

  return (
    <>
      {status === "paused" ? (
        <ActionButton onClick={resume} label="Resume">
          <Play size={ACTION_ICON} />
        </ActionButton>
      ) : (
        <ActionButton onClick={pause} label={status === "loading" ? "Loading…" : "Pause"}>
          <Pause size={ACTION_ICON} />
        </ActionButton>
      )}
      <ActionButton onClick={stop} label="Stop">
        <Square size={ACTION_ICON} />
      </ActionButton>
    </>
  );
}

/**
 * One action in the bar under a message.
 *
 * Icon only: the labels turned a hover affordance into a permanent five-word
 * strip under every turn, and these are the same handful of actions on every
 * message — once you know the row, reading "Copy Regenerate Edit Branch" each
 * time is noise. The label stays as the tooltip, and as the button's accessible
 * name. `readout` is for the one action that carries a number rather than a
 * name — the stats button — where the text *is* the information.
 */
function ActionButton({
  onClick,
  label,
  readout,
  children,
  disabled,
}: {
  onClick: () => void;
  label: string;
  readout?: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 rounded px-1.5 py-1 ${CHROME_QUIET} disabled:cursor-not-allowed disabled:opacity-40`}
      title={label}
      aria-label={label}
    >
      {children}
      {readout && <span>{readout}</span>}
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
  toolCallChars?: number;
  toolMs?: number;
}) {
  // tok/s reflects generation throughput, so discount time spent executing
  // tools (the model isn't producing tokens then). Overall duration is shown
  // separately, in full.
  const genMs = stats.durationMs - (stats.toolMs ?? 0);
  if (genMs <= 0) return "—";
  // Speed includes thinking and tool-call tokens — both are tokens the model
  // produced, so both affect throughput.
  const tokens = estimateTokens(
    stats.contentChars + stats.reasoningChars + (stats.toolCallChars ?? 0),
  );
  const tps = (tokens / (genMs / 1000)).toFixed(1);
  return `${tps} tok/s`;
}

function formatTokenTotal(stats: {
  contentChars: number;
  reasoningChars: number;
  toolCallChars?: number;
}) {
  return formatTokens(
    estimateTokens(stats.contentChars + stats.reasoningChars + (stats.toolCallChars ?? 0)),
  );
}
