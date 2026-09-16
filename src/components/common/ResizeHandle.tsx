import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A draggable edge for a side panel (0.17.10).
 *
 * The sidebar and the workspace panel were fixed at 288px and 340px. A chat
 * list full of long titles and a file viewer beside a chat both want more than
 * that, and a small laptop wants less; the width is the user's to set. The
 * width persists per panel, and the handle stays a four-pixel strip on the
 * panel's inner edge that only shows itself on hover, so the layout looks the
 * same as before until someone reaches for it.
 *
 * Pointer events rather than mouse events, so a touch drag on a tablet works
 * the same way. Capture keeps the drag alive when the pointer outruns the
 * handle, which a fast drag always does.
 */

export function usePanelWidth(key: string, fallback: number, min: number, max: number) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(key);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) ? clamp(n, min, max) : fallback;
    } catch {
      return fallback;
    }
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (dragging) return;
    try { localStorage.setItem(key, String(Math.round(width))); } catch { /* ignore */ }
  }, [key, width, dragging]);

  const set = useCallback((w: number) => setWidth(clamp(w, min, max)), [min, max]);
  const reset = useCallback(() => setWidth(fallback), [fallback]);

  return { width, set, reset, dragging, setDragging };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/**
 * The strip itself. `side` is which edge of its panel it sits on: a handle on
 * the panel's right edge grows the panel as the pointer moves right, one on the
 * left edge grows it as the pointer moves left.
 */
export function ResizeHandle({
  side,
  width,
  onResize,
  onDragging,
  onReset,
  label,
}: {
  side: "left" | "right";
  width: number;
  onResize: (width: number) => void;
  onDragging: (dragging: boolean) => void;
  onReset: () => void;
  label: string;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    start.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
    onDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    onResize(side === "right" ? s.width + dx : s.width - dx);
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    onDragging(false);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      className={`group absolute inset-y-0 z-20 flex w-1.5 cursor-col-resize touch-none select-none ${
        side === "right" ? "right-0 justify-end" : "left-0 justify-start"
      }`}
    >
      {/* Inside the panel's edge rather than straddling it: the sidebar clips
          its overflow, and a handle half outside it is half unreachable. */}
      <div className="h-full w-0.5 bg-[var(--color-accent)] opacity-0 transition-opacity duration-150 group-hover:opacity-60 group-active:opacity-100" />
    </div>
  );
}
