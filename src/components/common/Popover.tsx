import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";

/**
 * Every floating surface in the app — dropdowns, pickers, right-click menus.
 *
 * They were each written as `absolute right-0 top-full` inside their trigger,
 * which has two failure modes and the app hit both (#12): an ancestor with
 * `overflow: hidden` (the sidebar, a scroll container) clips the menu, and a
 * trigger near the bottom or right of the window opens a menu that extends past
 * the edge with no way to reach the rest of it.
 *
 * This positions in the viewport instead: the surface is portalled to `body` so
 * no ancestor can clip it, then flipped and clamped against the window, and
 * capped to the space actually available so a long list scrolls rather than
 * overflowing. Callers keep their own contents and colours; only the geometry
 * is shared.
 */

/** Breathing room kept between a floating surface and the window edge. */
const MARGIN = 8;
/** Gap between a surface and the control it hangs off. */
const OFFSET = 4;
/** Nothing shorter than this is worth showing — below it, overlap the anchor. */
const MIN_HEIGHT = 120;

export type PopoverSide = "bottom" | "top";
export type PopoverAlign = "start" | "end" | "center";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PlacementResult {
  left: number;
  top: number;
  maxHeight: number;
  /** Which side the surface actually landed on, after any flip. */
  side: PopoverSide;
}

/**
 * Where a surface of `size` should sit relative to `anchor` inside `viewport`.
 *
 * Pure, and kept apart from the component, because this is the part that is
 * easy to get subtly wrong and worth reading on its own.
 */
export function placeMenu(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { side: PopoverSide; align: PopoverAlign; matchAnchorWidth?: boolean },
): PlacementResult {
  const width = opts.matchAnchorWidth ? Math.max(size.width, anchor.width) : size.width;

  // Vertical: prefer the requested side, flip when the other one has materially
  // more room, and never report a max height below what a couple of rows need —
  // a cramped surface scrolls, it does not vanish.
  const roomBelow = viewport.height - anchor.bottom - OFFSET - MARGIN;
  const roomAbove = anchor.top - OFFSET - MARGIN;
  let side = opts.side;
  const preferredRoom = side === "bottom" ? roomBelow : roomAbove;
  const otherRoom = side === "bottom" ? roomAbove : roomBelow;
  if (size.height > preferredRoom && otherRoom > preferredRoom) {
    side = side === "bottom" ? "top" : "bottom";
  }
  const room = side === "bottom" ? roomBelow : roomAbove;
  const maxHeight = Math.max(MIN_HEIGHT, Math.min(size.height, room));
  const top =
    side === "bottom"
      ? Math.min(anchor.bottom + OFFSET, viewport.height - MARGIN - maxHeight)
      : Math.max(MARGIN, anchor.top - OFFSET - maxHeight);

  // Horizontal: align as asked, then slide back inside the window. Clamping
  // after aligning means an edge-anchored menu shifts along the edge instead of
  // hanging off it.
  let left =
    opts.align === "end"
      ? anchor.right - width
      : opts.align === "center"
        ? anchor.left + anchor.width / 2 - width / 2
        : anchor.left;
  left = Math.min(left, viewport.width - MARGIN - width);
  left = Math.max(MARGIN, left);

  return { left, top: Math.max(MARGIN, top), maxHeight, side };
}

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

/** A click point, as a zero-size anchor — what a right-click menu hangs off. */
export function pointRect(x: number, y: number): Rect {
  return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
}

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The control the surface hangs off. Ignored when `anchorRect` is given. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** An explicit anchor — use `pointRect` for right-click menus. */
  anchorRect?: Rect;
  side?: PopoverSide;
  align?: PopoverAlign;
  /** Grow the surface to at least the anchor's width (comboboxes). */
  matchAnchorWidth?: boolean;
  /** Classes for the surface itself. Geometry is owned here; the rest is yours. */
  className?: string;
  /** Stacking layer. Menus opened from inside a modal need to clear it. */
  zIndex?: number;
  /** A transparent catcher behind the surface, so a click anywhere closes it. */
  backdrop?: boolean;
  children: ReactNode;
}

export function Popover({
  open,
  onClose,
  anchorRef,
  anchorRect,
  side = "bottom",
  align = "start",
  matchAnchorWidth,
  className = "",
  zIndex = 60,
  backdrop = true,
  children,
}: PopoverProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PlacementResult | null>(null);

  useDismissOnEscape(open, onClose);

  const measure = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const anchor = anchorRect ?? (anchorRef?.current ? rectOf(anchorRef.current) : null);
    if (!anchor) return;
    // Height is read from `scrollHeight` — what the content wants — rather than
    // the box we already capped, so a re-measure doesn't ratchet a long list
    // down a little further every time.
    const next = placeMenu(
      anchor,
      { width: surface.offsetWidth, height: surface.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
      { side, align, matchAnchorWidth },
    );
    setPos((prev) =>
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.maxHeight === next.maxHeight &&
      prev.side === next.side
        ? prev
        : next,
    );
  }, [anchorRect, anchorRef, side, align, matchAnchorWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    measure();
    // Anything that moves the anchor moves the surface: the window resizing, a
    // scroll container underneath it (capture phase, because scroll events from
    // a nested container don't bubble), or the contents themselves growing as a
    // search box filters the list.
    const remeasure = () => measure();
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    const ro = new ResizeObserver(remeasure);
    if (surfaceRef.current) ro.observe(surfaceRef.current);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
      ro.disconnect();
    };
  }, [open, measure]);

  if (!open) return null;

  const anchorWidth = matchAnchorWidth
    ? (anchorRect ?? (anchorRef?.current ? rectOf(anchorRef.current) : null))?.width
    : undefined;

  return createPortal(
    <>
      {backdrop && (
        <div
          className="fixed inset-0"
          style={{ zIndex }}
          onClick={onClose}
          onContextMenu={(e) => {
            e.preventDefault();
            onClose();
          }}
        />
      )}
      <div
        ref={surfaceRef}
        // Marks the surface for callers that run their own outside-click check:
        // portalled contents are not inside the trigger's subtree, so a plain
        // `contains` test reads a click on a menu row as a click outside.
        data-mz-popover=""
        className={`fixed overflow-y-auto overscroll-contain ${className}`}
        style={{
          zIndex: zIndex + 1,
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          maxHeight: pos?.maxHeight,
          maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
          minWidth: anchorWidth,
          // Until the first measurement lands the surface has no honest place to
          // be; painting it at 0,0 for a frame reads as a flicker in the corner.
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
