/**
 * Everything waiting on a human, wherever you are (0.17.2).
 *
 * The desktop shows an approval inside the chat that raised it, which works
 * because you are looking at that chat. From a phone you are not: a sub-agent
 * three chats over asks to run something, and the run stalls for five minutes
 * at a prompt nobody can see, then denies itself. That reads like a bug and is
 * really an absence — there was no way to find out something was waiting.
 *
 * So: one bar, above everything, listing the queue with a countdown. Answering
 * goes through the same route the desktop's own dialog uses.
 *
 * The countdown is the part that must not be dropped. "Denied because nobody
 * answered in time" is a real outcome, and without a visible clock it is
 * indistinguishable from the model having decided not to.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, ShieldQuestion, X } from "lucide-react";
import * as api from "@/lib/tauri";
import type { PendingApproval } from "@/lib/types";

/** How often the queue is re-read when something is waiting.
 *
 *  Polled rather than driven purely by events because an approval that expires
 *  emits nothing — the engine simply stops waiting — and a row that sits at
 *  "0s left" forever is worse than no row. Only runs while the queue is
 *  non-empty or a turn is live, so an idle phone is not asking every second. */
const POLL_MS = 2000;

export function ApprovalQueue() {
  const [queue, setQueue] = useState<PendingApproval[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setQueue(await api.pendingApprovals());
    } catch {
      // A desktop that cannot be reached is the connection banner's story to
      // tell, not this component's.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // The stream is what makes the first appearance immediate rather than up to
  // two seconds late — the poll is the backstop for expiry, not the mechanism.
  useEffect(() => {
    const un = api.onStream((env) => {
      if (env.event?.type === "tool_approval_required") void refresh();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  if (queue.length === 0) return null;

  async function answer(item: PendingApproval, approved: boolean) {
    setAnswering(item.key);
    // Dropped from the list immediately: the answer is final and a row that
    // lingers invites a second tap on a decision already made.
    setQueue((q) => q.filter((i) => i.key !== item.key));
    try {
      await api.respondToolApproval(item.chatId, item.zoneId, approved);
    } catch {
      await refresh();
    } finally {
      setAnswering(null);
    }
  }

  const first = queue[0];

  return (
    <div className="border-b border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <ShieldQuestion size={16} className="shrink-0 text-[var(--color-accent)]" />
        <div className="min-w-0 flex-1 text-sm">
          {queue.length === 1 ? (
            <>
              <span className="font-mono">{first.tool}</span> is waiting for you
            </>
          ) : (
            <>{queue.length} tool calls are waiting for you</>
          )}
          <span className="ml-1.5 text-xs text-[var(--color-text-muted)]">
            {formatRemaining(first.expiresInSecs)}
          </span>
        </div>
        {queue.length > 1 ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 rounded border border-[var(--color-border)] p-1.5"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : (
          <Answer item={first} busy={answering === first.key} onAnswer={answer} />
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-1 px-3.5 pb-3">
          {queue.map((item) => (
            <div
              key={item.key}
              className="flex items-center gap-2.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs">{item.tool}</div>
                <div className="truncate text-[11px] text-[var(--color-text-muted)]">
                  {summarize(item)} · {formatRemaining(item.expiresInSecs)}
                </div>
              </div>
              <Answer item={item} busy={answering === item.key} onAnswer={answer} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Answer({
  item,
  busy,
  onAnswer,
}: {
  item: PendingApproval;
  busy: boolean;
  onAnswer: (item: PendingApproval, approved: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1.5">
      <button
        onClick={() => onAnswer(item, false)}
        disabled={busy}
        // Deny is first and plain; approve is the coloured one but not the
        // bigger one. The dangerous tap should not be the easy tap.
        className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2 disabled:opacity-50"
        aria-label={`Deny ${item.tool}`}
      >
        <X size={14} />
      </button>
      <button
        onClick={() => onAnswer(item, true)}
        disabled={busy}
        className="rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/15 p-2 text-[var(--color-accent)] disabled:opacity-50"
        aria-label={`Approve ${item.tool}`}
      >
        <Check size={14} />
      </button>
    </div>
  );
}

/** One line about what the call would do — the file it touches, or the command
 *  it would run. Best-effort: the arguments are the model's JSON and a preview
 *  that cannot be built must not stop the call being answerable. */
function summarize(item: PendingApproval): string {
  if (item.diff?.path) return item.diff.path;
  try {
    const args = JSON.parse(item.arguments);
    const first = args?.command ?? args?.path ?? args?.url ?? args?.query;
    if (typeof first === "string") return first.slice(0, 80);
  } catch {}
  return "no preview";
}

function formatRemaining(secs: number): string {
  if (secs <= 0) return "expiring";
  if (secs < 60) return `${secs}s left`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s left`;
}
