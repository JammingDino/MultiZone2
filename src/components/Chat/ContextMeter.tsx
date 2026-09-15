import { DollarSign, Gauge, Users } from "lucide-react";
import { useApp } from "@/store/app";
import { CHROME_ACTIVE, CHROME_QUIET, HEADER_ICON } from "@/lib/chrome";
import { formatTokens } from "@/lib/format";
import { useContextUsage } from "@/lib/useContextUsage";

/**
 * The header's context chip: what the next request will carry, and what the
 * session has been billed, in six characters each. Everything behind those
 * numbers is drawn in the workspace panel's Context section (0.17.9), which
 * this opens — the popover of figures it used to carry is that section now.
 */
export function ContextMeter({ chatId }: { chatId: string }) {
  const workspaceOpen = useApp((s) => s.workspaceOpen);
  const focusWorkspace = useApp((s) => s.focusWorkspace);
  const u = useContextUsage(chatId, false);
  if (u.empty) return null;

  return (
    <div className="shrink-0">
      <button
        onClick={() => focusWorkspace("context")}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${workspaceOpen ? CHROME_ACTIVE : CHROME_QUIET}`}
        title={[
          u.sessionTotal != null
            ? "Context: this chat's, then the whole team's (estimated). Opens the breakdown."
            : "Context this chat carries — conversation plus its per-turn baseline (estimated). Opens the breakdown.",
          u.buttonSpend &&
            `Spent: ${formatTokens(u.buttonSpend.totalTokens)} over ${u.buttonSpend.requests} request(s). Every step of a turn re-sends the whole context and is billed for it, so this runs far ahead of the context figure.`,
        ]
          .filter(Boolean)
          .join("\n\n")}
      >
        <Gauge size={HEADER_ICON} />
        <span className="font-mono">{formatTokens(u.chatTotal)}</span>
        <span className="hidden sm:inline">ctx</span>
        {u.sessionTotal != null && (
          <span className="ml-0.5 flex items-center gap-1 border-l border-[var(--color-border)] pl-1.5 text-[var(--color-accent)]">
            <Users size={HEADER_ICON} />
            <span className="font-mono">{formatTokens(u.sessionTotal)}</span>
          </span>
        )}
        {u.buttonSpend && (
          <span className="ml-0.5 flex items-center gap-1 border-l border-[var(--color-border)] pl-1.5">
            <DollarSign size={HEADER_ICON} />
            <span className="font-mono">{formatTokens(u.buttonSpend.totalTokens)}</span>
            {u.limitState && (
              <span
                className={`font-mono ${
                  u.limitState === "over"
                    ? "text-[var(--color-danger)]"
                    : u.limitState === "near"
                      ? "text-amber-400"
                      : "text-[var(--color-text-muted)]"
                }`}
              >
                /{formatTokens(u.spendLimit)}
              </span>
            )}
          </span>
        )}
      </button>
    </div>
  );
}
