import { useEffect, useState } from "react";
import { Loader2, Wrench, Cog, Brain } from "lucide-react";
import { LIVE_RATE_WINDOW_MS, useApp, type StreamingState, type TurnAggregate } from "@/store/app";
import { formatTokens } from "@/lib/format";

/**
 * Live status line for one participant in a turn — the primary or a
 * perspective zone. Both go through this single component so every zone in a
 * multi-zone turn reports the same things about its own generation: the phase
 * it is actually in (thinking / requesting a tool / running one / writing),
 * plus a timer, token count and throughput read from *that zone's* turn
 * aggregate.
 *
 * It renders inside the answering zone's own response block, so in a
 * side-by-side turn each column carries its own numbers instead of the whole
 * set piling up under the thread.
 */
function ZoneStatusLine({
  streaming,
  turn,
  zoneId,
}: {
  streaming: StreamingState;
  /** This participant's whole-turn totals; undefined only on a first-paint race. */
  turn: TurnAggregate | undefined;
  zoneId: string | null;
}) {
  // Prefer the turn-level aggregate so timer + token count survive across
  // iterations of the agentic loop; fall back to the per-iteration streaming
  // state if it's somehow missing.
  const firstTokenAt = turn?.firstTokenAt ?? streaming.firstTokenAt;
  const contentChars = turn?.contentChars ?? streaming.content.length;
  const reasoningChars = turn?.reasoningChars ?? streaming.reasoning.length;
  const toolCallChars = turn?.toolCallChars ?? 0;
  const toolMs = turn?.toolMs ?? 0;
  const toolStartedAt = turn?.toolStartedAt ?? null;
  const approvalMs = turn?.approvalMs ?? 0;
  const approvalStartedAt = turn?.approvalStartedAt ?? null;
  const prefillMs = turn?.prefillMs ?? 0;
  const prefillStartedAt = turn?.prefillStartedAt ?? null;
  const recentChars = turn?.recentChars;
  const elapsed = useLiveElapsed(firstTokenAt);
  const accent = useApp((s) => s.zones.find((z) => z.id === zoneId)?.accentColor ?? null);

  let icon = <Loader2 size={12} className="animate-spin" />;
  let label = "Generating…";
  if (firstTokenAt === null) {
    icon = <Loader2 size={12} className="animate-spin" />;
    label = "Waiting for first token…";
  } else if (prefillStartedAt !== null) {
    // A step that has been asked for and has sent nothing back yet: the model is
    // re-reading the conversation, including whatever the last tool returned.
    // Named rather than shown as "Generating…", because the difference between
    // "the model is slow" and "the context is large" is the whole diagnosis.
    icon = <Loader2 size={12} className="animate-spin" />;
    label = "Reading the conversation…";
  } else if (streaming.phase === "thinking") {
    icon = <Brain size={12} className="animate-pulse text-violet-400" />;
    label = "Thinking…";
  } else if (streaming.phase === "answering") {
    icon = <Loader2 size={12} className="animate-spin" />;
    label = "Writing answer…";
  } else if (streaming.phase === "tool_calling") {
    const tools = streaming.pendingTools;
    const t = tools[tools.length - 1];
    // Tool requests stream in (args build up char by char) — pulse the wrench in
    // the zone's color so it's obvious a tool call is actively being assembled.
    icon = (
      <Wrench
        size={12}
        className="animate-pulse"
        style={{ color: accent ?? "var(--color-accent)" }}
      />
    );
    const extra = tools.length > 1 ? ` (+${tools.length - 1} more)` : "";
    label = t?.name ? `Requesting tool ${t.name}…${extra}` : "Requesting tool…";
  } else if (streaming.phase === "tool_running") {
    icon = <Cog size={12} className="animate-spin" />;
    label = streaming.runningTool
      ? `Running tool ${streaming.runningTool}…`
      : "Running tool…";
  }

  const liveTokens = estimateTokens(contentChars + reasoningChars + toolCallChars);
  // Generation time excludes tool execution and any wait for an approval:
  // completed runs (toolMs / approvalMs) plus whichever is in flight,
  // reconstructed from the same live clock since now = firstTokenAt + elapsed.
  // While a tool runs or a prompt sits unanswered this grows in lock-step with
  // elapsed, so genElapsed — and the average — holds steady while the overall
  // timer keeps ticking.
  const activeToolMs =
    toolStartedAt !== null && firstTokenAt !== null
      ? Math.max(0, firstTokenAt + elapsed - toolStartedAt)
      : 0;
  const activeApprovalMs =
    approvalStartedAt !== null && firstTokenAt !== null
      ? Math.max(0, firstTokenAt + elapsed - approvalStartedAt)
      : 0;
  // Prefill too (0.14.4): after every tool result the model re-encodes a context
  // that has just grown, and it is not generating while it does. On a long
  // agentic turn this is most of the wall clock.
  const activePrefillMs =
    prefillStartedAt !== null && firstTokenAt !== null
      ? Math.max(0, firstTokenAt + elapsed - prefillStartedAt)
      : 0;
  const genElapsed = Math.max(
    0,
    elapsed - toolMs - activeToolMs - approvalMs - activeApprovalMs - prefillMs - activePrefillMs,
  );

  // Two different questions, and the live one is what a person watching a
  // stream is actually asking (0.14.3): **how fast is this provider going right
  // now**. A whole-turn average cannot answer it — it is dragged down by every
  // pause already in the turn and moves more slowly the longer the turn runs,
  // so a model that has fallen off a cliff, or a provider swap that changed
  // nothing, both look like a number drifting.
  //
  // So: the rate over the last few seconds while output is arriving, and the
  // turn average once it stops (during a tool run, an approval, or a gap), where
  // a rolling window would read a truthful but useless 0.
  const rollingTps = useRollingRate(recentChars);
  const averageTps =
    genElapsed > 300 && liveTokens > 0 ? liveTokens / (genElapsed / 1000) : null;
  const liveTps = rollingTps ?? averageTps;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5 text-xs text-[var(--color-text-muted)]">
      {icon}
      <span>{label}</span>
      {firstTokenAt !== null && (
        <>
          <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
          <span className="text-[var(--color-text-muted)]/70">·</span>
          <span className="font-mono tabular-nums">~{formatTokens(liveTokens)} tok</span>
          {liveTps !== null && (
            <>
              <span className="text-[var(--color-text-muted)]/70">·</span>
              <span className="font-mono tabular-nums">{liveTps.toFixed(1)} tok/s</span>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** The primary turn's status line, reading the chat-level turn aggregate. */
export function PrimaryStatusLine({
  streaming,
  chatId,
  zoneId,
}: {
  streaming: StreamingState;
  chatId: string;
  zoneId: string | null;
}) {
  const turn = useApp((s) => s.turnByChat[chatId]);
  return <ZoneStatusLine streaming={streaming} turn={turn} zoneId={zoneId} />;
}

/** A perspective zone's status line, reading that zone's own turn aggregate. */
export function PerspectiveStatusLine({
  streaming,
  chatId,
  zoneId,
}: {
  streaming: StreamingState;
  chatId: string;
  zoneId: string;
}) {
  const turn = useApp((s) => s.perspectiveTurnByChat[chatId]?.[zoneId]);
  return <ZoneStatusLine streaming={streaming} turn={turn} zoneId={zoneId} />;
}

/**
 * Tokens per second over the last few seconds, or null when nothing has arrived
 * in that window.
 *
 * Null rather than zero on purpose. Output stops for ordinary reasons — a tool
 * is running, an approval is on screen, the provider is between chunks — and
 * "0 tok/s" during any of them is a true statement about the window and a false
 * impression about the provider. The caller falls back to the turn average,
 * which is the honest number when nothing is streaming.
 *
 * The window is re-evaluated on a timer rather than only when samples arrive,
 * so the reading decays as output stops instead of freezing at its last value.
 */
function useRollingRate(samples: [number, number][] | undefined): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  if (!samples?.length) return null;
  const now = Date.now();
  const cutoff = now - LIVE_RATE_WINDOW_MS;
  const inWindow = samples.filter(([at]) => at >= cutoff);
  if (inWindow.length < 2) return null;

  // Measure from the first sample in the window rather than from the window's
  // own start: a stream two seconds old has not been running for five, and
  // dividing by five would report a third of the truth.
  const from = inWindow[0][0];
  const seconds = (now - from) / 1000;
  if (seconds < 0.5) return null;
  const chars = inWindow.reduce((n, [, c]) => n + c, 0);
  return estimateTokens(chars) / seconds;
}

/**
 * Returns elapsed ms from `origin` (or 0 while origin is null). Re-renders on
 * a coarse 250 ms interval so the timer is readable without saturating React.
 */
function useLiveElapsed(origin: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (origin === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [origin]);
  if (origin === null) return 0;
  return Math.max(0, now - origin);
}

function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}
