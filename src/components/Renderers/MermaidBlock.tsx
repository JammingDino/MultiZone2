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

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.2;

// Cache rendered SVGs by source so remounts (theme changes, rare edge cases)
// reuse the result immediately without re-invoking the mermaid renderer.
const svgCache = new Map<string, string>();

/**
 * Broken source → the repaired source the model returned for it. Remounts and
 * re-groups reuse the known fix instead of paying for another repair request,
 * and it keeps a persisted fix applied while the store still holds stale
 * messages.
 */
const fixCache = new Map<string, string>();
/** Sources whose repair failed. One attempt each — never loop on a bad diagram. */
const fixFailed = new Set<string>();

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
 * Identifies the stored `draw_diagram` call behind this block, enabling the
 * hidden auto-repair path (0.9.8). Absent for diagrams from fenced code blocks,
 * which have no tool call to correct — those fall back to the manual button.
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
  const cleanSource = repaired ?? originalSource;
  // Whether this block has already spent its one repair attempt.
  const attemptedRef = useRef(false);
  // Held in a ref so a fresh object identity from the parent doesn't re-run the
  // render effect (and re-trigger a repair) on every re-render.
  const autoFixRef = useRef(autoFix);
  autoFixRef.current = autoFix;

  // A new diagram in the same slot starts over from whatever is known about it.
  useEffect(() => {
    attemptedRef.current = false;
    setRepairing(false);
    setRepaired(fixCache.get(originalSource) ?? null);
  }, [originalSource]);

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

        // One silent repair attempt before the user is told anything: the model
        // gets this source and this error, nothing else, and the block shows a
        // progress bar until it comes back.
        const target = autoFixRef.current;
        const canRepair =
          !!target &&
          !attemptedRef.current &&
          !fixFailed.has(originalSource) &&
          cleanSource === originalSource;
        if (canRepair && target) {
          attemptedRef.current = true;
          setRepairing(true);
          setLoading(false);
          try {
            const fix = await api.fixDiagram({
              chatId: target.chatId,
              messageId: target.messageId ?? null,
              toolCallId: target.toolCallId ?? null,
              source: originalSource,
              error: message,
            });
            fixCache.set(originalSource, fix.source);
            if (!cancelled) {
              setRepairing(false);
              setRepaired(fix.source);
            }
            return;
          } catch (fixError) {
            // The repair failed — fall through and surface the original error
            // rather than leaving the user staring at a stalled bar.
            console.error("diagram auto-repair failed", fixError);
            fixFailed.add(originalSource);
            if (cancelled) return;
            setRepairing(false);
          }
        }

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
        repairAttempted={attemptedRef.current}
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

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

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
          fullscreen ? "min-h-0 flex-1 items-center" : ""
        }`}
        style={{
          touchAction: "none",
          cursor: dragRef.current ? "grabbing" : "grab",
          // Capped against the window rather than at a taller fixed pixel
          // height: a viewport that doesn't fit on screen just moves the
          // scrolling problem from inside the diagram to outside it.
          maxHeight: fullscreen ? undefined : expanded ? "85vh" : "600px",
        }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
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
      className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
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

/**
 * Shown in place of the diagram while the hidden repair request is in flight.
 * The failure itself is not surfaced yet — if the repair lands, the user only
 * ever sees a brief progress bar and then the working diagram.
 */
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
            The syntax needed a correction. This takes a moment.
          </div>
        </div>
      </div>
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
        <div className="mz-indeterminate h-full w-1/3 rounded-full bg-[var(--color-accent)]" />
      </div>
    </div>
  );
}

function MermaidErrorView({
  error,
  source,
  repairAttempted,
}: {
  error: string;
  source: string;
  repairAttempted?: boolean;
}) {
  const chatId = useApp((s) => s.activeChatId);
  const isStreaming = useApp((s) =>
    chatId ? Boolean(s.streamingByChat[chatId]) : false,
  );
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  async function requestFix() {
    if (!chatId || isStreaming || state !== "idle") return;
    setState("sending");
    try {
      await api.sendMessage(chatId, [
        { type: "text", text: buildCorrectionMessage(error, source) },
      ]);
      setState("sent");
    } catch (e) {
      console.error("fix request failed", e);
      setState("idle");
    }
  }

  return (
    <div className="my-2 rounded border border-[var(--color-danger)] bg-[var(--color-panel)] p-3 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[var(--color-danger)]">Mermaid render error</span>
        {state === "sending" && (
          <span className="flex items-center gap-1 text-[var(--color-text-muted)]">
            <Loader2 size={11} className="animate-spin" /> Asking the model to fix it…
          </span>
        )}
        {state === "sent" && (
          <span className="text-[var(--color-text-muted)]">Sent error to model.</span>
        )}
        {state === "idle" && (
          <button
            onClick={requestFix}
            disabled={isStreaming}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Wand2 size={11} /> Ask model to fix
          </button>
        )}
      </div>
      {repairAttempted && (
        <div className="mb-1.5 text-[var(--color-text-muted)]">
          An automatic repair was attempted in the background and didn't work.
          Sending the error back into the conversation gives the model the full
          context to try again.
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

function buildCorrectionMessage(error: string, source: string): string {
  return (
    `Your last Mermaid diagram failed to render. Please call \`draw_diagram\` again with corrected syntax.\n\n` +
    `**Parser error:**\n\`\`\`\n${error}\n\`\`\`\n\n` +
    `**Source you produced:**\n\`\`\`mermaid\n${source}\n\`\`\`\n\n` +
    `**Common pitfalls to check:**\n` +
    `- Don't put LaTeX or MathJax (\`$...$\`, \`\\frac\`, etc.) inside node labels — Mermaid's parser does not understand them. Use plain text or HTML entities instead, or omit the math from the diagram and describe it in surrounding prose.\n` +
    `- Don't use unescaped parentheses, brackets, or quotes inside node labels.\n` +
    `- For line breaks inside a label, use \`<br/>\`, not \`\\n\`.\n` +
    `- Subgraph titles with special characters must be wrapped in double quotes.\n` +
    `- Only call \`draw_diagram\` once with the corrected source; do not include any other tool calls in this response.`
  );
}
