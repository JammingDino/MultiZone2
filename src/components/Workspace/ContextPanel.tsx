import { useApp } from "@/store/app";
import { formatTokens } from "@/lib/format";
import { hitRate, useContextUsage } from "@/lib/useContextUsage";

/**
 * The context readout as bars (0.17.9).
 *
 * The header meter's popover was a column of twenty numbers; the question it
 * answers — *what is the next request made of, and how much of the budget is
 * gone* — is a question of proportion, which a number column makes the reader
 * compute. So: one stacked bar for what the next request carries, one for what
 * has been spent, the limit as the one bar with an end, and the team as bars
 * on a common scale. The numbers are still here, as labels, for anyone who
 * wants them exact.
 *
 * Colour is by entity, in fixed order, and never carries the only meaning: every
 * segment is named in the legend with its value.
 */
export function ContextPanel({ chatId }: { chatId: string }) {
  const u = useContextUsage(chatId, true);
  const setActiveChat = useApp((s) => s.setActiveChat);

  if (u.empty) {
    return <p className="text-[11px] text-[var(--color-text-muted)]">Nothing sent yet.</p>;
  }

  const systemTokens = u.current?.systemTokens ?? Math.max(0, u.baseline - (u.current?.toolsTokens ?? 0));
  const toolsTokens = u.current?.toolsTokens ?? 0;
  const composition = [
    { key: "system", label: "System prompt", value: systemTokens, color: "var(--viz-1)" },
    { key: "tools", label: `Tool schemas${u.current ? ` (${u.current.toolCount})` : ""}`, value: toolsTokens, color: "var(--viz-2)" },
    { key: "input", label: "Input (you, files, tools)", value: u.est.inputTokens, color: "var(--viz-3)" },
    { key: "output", label: "Output (answers, thinking)", value: u.est.outputTokens, color: "var(--viz-4)" },
  ];

  return (
    <div className="flex flex-col gap-3 text-xs">
      {/* ── Next request ──────────────────────────────────────────────── */}
      <div>
        <Heading
          title="Next request"
          right={<span className="font-mono text-[var(--color-text)]">{formatTokens(u.chatTotal)}</span>}
          sub="estimated"
        />
        <StackedBar segments={composition} total={u.chatTotal} />
        <Legend items={composition} total={u.chatTotal} />
        {u.current && u.current.overheadParts.length > 1 && (
          <div className="mt-1.5 flex flex-col gap-0.5 pl-3">
            {u.current.overheadParts.map((p) => (
              <MiniBar
                key={p.label}
                label={p.label}
                value={p.tokens}
                max={systemTokens}
                color="var(--viz-1)"
              />
            ))}
          </div>
        )}
        {u.est.compacted && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
            {u.est.compacted.messages} earlier message{u.est.compacted.messages === 1 ? "" : "s"} condensed into a{" "}
            {formatTokens(u.est.compacted.summaryTokens)} summary
            {u.est.compacted.savedTokens >= 0
              ? `, saving ${formatTokens(u.est.compacted.savedTokens)}`
              : `, costing ${formatTokens(-u.est.compacted.savedTokens)}`}{" "}
            of {formatTokens(u.est.compacted.wasTokens)}.
          </p>
        )}
        {u.measuredLast > 0 && (
          <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            Last request measured by the provider: <span className="font-mono">{formatTokens(u.measuredLast)}</span>
          </p>
        )}
      </div>

      {/* ── Spent ─────────────────────────────────────────────────────── */}
      {u.hasSpend && u.chatSpent && (
        <div>
          <Heading
            title={`Spent${u.spendIsMeasured ? "" : " (part est.)"}`}
            right={<span className="font-mono text-[var(--color-text)]">{formatTokens(u.chatSpent.totalTokens)}</span>}
            sub={`${u.chatSpent.requests} request${u.chatSpent.requests === 1 ? "" : "s"}`}
          />
          <div className="flex flex-col gap-1">
            <MiniBar
              label={`Input${u.chatSpent.cachedInputTokens > 0 ? ` · ${formatTokens(u.chatSpent.cachedInputTokens)} cached${hitRate(u.chatSpent)}` : ""}`}
              value={u.chatSpent.inputTokens}
              max={u.chatSpent.totalTokens}
              color="var(--viz-3)"
              fillLabel={
                u.chatSpent.cachedInputTokens > 0
                  ? { fraction: u.chatSpent.cachedInputTokens / Math.max(1, u.chatSpent.inputTokens) }
                  : undefined
              }
            />
            <MiniBar label="Output" value={u.chatSpent.outputTokens} max={u.chatSpent.totalTokens} color="var(--viz-4)" />
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
            Every step of a turn re-sends the whole context, so spend runs far ahead of context.
            {!u.spendIsMeasured && " This provider reports no counts, so it is estimated too."}
          </p>
        </div>
      )}

      {/* ── Session limit ─────────────────────────────────────────────── */}
      {u.limitState && (
        <div>
          <Heading
            title="Session limit"
            right={
              <span
                className={`font-mono ${
                  u.limitState === "over"
                    ? "text-[var(--color-danger)]"
                    : u.limitState === "near"
                      ? "text-amber-400"
                      : "text-[var(--color-text)]"
                }`}
              >
                {Math.round(u.limitPct * 100)}%
              </span>
            }
            sub={u.ownLimit !== null ? "this chat's own" : "default from Settings"}
          />
          <div className="h-2 w-full overflow-hidden rounded-[4px] bg-[var(--color-border)]">
            <div
              className={`h-full rounded-[4px] transition-all ${
                u.limitState === "over"
                  ? "bg-[var(--color-danger)]"
                  : u.limitState === "near"
                    ? "bg-amber-400"
                    : "bg-[var(--color-accent)]"
              }`}
              style={{ width: `${Math.max(2, u.limitPct * 100)}%` }}
            />
          </div>
          <div className="mt-1 flex items-baseline justify-between font-mono text-[10px] text-[var(--color-text-muted)]">
            <span>{formatTokens(u.limitSpent)} spent</span>
            <span>{formatTokens(u.spendLimit)} limit</span>
          </div>
          {u.limitState === "over" && (
            <p className="mt-1 text-[10px] text-[var(--color-danger)]">
              Reached — nothing further runs in this session until the limit is raised.
            </p>
          )}
        </div>
      )}

      {/* ── Team ──────────────────────────────────────────────────────── */}
      {u.showTeam && u.usage && (
        <div>
          <Heading
            title="Across the team"
            right={<span className="font-mono text-[var(--color-text)]">{formatTokens(u.sessionTotal ?? 0)}</span>}
            sub={`${u.usage.agents.length} agents`}
          />
          <div className="flex flex-col gap-1">
            {u.usage.agents.map((a) => {
              const value = a.isCurrent ? u.chatTotal : a.totalTokens;
              const max = Math.max(...u.usage!.agents.map((x) => (x.isCurrent ? u.chatTotal : x.totalTokens)), 1);
              return (
                <button
                  key={a.chatId}
                  onClick={() => setActiveChat(a.chatId)}
                  title={`${a.messages} message(s), ${formatTokens(a.overheadTokens)} baseline — open this chat`}
                  className="rounded text-left hover:bg-[var(--color-panel-hover)]"
                  style={{ paddingLeft: `${Math.min(a.depth, 4) * 10}px` }}
                >
                  <MiniBar
                    label={`${a.depth > 0 ? "↳ " : ""}${a.zoneName ?? a.title}${a.isCurrent ? " · here" : ""}`}
                    value={value}
                    max={max}
                    color={a.isCurrent ? "var(--color-accent)" : "var(--viz-1)"}
                  />
                </button>
              );
            })}
          </div>
          {u.sessionSpent && u.sessionSpent.requests > 0 && (
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              Session spend <span className="font-mono">{formatTokens(u.sessionSpent.totalTokens)}</span> over{" "}
              {u.sessionSpent.requests} requests{hitRate(u.sessionSpent) && `, ${hitRate(u.sessionSpent).trim()} cached`}.
            </p>
          )}
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-[var(--color-text-muted)]">
        Context is the size of the next request, estimated from text length.
        {u.showTeam && " Each agent carries its own."}
      </p>
    </div>
  );
}

function Heading({ title, right, sub }: { title: string; right?: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="font-medium text-[var(--color-text)]">{title}</span>
      {sub && <span className="text-[10px] text-[var(--color-text-muted)]">{sub}</span>}
      <span className="ml-auto">{right}</span>
    </div>
  );
}

type Segment = { key: string; label: string; value: number; color: string };

/** One bar, segments in fixed order, a 2px surface gap between fills. */
function StackedBar({ segments, total }: { segments: Segment[]; total: number }) {
  const t = Math.max(total, 1);
  return (
    <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label="Composition of the next request">
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.key}
            title={`${s.label}: ${formatTokens(s.value)} (${Math.round((s.value / t) * 100)}%)`}
            className="h-full rounded-[2px]"
            style={{ width: `${(s.value / t) * 100}%`, background: s.color, minWidth: 2 }}
          />
        ))}
    </div>
  );
}

function Legend({ items, total }: { items: Segment[]; total: number }) {
  const t = Math.max(total, 1);
  return (
    <div className="mt-1 grid grid-cols-[auto_1fr_auto_auto] items-baseline gap-x-2 gap-y-0.5 text-[10px]">
      {items.map((s) => (
        <div key={s.key} className="contents">
          <span className="inline-block h-2 w-2 self-center rounded-[2px]" style={{ background: s.color }} />
          <span className="truncate text-[var(--color-text-muted)]">{s.label}</span>
          <span className="font-mono text-[var(--color-text)]">{formatTokens(s.value)}</span>
          <span className="w-8 text-right font-mono text-[var(--color-text-muted)]">
            {Math.round((s.value / t) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

/** A labelled horizontal bar on a shared scale; optionally a lighter sub-fill
 *  (the cached share of input) drawn inside it. */
function MiniBar({
  label,
  value,
  max,
  color,
  fillLabel,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  fillLabel?: { fraction: number };
}) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(max, 1)) * 100));
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[10px]">
        <span className="truncate text-[var(--color-text-muted)]">{label}</span>
        <span className="shrink-0 font-mono text-[var(--color-text)]">{formatTokens(value)}</span>
      </div>
      <div className="relative mt-0.5 h-1.5 w-full overflow-hidden rounded-[3px] bg-[var(--color-border)]">
        <div className="h-full rounded-[3px]" style={{ width: `${pct}%`, background: color, opacity: fillLabel ? 0.45 : 1 }} />
        {fillLabel && (
          <div
            className="absolute inset-y-0 left-0 rounded-[3px]"
            title="cached"
            style={{ width: `${pct * Math.min(1, fillLabel.fraction)}%`, background: color }}
          />
        )}
      </div>
    </div>
  );
}
