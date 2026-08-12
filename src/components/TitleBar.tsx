import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { Minus, Square, X, Maximize2 } from "lucide-react";
import { useApp } from "@/store/app";

/**
 * How long after a touch/pen press we treat an incoming `mousedown` as the
 * compatibility event for that same press. Chromium synthesizes it once the
 * gesture is recognised, which is after the contact lifts.
 */
const COMPAT_MOUSE_MS = 900;

/** Double-*tap* thresholds: time between taps, and how far the second may land
 *  from the first. A finger is less precise than a mouse, hence the 24px. */
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 24;

/**
 * Window dragging by touch or stylus (0.11.3).
 *
 * `data-tauri-drag-region` is implemented by a script Tauri injects into every
 * webview, and that script listens for exactly one event: `mousedown`. A finger
 * or a pen never produces one *while it is down* — Chromium synthesizes the
 * compatibility mouse events only after it has decided the gesture was a tap,
 * which is after the contact has already lifted. Two consequences, and the
 * second is the one that makes the bar feel broken rather than merely inert:
 *
 * 1. Dragging the window is impossible. There is no mousedown during the drag,
 *    so nothing ever calls `start_dragging`.
 * 2. A *tap* is worse. The synthesized mousedown does arrive, a beat late, and
 *    Tauri starts a drag from it — which on Windows is `ReleaseCapture()` plus
 *    a posted `WM_NCLBUTTONDOWN`, i.e. the OS's modal window-move loop. It is
 *    entered with nothing held down, so the release that would end it has
 *    already happened, and the title bar stops responding.
 *
 * So this handles non-mouse pointers itself, starting the drag on `pointerdown`
 * while the contact is still down (which is what the move loop needs), and then
 * swallows the late compatibility `mousedown` in the capture phase so Tauri's
 * own listener — which is on `document`, in the bubble phase — never sees it
 * and cannot start the second, stuck drag. Mouse input is left entirely alone:
 * the injected script already handles it correctly, including its own
 * double-click-to-maximize.
 */
/** A touch/pen drag in progress: where the contact started, where the window was,
 *  and the latest position waiting to be applied on the next frame. */
interface TouchDrag {
  pointerId: number;
  /** Screen coordinates of the contact when it went down, in CSS px. */
  from: { x: number; y: number };
  /** The window's physical position when the drag began. Null until the async
   *  read resolves — moves before that are ignored rather than queued. */
  origin: { x: number; y: number } | null;
  scale: number;
  /** Latest physical position not yet sent, coalesced to one write per frame. */
  pending: { x: number; y: number } | null;
  frame: number | null;
}

function useTouchDragRegion(onToggleMaximize: () => void) {
  const appWindow = useRef(getCurrentWindow()).current;
  const suppressMouseUntil = useRef(0);
  const lastTap = useRef({ at: 0, x: 0, y: 0 });
  const drag = useRef<TouchDrag | null>(null);

  useEffect(() => {
    function swallowCompatMouseDown(e: MouseEvent) {
      if (Date.now() > suppressMouseUntil.current) return;
      const onDragRegion = e
        .composedPath()
        .some((el) => el instanceof HTMLElement && el.hasAttribute("data-tauri-drag-region"));
      if (!onDragRegion) return;
      // Capture phase on `window` runs before the bubble-phase listener on
      // `document`, and stopping propagation here means it never runs at all.
      e.stopPropagation();
      e.preventDefault();
    }
    window.addEventListener("mousedown", swallowCompatMouseDown, true);
    return () => window.removeEventListener("mousedown", swallowCompatMouseDown, true);
  }, []);

  // Every drag ends by cancelling whatever is still in flight, whichever way it
  // ended (lift, cancel, or the capture being taken away).
  function endDrag() {
    const st = drag.current;
    if (!st) return;
    if (st.frame != null) cancelAnimationFrame(st.frame);
    drag.current = null;
  }

  useEffect(() => endDrag, []);

  function onPointerDown(e: React.PointerEvent<HTMLElement>) {
    if (e.pointerType === "mouse") return; // already handled, correctly
    // Only a press on the drag surface itself, never one that landed on a
    // control inside it — the same rule the injected script applies to a bare
    // `data-tauri-drag-region`.
    if (e.target !== e.currentTarget) return;

    suppressMouseUntil.current = Date.now() + COMPAT_MOUSE_MS;

    const now = Date.now();
    const prev = lastTap.current;
    const doubleTap =
      now - prev.at < DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_PX;
    lastTap.current = doubleTap
      ? { at: 0, x: 0, y: 0 } // consumed, so a third tap starts over
      : { at: now, x: e.clientX, y: e.clientY };

    if (doubleTap) {
      onToggleMaximize();
      return;
    }

    // Move the window ourselves rather than asking the OS to.
    //
    // `startDragging()` is what a mouse uses and it cannot work from a finger: on
    // Windows it is `ReleaseCapture()` plus a posted `WM_NCLBUTTONDOWN`, which
    // enters the OS's modal window-move loop, and that loop follows *mouse*
    // messages. Touch is only promoted to mouse messages after the gesture has
    // been recognised — i.e. after the contact lifts — so the loop is entered with
    // nothing to track and the window never moves. 0.11.3 fixed the stuck-drag
    // half of this and left the drag itself still inert.
    //
    // So the pointer is captured here and the window is repositioned from the
    // contact's own movement. Screen coordinates, not client ones: the window
    // follows the finger, so relative to the window the finger barely moves.
    endDrag();
    e.currentTarget.setPointerCapture(e.pointerId);
    const st: TouchDrag = {
      pointerId: e.pointerId,
      from: { x: e.screenX, y: e.screenY },
      origin: null,
      scale: 1,
      pending: null,
      frame: null,
    };
    drag.current = st;

    void (async () => {
      try {
        // Dragging a maximized window restores it first, as everywhere else — and
        // the position has to be read *after* that, since it is about to change.
        if (await appWindow.isMaximized()) await appWindow.unmaximize();
        const [pos, scale] = await Promise.all([
          appWindow.outerPosition(),
          appWindow.scaleFactor(),
        ]);
        if (drag.current !== st) return; // lifted while we were asking
        st.origin = { x: pos.x, y: pos.y };
        st.scale = scale;
      } catch {
        // No window handle (or not in the Tauri shell) — the drag simply does
        // nothing, which is what it did before.
        if (drag.current === st) endDrag();
      }
    })();
  }

  function onPointerMove(e: React.PointerEvent<HTMLElement>) {
    const st = drag.current;
    if (!st || st.pointerId !== e.pointerId || !st.origin) return;
    // CSS px of screen space → physical px, which is what setPosition takes.
    st.pending = {
      x: Math.round(st.origin.x + (e.screenX - st.from.x) * st.scale),
      y: Math.round(st.origin.y + (e.screenY - st.from.y) * st.scale),
    };
    // One write per frame. A pen reports far faster than the window can be moved,
    // and an unthrottled call per event queues IPC until the drag lags behind the
    // contact by half a second.
    if (st.frame == null) {
      st.frame = requestAnimationFrame(() => {
        st.frame = null;
        const next = st.pending;
        st.pending = null;
        if (next && drag.current === st) {
          appWindow.setPosition(new PhysicalPosition(next.x, next.y)).catch(() => {});
        }
      });
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId === e.pointerId) endDrag();
  }

  // `touch-action: none` keeps the webview from claiming the gesture as a pan
  // or a zoom before we see it — there is nothing to scroll up here anyway.
  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onLostPointerCapture: onPointerUp,
    style: { touchAction: "none" as const },
  };
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const accent = useApp((s) => s.theme.accent);
  // Create the window handle once and keep it stable across renders
  const appWindow = useRef(getCurrentWindow()).current;

  function toggleMaximize() {
    (maximized ? appWindow.unmaximize() : appWindow.maximize()).catch(() => {});
  }

  const dragProps = useTouchDragRegion(toggleMaximize);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  return (
    <div
      data-tauri-drag-region
      {...dragProps}
      className="flex h-9 w-full shrink-0 items-center select-none"
      style={{
        ...dragProps.style,
        background: "var(--color-panel)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <div className="h-full w-1 shrink-0" style={{ background: accent }} />
      <div
        data-tauri-drag-region
        {...dragProps}
        className="flex flex-1 items-center gap-2 px-3 text-xs font-semibold tracking-wide"
        style={{ ...dragProps.style, color: "var(--color-text-muted)" }}
      >
        <span className="pointer-events-none flex items-center gap-2">
          <span style={{ color: accent }} className="font-bold">Multi</span>
          <span>Zone</span>
        </span>
      </div>
      <div className="flex h-full items-stretch">
        <WinBtn title="Minimize" onClick={() => { appWindow.minimize().catch(() => {}); }}>
          <Minus size={12} />
        </WinBtn>
        <WinBtn title={maximized ? "Restore" : "Maximize"} onClick={toggleMaximize}>
          {maximized ? <Square size={11} /> : <Maximize2 size={11} />}
        </WinBtn>
        <WinBtn title="Close" onClick={() => { appWindow.close().catch(() => {}); }} danger>
          <X size={12} />
        </WinBtn>
      </div>
    </div>
  );
}

function WinBtn({
  title, onClick, danger, children,
}: {
  title: string; onClick: () => void; danger?: boolean; children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const bg = hovered ? (danger ? "var(--color-danger)" : "var(--color-panel-hover)") : "transparent";
  const color = hovered && danger ? "white" : "var(--color-text-muted)";

  return (
    <button
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: bg,
        color,
        border: "none",
        outline: "none",
        filter: "none",
        // No double-tap-to-zoom delay before the tap counts as a click.
        touchAction: "manipulation",
      }}
      className="flex h-full w-10 items-center justify-center transition-colors"
    >
      {children}
    </button>
  );
}
