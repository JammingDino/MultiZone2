import { useApp } from "@/store/app";
import { CHROME_ACTIVE, CHROME_QUIET } from "@/lib/chrome";
import { formatTokens } from "@/lib/format";
import { useContextUsage } from "@/lib/useContextUsage";

/**
 * The header's context gauge (0.17.9): a ring filled to how much of the
 * model's window the next request would take, and the two numbers beside it.
 *
 * It was a row of figures — context, team context, spend, limit — each a
 * different kind of number, sharing one button. The one thing worth reading
 * at a glance is *how close to the edge is this conversation*, and that is a
 * proportion, which a ring shows before the eye has found the digits. The
 * rest is drawn properly in the workspace panel's Context section, which this
 * opens. Without a known window the ring is a dashed outline and only the
 * load is shown; the panel says why.
 */
export function ContextMeter({ chatId }: { chatId: string }) {
  const workspaceOpen = useApp((s) => s.workspaceOpen);
  const focusWorkspace = useApp((s) => s.focusWorkspace);
  const u = useContextUsage(chatId, false);
  if (u.empty) return null;

  const window = u.contextWindow?.tokens ?? null;
  const fraction = window ? Math.min(1, u.chatTotal / window) : null;
  const tone =
    fraction === null
      ? "var(--color-text-muted)"
      : fraction >= 0.95
        ? "var(--color-danger)"
        : fraction >= 0.8
          ? "#f59e0b"
          : "var(--color-accent)";

  return (
    <div className="shrink-0">
      <button
        onClick={() => focusWorkspace("context")}
        className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs ${workspaceOpen ? CHROME_ACTIVE : CHROME_QUIET}`}
        title={[
          window
            ? `Context: ${formatTokens(u.chatTotal)} of the model's ${formatTokens(window)} window (${Math.round((fraction ?? 0) * 100)}%, estimated). Opens the breakdown.`
            : `Context: ${formatTokens(u.chatTotal)} — this model's window is not known. Opens the breakdown.`,
          u.buttonSpend &&
            `Spent: ${formatTokens(u.buttonSpend.totalTokens)} over ${u.buttonSpend.requests} request(s).`,
        ]
          .filter(Boolean)
          .join("\n")}
      >
        <Ring fraction={fraction} color={tone} />
        <span className="font-mono tabular-nums">
          <span style={fraction !== null && fraction >= 0.8 ? { color: tone } : undefined}>{formatTokens(u.chatTotal)}</span>
          {window && <span className="text-[var(--color-text-muted)]"> / {formatTokens(window)}</span>}
        </span>
      </button>
    </div>
  );
}

/** A 16px ring. `fraction` null draws a dashed track: the ceiling is unknown. */
function Ring({ fraction, color }: { fraction: number | null; color: string }) {
  const size = 16;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth={stroke}
        strokeDasharray={fraction === null ? "2 2" : undefined}
      />
      {fraction !== null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${Math.max(0.01, fraction) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray 300ms ease" }}
        />
      )}
    </svg>
  );
}
