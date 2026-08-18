import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useApp, type StreamingState } from "@/store/app";
import { useTts, zoneVoice } from "@/store/tts";
import type { Message } from "@/lib/types";
import { UserMessage, BotTurnView } from "@/components/Message/Message";
import { TurnErrorNotice } from "./TurnErrorNotice";
import { SpendLimitNotice } from "./SpendLimitNotice";
import { groupMessages } from "@/lib/grouping";

const PIN_THRESHOLD_PX = 60;

// Stable fallbacks — reusing the same reference across renders keeps the
// per-chat selectors below from reporting a "change" (and re-rendering the
// whole thread) on every unrelated store update when a chat has no
// messages/perspectives yet.
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PERSPECTIVE_STREAMS: Record<string, StreamingState> = {};

export function MessageThread({ chatId }: { chatId: string }) {
  // Selected per-chat (rather than destructuring the whole store) so a token
  // streaming into a different chat, or any unrelated store update, doesn't
  // force this thread — and its whole message list — to re-render.
  const messages = useApp((s) => s.messagesByChat[chatId] ?? EMPTY_MESSAGES);
  const messagesLoaded = useApp((s) => s.messagesByChat[chatId] !== undefined);
  const streaming = useApp((s) => s.streamingByChat[chatId]);
  const perspectiveStreams = useApp((s) => s.perspectiveStreamsByChat[chatId] ?? EMPTY_PERSPECTIVE_STREAMS);
  const loadMessages = useApp((s) => s.loadMessages);
  const layout = useApp((s) => s.appSettings.perspectiveLayout);
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
  // Index of the most recent bot turn — regenerate is only offered there so
  // re-running a participant always appends cleanly at the end of the chat.
  let lastBotIdx = -1;
  units.forEach((u, i) => {
    if (u.type === "bot") lastBotIdx = i;
  });

  // In side-by-side columns mode, the thread widens so each column can grow up
  // to the normal single-chat width (max-w-3xl) — on a wide/fullscreen display
  // the columns render as that many full-width chat sections. User messages and
  // single-zone turns stay centered at the normal width inside the wider frame.
  // The frame is capped to fit exactly `maxColumns` full-width columns; `w-full`
  // keeps it bounded by the available window (columns shrink/wrap when narrower).
  const maxColumns = units.reduce(
    (n, u) => (u.type === "bot" ? Math.max(n, 1 + u.perspectives.length) : n),
    0,
  );
  const columnsMode = layout === "columns" && maxColumns > 1;
  // 48rem = max-w-3xl per column; 1rem = gap-4 between columns.
  const columnsMaxWidth = `calc(${maxColumns} * 48rem + ${maxColumns - 1} * 1rem)`;

  useEffect(() => {
    if (!messagesLoaded) loadMessages(chatId);
  }, [chatId, messagesLoaded, loadMessages]);

  // Auto-speak (0.8.1): stream the primary answer to TTS as it arrives, so
  // speech starts before the full response completes. A ref tracks which
  // message we've opened a streaming session for so we start/finish exactly once.
  // Auto-speak when the setting is on, or whenever conversation mode is active
  // for this chat (spoken responses are required for the hands-free loop).
  const autoSpeakSetting = useApp((s) => s.appSettings.ttsAutoSpeak);
  const conversationActive = useApp((s) => s.conversationChatId === chatId);
  const autoSpeak = autoSpeakSetting || conversationActive;
  const ttsConfigured = useApp((s) => !!s.appSettings.ttsProviderId && !!s.appSettings.ttsModel);
  const globalVoice = useApp((s) => s.appSettings.ttsVoice);
  const chatZone = useApp((s) => {
    const zid = s.chats.find((c) => c.id === chatId)?.zoneId ?? null;
    return s.zones.find((z) => z.id === zid);
  });
  const autoSpokenIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSpeak || !ttsConfigured) return;
    const tts = useTts.getState();
    if (streaming) {
      if (autoSpokenIdRef.current !== streaming.messageId) {
        autoSpokenIdRef.current = streaming.messageId;
        const voice = zoneVoice(chatZone?.toolConfig) ?? (globalVoice || null);
        tts.startStreaming(streaming.messageId, voice);
      }
      if (streaming.content) tts.feedStreaming(streaming.content);
    } else if (autoSpokenIdRef.current) {
      // Stream ended — flush the tail so the last sentence is spoken.
      autoSpokenIdRef.current = null;
      tts.finishStreaming();
    }
  }, [autoSpeak, ttsConfigured, globalVoice, chatZone, streaming?.messageId, streaming?.content, streaming]);

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

  // Cross-chat search lands here (0.15.0): scroll the hit into view and flash
  // it, so arriving in a 200-message chat shows *where* the match was rather
  // than dropping the user at the bottom to hunt for it.
  //
  // Waits on `messagesLoaded` because the anchor does not exist until the
  // thread has rendered, and clears the flag either way — a jump to a message
  // that has since been deleted should not re-fire on every later visit.
  const pendingJumpMessageId = useApp((s) => s.pendingJumpMessageId);
  const clearPendingJump = useApp((s) => s.clearPendingJump);
  useEffect(() => {
    if (!pendingJumpMessageId || !messagesLoaded) return;
    const id = window.requestAnimationFrame(() => {
      const el = innerRef.current?.querySelector(`[data-msg~="${CSS.escape(pendingJumpMessageId)}"]`);
      // The unit wrapper is `display: contents` outside columns mode, which has
      // no box to scroll to — its first child is the real one.
      const target = (el?.firstElementChild ?? el) as HTMLElement | null;
      if (target) {
        programmaticScrollRef.current = true;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.classList.add("mz-jump-flash");
        window.setTimeout(() => target.classList.remove("mz-jump-flash"), 1600);
        window.setTimeout(() => {
          programmaticScrollRef.current = false;
        }, 600);
      }
      clearPendingJump();
    });
    return () => window.cancelAnimationFrame(id);
  }, [pendingJumpMessageId, messagesLoaded, clearPendingJump]);

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
      {/* `mz-thread` is the container-query context the assistant turns measure
          to decide whether there is room to hang their avatar outside the
          message column (see styles.css). */}
      <div className="mz-thread flex-1 overflow-y-auto px-3 py-4 sm:px-6" ref={containerRef}>
        <div
          className={`mx-auto flex w-full flex-col gap-5 ${columnsMode ? "" : "max-w-3xl"}`}
          style={columnsMode ? { maxWidth: columnsMaxWidth } : undefined}
          ref={innerRef}
        >
          {units.map((unit, i) => {
            // A bot turn with perspectives spans the full (widened) frame so its
            // columns can spread; everything else stays at the normal width.
            const spansFull = columnsMode && unit.type === "bot" && unit.perspectives.length > 0;
            const node =
              unit.type === "user" ? (
                <UserMessage message={unit.message} />
              ) : (
                <BotTurnView turn={unit} isLatest={i === lastBotIdx} />
              );
            const key = unit.type === "user" ? unit.message.id : `bot-${i}`;
            // Anchor for cross-chat search (0.15.0). A bot turn lists every
            // assistant message it merged, so a hit on any of them finds the
            // turn that rendered it.
            const anchor =
              unit.type === "user" ? unit.message.id : unit.messageIds.join(" ");
            return spansFull ? (
              <div key={key} data-msg={anchor}>{node}</div>
            ) : (
              <div key={key} data-msg={anchor} className={columnsMode ? "mx-auto w-full max-w-3xl" : "contents"}>
                {node}
              </div>
            );
          })}
          {/* Each participant's live status renders inside its own response
              block (see `Message.tsx`), so in a side-by-side turn the numbers
              sit in the column of the zone they describe. */}
          {/* A failed turn saves no message, so its explanation lives outside
              the unit list — otherwise the turn renders as nothing at all. */}
          <TurnErrorNotice chatId={chatId} />
          {/* A run stopped by the spend limit (0.14.3) — a question with
              actions rather than a report, so it sits below the transcript it
              stopped and stays until it is answered. */}
          <SpendLimitNotice chatId={chatId} />
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
