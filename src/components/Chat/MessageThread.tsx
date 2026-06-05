import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Wrench, Cog, Brain, ArrowDown } from "lucide-react";
import { useApp, type StreamingState } from "@/store/app";
import { UserMessage, BotTurnView } from "@/components/Message/Message";
import { groupMessages } from "@/lib/grouping";

const PIN_THRESHOLD_PX = 60;

export function MessageThread({ chatId }: { chatId: string }) {
  const { messagesByChat, streamingByChat, perspectiveStreamsByChat, loadMessages } = useApp();
  const messages = messagesByChat[chatId] ?? [];
  const streaming = streamingByChat[chatId];
  const perspectiveStreams = perspectiveStreamsByChat[chatId] ?? {};
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // "pinned" = user is at (or near) the bottom right now. While pinned, new
  // content auto-scrolls; when they scroll up themselves it unpins and the
  // jump-to-bottom button appears.
  const [pinned, setPinned] = useState(true);
  // Ref mirror so the layout-effect that follows new content can read the
  // latest value without retriggering on it.
  const pinnedRef = useRef(true);
  // Tracks programmatic scrolls so we don't treat our own scrollIntoView
  // calls as "the user scrolled."
  const programmaticScrollRef = useRef(false);

  const units = useMemo(
    () => groupMessages(messages, streaming, perspectiveStreams),
    [messages, streaming, perspectiveStreams],
  );

  useEffect(() => {
    if (!messagesByChat[chatId]) loadMessages(chatId);
  }, [chatId, messagesByChat, loadMessages]);

  // When switching chats, default to pinned and jump to the bottom.
  useEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
    requestAnimationFrame(() => {
      const c = containerRef.current;
      if (c) c.scrollTop = c.scrollHeight;
    });
  }, [chatId]);

  // Track scroll position. Distinguish user scrolls from our own.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const handle = () => {
      if (programmaticScrollRef.current) return;
      const distance = c.scrollHeight - c.scrollTop - c.clientHeight;
      const atBottom = distance < PIN_THRESHOLD_PX;
      pinnedRef.current = atBottom;
      setPinned(atBottom);
    };
    c.addEventListener("scroll", handle, { passive: true });
    return () => c.removeEventListener("scroll", handle);
  }, []);

  // Any direct user intent to move the viewport unpins immediately, without
  // waiting for a scroll event. This breaks the loop where ResizeObserver-driven
  // auto-scroll fights the user's wheel/touch and feels laggy or "stuck".
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const unpinIfUpward = () => {
      pinnedRef.current = false;
      setPinned(false);
    };
    const onWheel = (e: WheelEvent) => {
      // Only unpin on upward scroll. Scrolling down while already at the
      // bottom would briefly flash the "jump to latest" button before the
      // scroll handler re-pins — so we leave pinning to the scroll handler.
      if (e.deltaY < 0) unpinIfUpward();
    };
    const onTouchMove = () => unpinIfUpward();
    const onKey = (e: KeyboardEvent) => {
      // Only treat scroll-affecting keys when the chat container has focus
      // (not while typing in the input bar).
      if (document.activeElement !== c) return;
      const scrollKeys = [
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
      ];
      if (scrollKeys.includes(e.key)) unpinIfUpward();
    };
    c.addEventListener("wheel", onWheel, { passive: true });
    c.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      c.removeEventListener("wheel", onWheel);
      c.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Watch the inner content for size changes (async-rendered Mermaid diagrams,
  // images loading, KaTeX layout). When the container grows while the user is
  // pinned to the bottom, keep them pinned instead of letting them drift up.
  // Coalesce bursts of resize events into a single scrollTop write per frame
  // to keep token-stream-driven layout shifts from saturating the main thread.
  useEffect(() => {
    const c = containerRef.current;
    const inner = innerRef.current;
    if (!c || !inner) return;
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!pinnedRef.current) return;
        programmaticScrollRef.current = true;
        c.scrollTop = c.scrollHeight;
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
      });
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  // When content updates and we're pinned, snap to bottom. Use "auto"
  // (instant) so rapid token streams don't fight each other with smooth
  // animations.
  useEffect(() => {
    if (!pinnedRef.current) return;
    const c = containerRef.current;
    if (!c) return;
    programmaticScrollRef.current = true;
    c.scrollTop = c.scrollHeight;
    // Release the programmatic flag after the browser has dispatched
    // the resulting scroll event.
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [
    messages.length,
    streaming?.content,
    streaming?.reasoning,
    streaming?.phase,
    streaming?.pendingTools.length,
    streaming?.runningTool,
    Object.keys(perspectiveStreams).length,
  ]);

  const scrollToBottom = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    programmaticScrollRef.current = true;
    c.scrollTo({ top: c.scrollHeight, behavior: "smooth" });
    pinnedRef.current = true;
    setPinned(true);
    // Smooth scroll fires many events; clear the flag after a bit so future
    // user scrolls register normally.
    window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 400);
  }, []);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-6" ref={containerRef}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5" ref={innerRef}>
          {units.map((unit, i) =>
            unit.type === "user" ? (
              <UserMessage key={unit.message.id} message={unit.message} />
            ) : (
              <BotTurnView key={`bot-${i}`} turn={unit} />
            ),
          )}
          {streaming && <StatusBanner streaming={streaming} chatId={chatId} />}
          {Object.entries(perspectiveStreams).map(([zoneId, ps]) => (
            <PerspectiveStatusBanner key={zoneId} streaming={ps} zoneId={zoneId} chatId={chatId} />
          ))}
          <div ref={endRef} />
        </div>
      </div>

      {!pinned && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-xs text-[var(--color-text)] shadow-lg"
          title="Jump to latest"
        >
          <ArrowDown size={12} className="text-[var(--color-accent)]" />
          {streaming ? "New content below" : "Jump to latest"}
        </button>
      )}
    </div>
  );
}

function StatusBanner({
  streaming,
  chatId,
}: {
  streaming: StreamingState;
  chatId: string;
}) {
  // Read the turn-level aggregate so timer + token count survive across
  // iterations of the agentic loop. If for some reason it's missing (e.g. a
  // race on first paint), fall back to the per-iteration streaming state.
  const turn = useApp((s) => s.turnByChat[chatId]);
  const firstTokenAt = turn?.firstTokenAt ?? streaming.firstTokenAt;
  const contentChars = turn?.contentChars ?? streaming.content.length;
  const reasoningChars = turn?.reasoningChars ?? streaming.reasoning.length;
  const toolCallChars = turn?.toolCallChars ?? 0;
  const elapsed = useLiveElapsed(firstTokenAt);

  let icon = <Loader2 size={12} className="animate-spin" />;
  let label = "Generating…";
  if (firstTokenAt === null) {
    icon = <Loader2 size={12} className="animate-spin" />;
    label = "Waiting for first token…";
  } else if (streaming.phase === "thinking") {
    icon = <Brain size={12} className="animate-pulse text-violet-400" />;
    label = "Thinking…";
  } else if (streaming.phase === "answering") {
    icon = <Loader2 size={12} className="animate-spin" />;
    label = "Writing answer…";
  } else if (streaming.phase === "tool_calling") {
    const t = streaming.pendingTools[streaming.pendingTools.length - 1];
    icon = <Wrench size={12} />;
    label = t?.name ? `Preparing tool ${t.name}…` : "Preparing tool…";
  } else if (streaming.phase === "tool_running") {
    icon = <Cog size={12} className="animate-spin" />;
    label = streaming.runningTool
      ? `Running tool ${streaming.runningTool}…`
      : "Running tool…";
  }
  const liveTokens = estimateTokens(contentChars + reasoningChars + toolCallChars);
  return (
    <div className="ml-10 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
      {icon}
      <span>{label}</span>
      {firstTokenAt !== null && (
        <>
          <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
          <span className="text-[var(--color-text-muted)]/70">·</span>
          <span className="font-mono tabular-nums">~{liveTokens} tok</span>
        </>
      )}
    </div>
  );
}

function PerspectiveStatusBanner({
  streaming,
  zoneId,
  chatId,
}: {
  streaming: StreamingState;
  zoneId: string;
  chatId: string;
}) {
  const zone = useApp((s) => s.zones.find((z) => z.id === zoneId));
  const elapsed = useLiveElapsed(streaming.firstTokenAt);
  const color = zone?.accentColor ?? "var(--color-accent)";

  let label = "Waiting…";
  if (streaming.firstTokenAt !== null) {
    if (streaming.phase === "thinking") label = "Thinking…";
    else label = "Writing…";
  }

  return (
    <div className="ml-10 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full animate-pulse"
        style={{ background: color }}
      />
      <span style={{ color }}>{zone?.name ?? "Perspective"}</span>
      <span>{label}</span>
      {streaming.firstTokenAt !== null && (
        <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
      )}
    </div>
  );
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
