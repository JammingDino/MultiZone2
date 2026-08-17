import { useState } from "react";
import { CircleSlash, Settings as SettingsIcon } from "lucide-react";
import { useApp } from "@/store/app";
import { formatTokens } from "@/lib/format";
import { PRIMARY_ACTION } from "@/lib/chrome";

/**
 * The session spend limit stopped this run (0.14.3).
 *
 * Deliberately not an error card and not dismissable. Every other notice in the
 * thread reports something that happened; this one is a **question**, and until
 * it is answered nothing else will run in this session — not this chat, not a
 * sub-agent, not another chat in the same tree.
 *
 * The limit is a number the user set to mean "do not spend more than this". So
 * the app does not carry on quietly with tools switched off, and it does not
 * spend one more paid request writing an apology. It stops, says how far over
 * it went, and offers the only three answers there are: a bigger number, no
 * number, or nothing.
 */
export function SpendLimitNotice({ chatId }: { chatId: string }) {
  const limit = useApp((s) => s.spendLimitByChat[chatId]);
  const raiseSpendLimit = useApp((s) => s.raiseSpendLimit);
  const openSettings = useApp((s) => s.openSettings);
  const [busy, setBusy] = useState(false);

  if (!limit) return null;

  const { spent, cap, midTurn } = limit;
  const over = spent - cap;

  // Offers, not a text box. Both are computed from what has actually been
  // spent rather than from the old limit: a session already 26% past a 100k
  // ceiling is not helped by being offered 110k, and being asked to do the
  // arithmetic while a run sits stopped is how a limit becomes something people
  // switch off permanently.
  const nextUp = roundUp(spent * 1.5);
  const nextUpFar = roundUp(spent * 3);

  async function choose(newCap: number) {
    setBusy(true);
    try {
      await raiseSpendLimit(chatId, newCap);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 p-3">
      <div className="flex items-start gap-2.5">
        <CircleSlash size={16} className="mt-px shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--color-danger)]">
            Session spend limit reached
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            This session has been billed <strong>{formatTokens(spent)}</strong> tokens against a
            limit of <strong>{formatTokens(cap)}</strong>
            {over > 0 && <> — {formatTokens(over)} over</>}.{" "}
            {midTurn
              ? "The run stopped part-way through; what it finished is above."
              : "Nothing ran for this message."}{" "}
            Nothing further will run in this session — including sub-agents — until you decide.
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            This is spend, not context: every request the session has been billed for, added up. A
            long turn re-sends its whole context on each step, so it runs far ahead of the context
            figure in the header.
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            Whatever you choose applies to <strong>this chat and its sub-agents only</strong> — every
            other chat keeps the default from Settings → Chat.
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => choose(nextUp)}
              disabled={busy}
              className={`rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION} disabled:opacity-50`}
            >
              Raise to {formatTokens(nextUp)} and continue
            </button>
            <button
              onClick={() => choose(nextUpFar)}
              disabled={busy}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
            >
              {formatTokens(nextUpFar)}
            </button>
            <button
              onClick={() => choose(0)}
              disabled={busy}
              title="Removes the limit entirely — this session and every future one run unmetered"
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
            >
              No limit
            </button>
            <button
              onClick={openSettings}
              className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <SettingsIcon size={12} />
              Set my own
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
            Leaving it alone is also an answer: the run stays stopped and nothing more is spent.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Round to something a person would have typed: 2 significant figures. */
function roundUp(n: number): number {
  if (n <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.ceil(n / mag) * mag;
}
