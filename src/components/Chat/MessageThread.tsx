import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useApp, type StreamingState } from "@/store/app";
import { useTts, zoneVoice } from "@/store/tts";
import type { Message } from "@/lib/types";
import { UserMessage, BotTurnView } from "@/components/Message/Message";
import { TurnErrorNotice } from "./TurnErrorNotice";
import { SpendLimitNotice } from "./SpendLimitNotice";
import { groupMessages } from "@/lib/grouping";
import { systemTurnNotice } from "@/lib/systemTurn";
import type { ContentPart } from "@/lib/types";
import { afterRelease, afterScroll, afterUpIntent, showJump, type ScrollGeom } from "@/lib/stickToBottom";

const geomOf = (c: HTMLElement): ScrollGeom => ({
  scrollTop: c.scrollTop,
  scrollHeight: c.scrollHeight,
  clientHeight: c.clientHeight,
});

// Stable fallbacks — reusing the same reference across renders keeps the
// per-chat selectors below from reporting a "change" (and re-rendering the
// whole thread) on every unrelated store update when a chat has no
// messages/perspectives yet.
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PERSPECTIVE_STREAMS: Record<string, StreamingState> = {};

export function MessageThread({ chatId, bottomInset = 0 }: {
  chatId: string;
  /** Height of whatever floats over the bottom of the thread — the composer
   *  (0.18.1). The transcript is padded by it so nothing ends up beneath. */
  bottomInset?: number;
}) {
  // Selected per-chat (rather than destructuring the whole store) so a token
  // streaming into a different chat, or any unrelated store update, doesn't
  // force this thread — and its whole message list — to re-render.
  const messages = useApp((s) => s.messagesByChat[chatId] ?? EMPTY_MESSAGES);
  const messagesLoaded = useApp((s) => s.messagesByChat[chatId] !== undefined);
  const streaming = useApp((s) => s.streamingByChat[chatId]);
  const perspectiveStreams = useApp((s) => s.perspectiveStreamsByChat[chatId] ?? EMPTY_PERSPECTIVE_STREAMS);
  const loadMessages = useApp((s) => s.loadMessages);
  const layout = useApp((s) => s.appSettings.zoneLayout);
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // "pinned" = the reader wants to follow the latest content. It is intent,
  // not geometry — see `lib/stickToBottom.ts` for why. A ref, because the
  // listeners below read it and nothing renders from it directly.
  const pinnedRef = useRef(true);
  // The last geometry seen, so a scroll event can tell which way it moved.
  const lastGeomRef = useRef<ScrollGeom>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const [jumpShown, setJumpShown] = useState(false);

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

  // Re-measure: remember where the view is and whether to offer the button.
  const sync = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const g = geomOf(c);
    lastGeomRef.current = g;
    setJumpShown(showJump(pinnedRef.current, g));
  }, []);

  // Follow the bottom on any change of size, not on a list of store fields:
  // tokens, a diagram or image finishing late, a block expanding, the composer
  // (the thread's bottom padding) growing, the pane being resized, or shown
  // again after being zoomed away (a 0-tall pane is left alone). The observer
  // runs after layout and before paint, so the snap is never a frame late and
  // is instant — a smooth scroll here would fight the growth and the reader.
  useEffect(() => {
    const c = containerRef.current;
    const inner = innerRef.current;
    if (!c || !inner) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current && c.clientHeight > 0) c.scrollTop = c.scrollHeight;
      sync();
    });
    ro.observe(inner);
    ro.observe(c);
    return () => ro.disconnect();
  }, [sync]);

  // Only the reader's own upward gesture unpins. Scroll events can't say who
  // moved the view (us, growth, scroll anchoring, a resize), so they only ever
  // re-pin — see `lib/stickToBottom.ts`.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const upIntent = () => {
      pinnedRef.current = afterUpIntent(pinnedRef.current, geomOf(c));
      sync();
    };
    // A gesture over a code block or tool output that can still scroll up
    // scrolls that, not the thread.
    const nestedTakesIt = (t: EventTarget | null) => {
      for (let el = t instanceof Element ? t : null; el && el !== c; el = el.parentElement) {
        if (el.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return true;
      }
      return false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && !e.ctrlKey && !nestedTakesIt(e.target)) upIntent();
    };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? touchY;
      // Finger moving down drags the content down: the view goes up.
      if (y > touchY && !nestedTakesIt(e.target)) upIntent();
      touchY = y;
    };
    // Keys scroll whichever scroller holds focus, or the one last clicked.
    let clickedInside = false;
    let grabbedScrollbar = false;
    const onPointerDown = (e: PointerEvent) => {
      clickedInside = c.contains(e.target as Node);
      // The scrollbar belongs to the scroller itself, right of its client box.
      if (e.target === c && e.offsetX >= c.clientWidth) {
        grabbedScrollbar = true;
        upIntent();
      }
    };
    const onPointerUp = () => {
      if (!grabbedScrollbar) return;
      grabbedScrollbar = false;
      pinnedRef.current = afterRelease(pinnedRef.current, geomOf(c));
      sync();
    };
    const onKey = (e: KeyboardEvent) => {
      const up = e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home" || (e.key === " " && e.shiftKey);
      if (!up || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const a = document.activeElement;
      if (c.contains(a) || ((!a || a === document.body) && clickedInside)) upIntent();
    };
    const onScroll = () => {
      const g = geomOf(c);
      pinnedRef.current = afterScroll(pinnedRef.current, lastGeomRef.current, g);
      lastGeomRef.current = g;
      setJumpShown(showJump(pinnedRef.current, g));
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    c.addEventListener("wheel", onWheel, { passive: true });
    c.addEventListener("touchstart", onTouchStart, { passive: true });
    c.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      c.removeEventListener("scroll", onScroll);
      c.removeEventListener("wheel", onWheel);
      c.removeEventListener("touchstart", onTouchStart);
      c.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [sync]);

  // Sending a message means "show me the reply": follow again. The thread is
  // keyed by chat, so a chat switch remounts it pinned and the observer's
  // first callback puts it at the bottom.
  const last = messages[messages.length - 1];
  const lastUserId = last?.role === "user" ? last.id : null;
  useEffect(() => {
    const c = containerRef.current;
    if (!lastUserId || !c) return;
    pinnedRef.current = true;
    if (c.clientHeight > 0) c.scrollTop = c.scrollHeight;
    sync();
  }, [lastUserId, sync]);

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
        // Reading the hit is the point: stop following, or the next token
        // would carry the reader straight back down.
        pinnedRef.current = false;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.classList.add("mz-jump-flash");
        window.setTimeout(() => target.classList.remove("mz-jump-flash"), 1600);
      }
      clearPendingJump();
    });
    return () => window.cancelAnimationFrame(id);
  }, [pendingJumpMessageId, messagesLoaded, clearPendingJump]);

  const scrollToBottom = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    pinnedRef.current = true;
    setJumpShown(false);
    // Instant while a reply streams: a smooth scroll chases a moving target.
    c.scrollTo({ top: c.scrollHeight, behavior: streaming ? "auto" : "smooth" });
  }, [streaming]);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* `mz-thread` is the container-query context the assistant turns measure
          to decide whether there is room to hang their avatar outside the
          message column (see styles.css). */}
      <div
        className="mz-thread flex-1 overflow-y-auto px-3 pt-4 sm:px-6"
        style={{ paddingBottom: bottomInset + 16 }}
        ref={containerRef}
      >
        <div
          className={`mx-auto flex w-full flex-col gap-5 ${columnsMode ? "" : "max-w-3xl"}`}
          style={columnsMode ? { maxWidth: columnsMaxWidth } : undefined}
          ref={innerRef}
        >
          {units.map((unit, i) => {
            // A bot turn with perspectives spans the full (widened) frame so its
            // columns can spread; everything else stays at the normal width.
            const spansFull = columnsMode && unit.type === "bot" && unit.perspectives.length > 0;
            const notice = unit.type === "user" ? noticeFor(unit.message) : null;
            const node =
              unit.type === "user" ? (
                notice ? (
                  <SystemNotice text={notice} />
                ) : (
                  <UserMessage message={unit.message} />
                )
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

      {jumpShown && (
        <button
          onClick={scrollToBottom}
          style={{ bottom: bottomInset + 16 }}
          className="absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-xs text-[var(--color-text)] shadow-lg"
          title="Jump to latest"
        >
          <ArrowDown size={12} className="text-[var(--color-accent)]" />
          {streaming ? "New content below" : "Jump to latest"}
        </button>
      )}
    </div>
  );
}

/**
 * The system line a turn the app sent renders as — a plan approval, today.
 *
 * Parsed here rather than inside `UserMessage` so the turn never becomes a
 * message bubble at all: it has no author, nothing to copy, and nothing to edit
 * or resend.
 */
function noticeFor(message: Message): string | null {
  try {
    return systemTurnNotice(JSON.parse(message.content) as ContentPart[]);
  } catch {
    return null;
  }
}

function SystemNotice({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-[var(--color-text-muted)]">
      <span className="h-px flex-1 bg-[var(--color-border)]" />
      <span className="shrink-0">{text}</span>
      <span className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  );
}
