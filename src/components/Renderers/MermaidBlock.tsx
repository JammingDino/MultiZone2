import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";
import {
  Loader2, GitBranch, Wand2, ZoomIn, ZoomOut, RotateCcw, Move,
  ChevronsUpDown, ChevronsDownUp, Maximize2, Minimize2,
} from "lucide-react";
import { useApp } from "@/store/app";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import * as api from "@/lib/tauri";
import { CHROME_QUIET } from "@/lib/chrome";

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.2;
/** The viewport's `p-3`, in px — the frame's inner box excludes it. */
const VIEWPORT_PADDING = 12;
/** Ceiling on the "taller" canvas, as a fraction of the window. Deliberately
 *  short of the whole thing: this is still a block in a conversation, and
 *  fullscreen is one button away. */
const TALL_VIEWPORT_FRACTION = 0.7;
/** How far "taller" will magnify a diagram that is shorter than that ceiling.
 *  The mode fills its height, and for a wide, short diagram — a sequence
 *  diagram especially — filling 70vh unopposed means 3–4x and both edges off
 *  screen. Two is enough to read labels by while most of the width stays put. */
const TALL_MAX_SCALE = 2;

// Cache rendered SVGs by source so remounts (theme changes, rare edge cases)
// reuse the result immediately without re-invoking the mermaid renderer.
const svgCache = new Map<string, string>();

/**
 * Broken source → the repaired source the model returned for it. Remounts and
 * re-groups reuse the known fix instead of paying for another repair request,
 * and it keeps a fix applied while the store still holds stale messages.
 *
 * Repairs are only ever started by the user now (0.12.5) — see
 * `MermaidErrorView`. A diagram that fails to render says so and waits.
 */
const fixCache = new Map<string, string>();

/**
 * Reads the current theme variables from CSS so Mermaid follows whatever
 * scheme the app is in (dark / light / custom accent).
 */
function readThemeVars() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: get("--color-bg", "#0b0d10"),
    panel: get("--color-panel", "#14171c"),
    panelHover: get("--color-panel-hover", "#1b1f25"),
    border: get("--color-border", "#262b33"),
    text: get("--color-text", "#e4e6eb"),
    textMuted: get("--color-text-muted", "#8b929e"),
    accent: get("--color-accent", "#4f9cf9"),
  };
}

function initializeMermaid() {
  const t = readThemeVars();
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: {
      background: "transparent",
      primaryColor: t.panel,
      primaryTextColor: t.text,
      primaryBorderColor: t.border,
      secondaryColor: t.panelHover,
      tertiaryColor: t.bg,
      lineColor: t.textMuted,
      textColor: t.text,
      mainBkg: t.panel,
      nodeBorder: t.border,
      clusterBkg: t.bg,
      clusterBorder: t.border,
      edgeLabelBackground: t.panel,
      fontFamily: 'Inter, -apple-system, "Segoe UI", sans-serif',
      fontSize: "13px",
    },
    flowchart: { useMaxWidth: true, htmlLabels: true, curve: "basis" },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    securityLevel: "loose",
  });
}

let initialized = false;
let lastThemeKey = "";

function ensureInitialized() {
  const t = readThemeVars();
  const key = `${t.bg}|${t.panel}|${t.text}|${t.accent}|${t.border}`;
  if (!initialized || key !== lastThemeKey) {
    initializeMermaid();
    initialized = true;
    lastThemeKey = key;
  }
}

/**
 * Render Mermaid source to a standalone SVG string outside React — used by the
 * PDF export so diagrams appear in the document as diagrams rather than as a
 * blob of source. Shares the component's cache and theme initialization, and
 * returns null instead of throwing when the source doesn't parse.
 */
export async function renderMermaidSvg(source: string): Promise<string | null> {
  const clean = source.trim();
  if (!clean) return null;
  const cached = svgCache.get(clean);
  if (cached) return cached;
  ensureInitialized();
  const id = "mermaid-export-" + Math.random().toString(36).slice(2, 10);
  try {
    const { svg } = await mermaid.render(id, clean);
    const cleaned = svg
      .replace(/(<svg[^>]*?)\s+style="[^"]*background[^"]*"/i, "$1")
      .replace(/background-color:\s*[^;"]+;?/gi, "");
    svgCache.set(clean, cleaned);
    return cleaned;
  } catch {
    return null;
  } finally {
    document.querySelectorAll(`[id^="d${id}"]`).forEach((n) => n.remove());
  }
}

/**
 * Identifies the stored `draw_diagram` call behind this block (0.9.8).
 *
 * Only affects whether a repair is written back to disk: with both ids the
 * corrected source replaces the stored call and survives a reload, without them
 * `fix_diagram` returns the correction for display only. Either way the repair
 * itself works, so a diagram from a fenced code block is repaired the same way
 * as one from a tool call — it just doesn't persist.
 */
export interface MermaidAutoFix {
  chatId: string;
  messageId?: string | null;
  toolCallId?: string | null;
}

export function MermaidBlock({
  source,
  onRenderError,
  autoFix,
}: {
  source: string;
  onRenderError?: () => void;
  autoFix?: MermaidAutoFix;
}) {
  const reactId = useId();
  const renderId = "mermaid-" + reactId.replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const originalSource = source.trim();
  // A repair already known for this source is applied before the first render,
  // so a remount never shows the broken diagram or re-asks the model.
  const [repaired, setRepaired] = useState<string | null>(
    () => fixCache.get(originalSource) ?? null,
  );
  const [repairing, setRepairing] = useState(false);
  // Set when a repair came back no better, so the error view can say so. It
  // still offers to retry: the old one-attempt guard existed because repairs
  // fired on their own and could loop, which they no longer do.
  const [repairFailed, setRepairFailed] = useState(false);
  const cleanSource = repaired ?? originalSource;
  // Held in a ref so a fresh object identity from the parent doesn't re-run the
  // render effect on every re-render.
  const autoFixRef = useRef(autoFix);
  autoFixRef.current = autoFix;

  // A new diagram in the same slot starts over from whatever is known about it.
  useEffect(() => {
    setRepairing(false);
    setRepairFailed(false);
    setRepaired(fixCache.get(originalSource) ?? null);
  }, [originalSource]);

  // The chat whose model does the repairing. The block's own tool call names it
  // when there is one; a fenced diagram belongs to whatever chat is on screen.
  const activeChatId = useApp((s) => s.activeChatId);
  const repairChatId = autoFix?.chatId ?? activeChatId;

  /**
   * Ask the model to correct this source and swap the result in place.
   *
   * The whole repair stays out of the conversation: `fix_diagram` puts the
   * broken source and the parser error to the model on their own, forces one
   * `draw_diagram` call, and writes the answer back over the stored call. No
   * turn is added, nothing is sent as if the user had typed it.
   *
   * Only ever reached from the button in the error view. Until 0.12.5 this ran
   * by itself the moment a diagram failed to parse, which meant a render error
   * silently spent a model request the user hadn't asked for and couldn't
   * decline — and on a chat full of broken diagrams, one per block.
   */
  const requestRepair = useCallback(async (renderError: string) => {
    const target = autoFixRef.current;
    const chatId = target?.chatId ?? repairChatId;
    if (!chatId) return;
    setRepairing(true);
    setRepairFailed(false);
    try {
      // The ids are optional: with them the fix is persisted over the stored
      // tool call, without them it is returned for this session only.
      const fix = await api.fixDiagram({
        chatId,
        messageId: target?.messageId ?? null,
        toolCallId: target?.toolCallId ?? null,
        source: originalSource,
        error: renderError,
      });
      fixCache.set(originalSource, fix.source);
      setRepaired(fix.source);
    } catch (e) {
      // Surface the original error again rather than leaving the user staring
      // at a stalled progress bar.
      console.error("diagram repair failed", e);
      setRepairFailed(true);
    } finally {
      setRepairing(false);
    }
  }, [originalSource, repairChatId]);

  useEffect(() => {
    if (!cleanSource) {
      setLoading(false);
      return;
    }

    // Serve from cache immediately — no spinner, no re-render flicker.
    const cached = svgCache.get(cleanSource);
    if (cached) {
      setSvg(cached);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    ensureInitialized();
    (async () => {
      try {
        const { svg } = await mermaid.render(renderId, cleanSource);
        if (!cancelled) {
          const cleaned = svg
            .replace(/(<svg[^>]*?)\s+style="[^"]*background[^"]*"/i, "$1")
            .replace(/background-color:\s*[^;"]+;?/gi, "");
          svgCache.set(cleanSource, cleaned);
          setSvg(cleaned);
          setLoading(false);
        }
      } catch (e: any) {
        const message = String(e?.message || e);
        document.querySelectorAll(`[id^="d${renderId}"]`).forEach((n) => n.remove());
        if (cancelled) return;
        // Say what went wrong and stop. Correcting it is the user's call — see
        // `requestRepair`.
        setError(message);
        setLoading(false);
        onRenderError?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cleanSource, originalSource, renderId]);

  if (repairing) {
    return <MermaidRepairingView />;
  }

  if (error) {
    return (
      <MermaidErrorView
        error={error}
        source={cleanSource}
        canRepair={!!repairChatId}
        onRepair={() => void requestRepair(error)}
        repairFailed={repairFailed}
      />
    );
  }

  if (loading || !svg) {
    return (
      <div className="my-2 flex items-center gap-3 rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-4 text-xs text-[var(--color-text-muted)]">
        <div className="relative flex h-9 w-9 items-center justify-center">
          <GitBranch
            size={16}
            className="absolute text-[var(--color-text-muted)] opacity-60"
          />
          <Loader2
            size={32}
            className="absolute animate-spin text-[var(--color-accent)] opacity-40"
          />
        </div>
        <div>
          <div className="font-medium text-[var(--color-text)]">
            Rendering diagram…
          </div>
          <div>First render of each diagram type loads its definitions.</div>
        </div>
      </div>
    );
  }

  return <MermaidViewport svg={svg} />;
}

/**
 * Holds the rendered Mermaid SVG and provides zoom (mouse wheel + buttons)
 * and pan (drag) inside the viewport. Resetting returns to fit-to-width.
 *
 * The viewport comes in three sizes. Inline it is short enough to stay a part
 * of the conversation rather than taking it over; "taller" trades that for room
 * when a diagram genuinely needs it; fullscreen gives the diagram the window,
 * which is the only thing that helps a wide sequence diagram — extra height
 * does nothing for one. All three are the same component instance, so zoom and
 * pan survive the switch: opening fullscreen keeps whatever the user had
 * already framed instead of throwing it away.
 */
function MermaidViewport({ svg }: { svg: string }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // The height the block occupied in the thread, held while it is fullscreen.
  const slotRef = useRef<HTMLDivElement>(null);
  const [slotHeight, setSlotHeight] = useState<number | null>(null);
  // Escape leaves fullscreen — through the shared layer stack, so a diagram
  // opened from inside a modal closes itself first and leaves the modal up.
  useDismissOnEscape(fullscreen, () => setFullscreen(false));

  const toggleFullscreen = useCallback(() => {
    if (!fullscreen) setSlotHeight(slotRef.current?.offsetHeight ?? null);
    setFullscreen(!fullscreen);
  }, [fullscreen]);
  // Live state. Refs are used for state that doesn't drive layout — drag origin,
  // active pointers (for pinch detection), the current pinch snapshot — so we
  // can avoid re-rendering on every pointer-move event.
  const dragRef = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{
    startDist: number;
    startZoom: number;
    startPan: { x: number; y: number };
    centerX: number;
    centerY: number;
  } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Height of the taller canvas, in px — sized to the diagram it is showing
  // (see `applyBaseline`). Null until the mode has been opened once.
  const [tallHeight, setTallHeight] = useState<number | null>(null);

  /**
   * The view this mode starts in — what "Reset view" returns to, and what
   * opening a bigger canvas snaps to.
   *
   * Inline, 1 already means "all of it": Mermaid renders responsively, so the
   * SVG has laid itself out to the column width. A bigger canvas is only worth
   * opening if the diagram grows into it, and the two canvases grow it
   * differently because their constraints differ:
   *
   * - Fullscreen has width to spare, so the diagram scales until whichever edge
   *   meets the frame first and all of it stays on screen.
   * - Taller keeps the column's width. Fitting both edges there can only ever
   *   return 1 — the diagram is already exactly as wide as the column — which
   *   is why raising the height cap alone did nothing at all. So it fills the
   *   height instead: a tall diagram shrinks until all of it shows, a short one
   *   magnifies (up to `TALL_MAX_SCALE`) and overflows into a sideways pan.
   *   The canvas is then trimmed to whatever that produced, so the mode never
   *   opens a tall box with the diagram floating in the middle of it.
   */
  const applyBaseline = useCallback(() => {
    const set = (next: number) => {
      setZoom((z) => (Math.abs(z - next) < 0.001 ? z : next));
      setPan((p) => (p.x === 0 && p.y === 0 ? p : { x: 0, y: 0 }));
    };
    if (!fullscreen && !expanded) {
      set(1);
      return;
    }
    const v = viewportRef.current;
    const c = contentRef.current;
    if (!v || !c) return;
    // offsetWidth/Height are layout sizes — the transform we are about to
    // change doesn't affect them, so this doesn't compound across calls.
    const cw = c.offsetWidth;
    const ch = c.offsetHeight;
    if (cw <= 0 || ch <= 0) return;

    if (fullscreen) {
      const boxW = v.clientWidth - VIEWPORT_PADDING * 2;
      const boxH = v.clientHeight - VIEWPORT_PADDING * 2;
      if (boxW <= 0 || boxH <= 0) return;
      set(clamp(Math.min(boxW / cw, boxH / ch), MIN_ZOOM, MAX_ZOOM));
      return;
    }

    // Measured against the ceiling rather than the box's current height, so the
    // height this sets can't feed back into the next measurement.
    const ceiling = window.innerHeight * TALL_VIEWPORT_FRACTION - VIEWPORT_PADDING * 2;
    if (ceiling <= 0) return;
    const scale = clamp(Math.min(TALL_MAX_SCALE, ceiling / ch), MIN_ZOOM, MAX_ZOOM);
    setTallHeight(Math.round(Math.min(ceiling, ch * scale) + VIEWPORT_PADDING * 2));
    set(scale);
  }, [fullscreen, expanded]);

  // The frame resizes in the same commit that flips the mode, so measure on the
  // next frame, once layout has settled around the new box. Re-runs for a new
  // diagram too: a different SVG wants its own starting view.
  useEffect(() => {
    const id = requestAnimationFrame(applyBaseline);
    return () => cancelAnimationFrame(id);
  }, [applyBaseline, svg]);

  const reset = applyBaseline;

  /**
   * Zoom to `next` while keeping the screen point (clientX, clientY) anchored
   * to the same diagram coordinate. Caller passes the zoom/pan that should be
   * treated as the reference — for wheel/button zoom this is the current
   * state, for pinch it's the state captured at the start of the pinch (so
   * cumulative pinch movement stays stable as the user's fingers slide).
   */
  const applyZoomAround = useCallback(
    (
      next: number,
      clientX: number,
      clientY: number,
      fromZoom: number,
      fromPan: { x: number; y: number },
    ) => {
      const v = viewportRef.current;
      if (!v || next === fromZoom) {
        setZoom(next);
        return;
      }
      const rect = v.getBoundingClientRect();
      const cx = clientX - rect.left - rect.width / 2;
      const cy = clientY - rect.top - rect.height / 2;
      setZoom(next);
      setPan({
        x: cx - ((cx - fromPan.x) * next) / fromZoom,
        y: cy - ((cy - fromPan.y) * next) / fromZoom,
      });
    },
    [],
  );

  const zoomBy = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const v = viewportRef.current;
      const rect = v?.getBoundingClientRect();
      const targetX = clientX ?? (rect ? rect.left + rect.width / 2 : 0);
      const targetY = clientY ?? (rect ? rect.top + rect.height / 2 : 0);
      const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
      applyZoomAround(next, targetX, targetY, zoom, pan);
    },
    [zoom, pan, applyZoomAround],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      // Ctrl/cmd + wheel = zoom. Plain wheel scrolls the outer thread.
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      zoomBy(factor, e.clientX, e.clientY);
    },
    [zoomBy],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Track every active pointer so we can pivot between drag and pinch
      // as fingers come down and up.
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      } catch {}
      if (pointersRef.current.size === 2) {
        // Second finger — switch to pinch. Cancel any single-pointer drag.
        const [a, b] = [...pointersRef.current.values()];
        pinchRef.current = {
          startDist: distance(a, b),
          startZoom: zoom,
          startPan: pan,
          centerX: (a.x + b.x) / 2,
          centerY: (a.y + b.y) / 2,
        };
        dragRef.current = null;
      } else if (pointersRef.current.size === 1 && e.button === 0) {
        dragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          panX: pan.x,
          panY: pan.y,
        };
      }
    },
    [pan, zoom],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinch = pinchRef.current;
      if (pinch && pointersRef.current.size >= 2) {
        const [a, b] = [...pointersRef.current.values()];
        const dist = distance(a, b);
        if (pinch.startDist <= 0) return;
        const next = clamp(
          (pinch.startZoom * dist) / pinch.startDist,
          MIN_ZOOM,
          MAX_ZOOM,
        );
        applyZoomAround(
          next,
          pinch.centerX,
          pinch.centerY,
          pinch.startZoom,
          pinch.startPan,
        );
        return;
      }
      const d = dragRef.current;
      if (d && pointersRef.current.size === 1) {
        setPan({
          x: d.panX + (e.clientX - d.startX),
          y: d.panY + (e.clientY - d.startY),
        });
      }
    },
    [applyZoomAround],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {}
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) dragRef.current = null;
  }, []);

  // Either canvas the user opened deliberately, as opposed to the block's
  // resting size in the thread.
  const framed = fullscreen || expanded;

  const frame = (
    <div
      className={
        fullscreen
          ? "relative flex h-full w-full flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]"
          : "relative rounded border border-[var(--color-border)]"
      }
      style={fullscreen ? undefined : { background: "transparent" }}
    >
      <div
        ref={viewportRef}
        className={`flex justify-center overflow-hidden p-3 select-none [&_svg]:max-w-full [&_svg]:!bg-transparent ${
          framed ? "items-center" : ""
        } ${fullscreen ? "min-h-0 flex-1" : ""}`}
        style={{
          touchAction: "none",
          cursor: dragRef.current ? "grabbing" : "grab",
          // Taller is an explicit height, not a larger cap. A cap does nothing
          // at all for a diagram that is already shorter than it — which is
          // most of them, since the SVG lays itself out to the column width —
          // so raising it was the reason the button appeared to be dead.
          height: expanded && !fullscreen && tallHeight != null ? tallHeight : undefined,
          maxHeight: framed ? undefined : "600px",
        }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          ref={contentRef}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
            transition: dragRef.current ? "none" : "transform 80ms linear",
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]/90 p-0.5 text-[var(--color-text-muted)] backdrop-blur">
        <ZoomButton title="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          <ZoomOut size={12} />
        </ZoomButton>
        <span className="px-1 font-mono text-[10px] tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <ZoomButton title="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
          <ZoomIn size={12} />
        </ZoomButton>
        <ZoomButton title="Reset view" onClick={reset}>
          <RotateCcw size={12} />
        </ZoomButton>
        <span className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />
        {/* Height is only worth offering while the diagram is in the thread —
            fullscreen is already as tall as the window goes. */}
        {!fullscreen && (
          <ZoomButton
            title={expanded ? "Shorter view" : "Taller view"}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
          </ZoomButton>
        )}
        <ZoomButton
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </ZoomButton>
      </div>
      <div className="pointer-events-none absolute bottom-1.5 left-2 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] opacity-50">
        <Move size={10} /> drag to pan · ctrl+wheel or pinch to zoom
        {fullscreen && " · esc to exit"}
      </div>
    </div>
  );

  return (
    <>
      {/* Fullscreen moves the diagram out of the thread, so the slot it leaves
          behind holds its height. Otherwise every message below it slides up
          while the user is looking at something else, and slides back down when
          they close it. */}
      <div
        ref={slotRef}
        className="my-2"
        style={fullscreen && slotHeight != null ? { height: slotHeight } : undefined}
      >
        {!fullscreen && frame}
      </div>
      {/* Portalled to the body: the thread is a container-query context, and
          containment would otherwise pin this to the message list rather than
          the window (see `.mz-thread`). */}
      {fullscreen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex bg-black/70 p-4 backdrop-blur-sm"
            onClick={(e) => {
              // Click the backdrop to leave; a click that lands on the frame
              // (including a pan that ends outside it) does not.
              if (e.target === e.currentTarget) setFullscreen(false);
            }}
          >
            {frame}
          </div>,
          document.body,
        )}
    </>
  );
}

function ZoomButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-5 w-5 items-center justify-center rounded ${CHROME_QUIET}`}
    >
      {children}
    </button>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Shown in place of the diagram while a repair the user asked for is in flight. */
function MermaidRepairingView() {
  return (
    <div className="my-2 rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
      <div className="flex items-center gap-3 text-xs">
        <div className="relative flex h-9 w-9 items-center justify-center">
          <GitBranch size={16} className="absolute text-[var(--color-text-muted)] opacity-60" />
          <Wand2
            size={12}
            className="absolute -bottom-0.5 -right-0.5 animate-pulse text-[var(--color-accent)]"
          />
        </div>
        <div>
          <div className="font-medium text-[var(--color-text)]">Tidying up the diagram…</div>
          <div className="text-[var(--color-text-muted)]">
            The model is correcting the syntax. This takes a moment.
          </div>
        </div>
      </div>
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
        <div className="mz-indeterminate h-full w-1/3 rounded-full bg-[var(--color-accent)]" />
      </div>
    </div>
  );
}

/**
 * A diagram that didn't parse, and the offer to do something about it.
 *
 * Nothing here happens on its own, and nothing it does appears in the
 * conversation. The button runs the same quiet `fix_diagram` request the
 * renderer used to fire by itself: the model is shown one broken source and one
 * parser error, and its answer replaces the diagram. It never posts a turn on
 * the user's behalf — a repair is a thing the app does to a diagram, not
 * something the user is made to have said.
 */
function MermaidErrorView({
  error,
  source,
  canRepair,
  onRepair,
  repairFailed,
}: {
  error: string;
  source: string;
  canRepair: boolean;
  onRepair: () => void;
  repairFailed: boolean;
}) {
  return (
    <div className="my-2 rounded border border-[var(--color-danger)] bg-[var(--color-panel)] p-3 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[var(--color-danger)]">Mermaid render error</span>
        {canRepair && (
          <button
            onClick={onRepair}
            title="Ask the model to correct this diagram. Nothing is added to the chat."
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <Wand2 size={11} /> {repairFailed ? "Try again" : "Ask model to fix"}
          </button>
        )}
      </div>
      {repairFailed && (
        <div className="mb-1.5 text-[var(--color-text-muted)]">
          The model couldn't correct this one. Trying again asks it fresh.
        </div>
      )}
      <pre className="whitespace-pre-wrap text-[var(--color-text-muted)]">
        {error}
      </pre>
      <details className="mt-2">
        <summary className="cursor-pointer text-[var(--color-text-muted)]">
          Source
        </summary>
        <pre className="mt-1 whitespace-pre-wrap">{source}</pre>
      </details>
    </div>
  );
}
