import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
function useTouchDragRegion(onToggleMaximize: () => void) {
  const appWindow = useRef(getCurrentWindow()).current;
  const suppressMouseUntil = useRef(0);
  const lastTap = useRef({ at: 0, x: 0, y: 0 });

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

    if (doubleTap) onToggleMaximize();
    else appWindow.startDragging().catch(() => {});
  }

  // `touch-action: none` keeps the webview from claiming the gesture as a pan
  // or a zoom before we see it — there is nothing to scroll up here anyway.
  return { onPointerDown, style: { touchAction: "none" as const } };
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
