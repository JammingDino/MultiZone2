import { useEffect, useRef, useState, type ReactNode } from "react";
import { Columns2, MessageSquare, Plus, X } from "lucide-react";
import { useApp } from "@/store/app";
import { iconFor } from "@/components/Workspace/FilesPanel";
import {
  HOME_TAB,
  activate,
  chatOf,
  closeTab,
  focusGroup,
  groups,
  isBare,
  isFileTab,
  measure,
  moveTab,
  resizeSplit,
  type Divider,
  type DropZone,
  type Rect,
  type TabLayout,
} from "@/lib/tabLayout";

/** Tab strip height, px — h-9. */
const STRIP = 36;
/** No pane is dragged smaller than this, px. */
const MIN_PANE = 120;

type Target = { groupId: string; zone: DropZone; index?: number; barX?: number };
type Drag = { tab: string; x: number; y: number; target: Target | null };
type Phase = "move" | "drop" | "cancel";

/**
 * Follow a press that may turn into a drag. Window listeners from the press,
 * so a quick flick that leaves the element before it counts as a drag is still
 * followed; the pointer is captured once it does count, so a file's iframe
 * cannot swallow the moves. Pointer events rather than HTML drag-and-drop
 * (which this window has off, for file drops), so it works under touch too.
 * `dragged` is set once it became a drag, for the click that follows to skip.
 */
export function followDrag(
  e: React.PointerEvent<HTMLElement>,
  onDrag: (x: number, y: number, phase: Phase) => void,
  dragged: { current: boolean },
) {
  const el = e.currentTarget;
  const id = e.pointerId;
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  dragged.current = false;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    if (!moved) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      moved = dragged.current = true;
      try { el.setPointerCapture(id); } catch { /* released already */ }
    }
    onDrag(ev.clientX, ev.clientY, "move");
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (moved) onDrag(ev.clientX, ev.clientY, ev.type === "pointerup" ? "drop" : "cancel");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

/** The tiles on screen, for drags that start outside them. */
let tilesDrag: ((tab: string, x: number, y: number, phase: Phase) => void) | null = null;

/**
 * Drag a tab in from outside the tiles — a chat from the sidebar — with the
 * same drop targets and preview as a tab dragged between strips.
 */
export function dragIntoTiles(e: React.PointerEvent<HTMLElement>, tab: string, dragged: { current: boolean }) {
  followDrag(e, (x, y, phase) => tilesDrag?.(tab, x, y, phase), dragged);
}

const pct = (n: number) => `${n * 100}%`;
function nameOf(tab: string): string {
  const id = chatOf(tab);
  if (id) return useApp.getState().chats.find((c) => c.id === id)?.title || "Untitled chat";
  if (tab === HOME_TAB) return "New chat";
  return tab.slice(Math.max(tab.lastIndexOf("/"), tab.lastIndexOf("\\")) + 1);
}

/**
 * The main column as tiles (0.18.3): every group's strip and active tab, each
 * positioned by `measure` as a percentage of the column. Drawn flat and keyed
 * by tab, so dragging a tab to split a group moves boxes around without
 * remounting a chat — its scroll, its draft and a file's running page all
 * survive a rearrangement. The strip hides while one tab is alone, so a
 * window with one chat in it looks exactly as it did.
 */
export function TabTiles({ renderTab }: { renderTab: (tab: string) => ReactNode }) {
  const layout = useApp((s) => s.tabLayout);
  const change = useApp((s) => s.updateTabLayout);
  // Titles are read when drawn; subscribing keeps the strip current as they change.
  useApp((s) => s.chats);
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  // The drop reads this, not `drag`: the pointer listeners outlive the render
  // they were attached in.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d); };

  const { rects, dividers } = measure(layout.root);
  const all = groups(layout.root);
  const strip = isBare(layout) ? 0 : STRIP;
  const bodyStyle = (r: Rect) => ({
    left: pct(r.x), width: pct(r.w), top: `calc(${pct(r.y)} + ${strip}px)`, height: `calc(${pct(r.h)} - ${strip}px)`,
  });
  // Visible tabs in a fixed order, so React never reorders their DOM — moving
  // an iframe's node reloads the page inside it.
  // An empty group (nothing open at all) shows the new-chat screen.
  const shown = all.map((g) => ({ tab: g.active || HOME_TAB, gid: g.id })).sort((a, b) => (a.tab < b.tab ? -1 : 1));

  /** Which group, and which part of it, is under the pointer. */
  function hit(x: number, y: number): Target | null {
    const c = box.current?.getBoundingClientRect();
    if (!c) return null;
    for (const g of all) {
      const r = rects[g.id];
      const left = c.left + r.x * c.width, top = c.top + r.y * c.height;
      const w = r.w * c.width, h = r.h * c.height;
      if (x < left || x > left + w || y < top || y > top + h) continue;
      if (y - top < strip) {
        const tabs = [...(box.current!.querySelectorAll<HTMLElement>(`[data-group="${g.id}"] [data-tab]`))];
        let index = tabs.findIndex((t) => { const b = t.getBoundingClientRect(); return x < b.left + b.width / 2; });
        if (index < 0) index = tabs.length;
        const edge = tabs[index]?.getBoundingClientRect().left ?? tabs[tabs.length - 1]?.getBoundingClientRect().right ?? left;
        return { groupId: g.id, zone: "center", index, barX: edge - c.left };
      }
      const bx = (x - left) / w, by = (y - top - strip) / (h - strip);
      const edges: [DropZone, number][] = [["left", bx], ["right", 1 - bx], ["top", by], ["bottom", 1 - by]];
      const [zone, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
      return { groupId: g.id, zone: d < 0.3 ? zone : "center" };
    }
    return null;
  }

  function drop() {
    const d = dragRef.current;
    if (d?.target) {
      const t = d.target;
      change((l) => moveTab(l, d.tab, t.groupId, t.zone, t.index));
    }
    setDrag(null);
  }

  const onDrag = (tab: string, x: number, y: number, phase: Phase) =>
    phase === "drop" ? drop() : setDrag(phase === "cancel" ? null : { tab, x, y, target: hit(x, y) });
  // Re-registered every render, so an outside drag always hit-tests against
  // the layout on screen now.
  useEffect(() => {
    tilesDrag = onDrag;
    return () => { if (tilesDrag === onDrag) tilesDrag = null; };
  });

  const target = drag?.target;
  const tr = target && rects[target.groupId];

  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
      {strip > 0 && all.map((g) => {
        const r = rects[g.id];
        return (
          <div
            key={g.id}
            data-group={g.id}
            onPointerDownCapture={() => change((l) => focusGroup(l, g.id))}
            className="absolute flex border-b border-[var(--color-border)] bg-[var(--color-panel)]"
            style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: STRIP }}
          >
            {/* Scrolls sideways rather than squeezing, so a narrow pane with
                many tabs never shrinks them to an ellipsis. */}
            <div className="hide-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
              {g.tabs.map((tab) => (
                <Tab
                  key={tab}
                  tab={tab}
                  active={g.active === tab}
                  focused={layout.focused === g.id || all.length === 1}
                  onActivate={() => change((l) => activate(l, g.id, tab))}
                  onClose={() => change((l) => closeTab(l, tab))}
                  onDrag={(x, y, phase) => onDrag(tab, x, y, phase)}
                />
              ))}
            </div>
            {g.tabs.length > 1 && (
              <button
                onClick={() => change((l) => moveTab(l, g.active, g.id, "right"))}
                title="Split: move this tab to a new pane on the right. Or drag any tab onto a pane's edge."
                className="flex shrink-0 items-center px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                <Columns2 size={13} />
              </button>
            )}
          </div>
        );
      })}

      {shown.map(({ tab, gid }) => (
        <div
          key={tab}
          onPointerDownCapture={() => change((l) => focusGroup(l, gid))}
          className="absolute flex flex-col overflow-hidden"
          style={bodyStyle(rects[gid])}
        >
          {renderTab(tab)}
        </div>
      ))}

      {dividers.map((d) => (
        <SplitHandle key={`${d.splitId}:${d.index}`} d={d} box={box} onSizes={(s) => change((l) => resizeSplit(l, d.splitId, s))} />
      ))}

      {tr && (
        target.zone === "center" && target.barX !== undefined ? (
          <div className="pointer-events-none absolute z-30 w-0.5 bg-[var(--color-accent)]" style={{ left: target.barX, top: pct(tr.y), height: STRIP }} />
        ) : (
          <div
            className="pointer-events-none absolute z-30 rounded border-2 border-[var(--color-accent)] bg-[var(--color-accent)]/15 transition-all duration-100"
            style={dropStyle(tr, target.zone, strip)}
          />
        )
      )}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs shadow-lg"
          style={{ left: drag.x + 12, top: drag.y + 8 }}
        >
          {nameOf(drag.tab)}
        </div>
      )}
    </div>
  );
}

/** The half (or whole) of a group's body a drop would fill. */
function dropStyle(r: Rect, zone: DropZone, strip: number) {
  const x = pct(r.x), y = `calc(${pct(r.y)} + ${strip}px)`;
  const w = r.w, h = `(${pct(r.h)} - ${strip}px)`;
  switch (zone) {
    case "left": return { left: x, top: y, width: pct(w / 2), height: `calc${h}` };
    case "right": return { left: pct(r.x + w / 2), top: y, width: pct(w / 2), height: `calc${h}` };
    case "top": return { left: x, top: y, width: pct(w), height: `calc(${h} / 2)` };
    case "bottom": return { left: x, top: `calc(${y} + ${h} / 2)`, width: pct(w), height: `calc(${h} / 2)` };
    default: return { left: x, top: y, width: pct(w), height: `calc${h}` };
  }
}

function Tab({
  tab,
  active,
  focused,
  onActivate,
  onClose,
  onDrag,
}: {
  tab: string;
  active: boolean;
  focused: boolean;
  onActivate: () => void;
  onClose?: () => void;
  onDrag: (x: number, y: number, phase: Phase) => void;
}) {
  const dragged = useRef(false);
  const label = nameOf(tab);
  const { Icon, color } = chatOf(tab)
    ? { Icon: MessageSquare, color: undefined }
    : tab === HOME_TAB
      ? { Icon: Plus, color: undefined }
      : iconFor(label);

  return (
    <div
      data-tab
      onPointerDown={(e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest("[data-close]")) followDrag(e, onDrag, dragged);
      }}
      // Middle-click anywhere on the tab closes it, as it does everywhere else
      // that has tabs. `onMouseDown` only to stop Windows dropping into
      // autoscroll; the close is on `onAuxClick`, which is the event a
      // non-primary button actually completes on.
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={(e) => { if (e.button === 1) onClose?.(); }}
      className={`flex h-9 shrink-0 cursor-default touch-none select-none items-center gap-1.5 border-b-2 border-r border-r-[var(--color-border)] pl-2.5 text-xs ${
        onClose ? "pr-1" : "pr-2.5"
      } ${
        active
          ? `${focused ? "border-b-[var(--color-accent)]" : "border-b-[var(--color-text-muted)]"} bg-[var(--color-bg)] text-[var(--color-text)]`
          : "border-b-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
      }`}
    >
      <button
        onClick={() => { if (!dragged.current) onActivate(); }}
        title={`${isFileTab(tab) ? tab : label} · drag to move or split`}
        className="flex min-w-0 items-center gap-1.5"
      >
        <span className="flex shrink-0"><Icon size={12} style={color ? { color } : undefined} /></span>
        <span className="max-w-[10rem] truncate">{label}</span>
      </button>
      {onClose && (
        <button
          data-close
          onClick={onClose}
          title="Close this tab"
          aria-label={`Close ${label}`}
          className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)]"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

/** The line between two panes; drag to share the space differently, double-click to even it. */
function SplitHandle({ d, box, onSizes }: { d: Divider; box: React.RefObject<HTMLDivElement | null>; onSizes: (s: number[]) => void }) {
  const start = useRef<{ p: number; sizes: number[]; px: number } | null>(null);
  const row = d.dir === "row";
  const i = d.index;

  function sizesFor(delta: number, base: number[], px: number) {
    const min = MIN_PANE / px;
    const pair = base[i] + base[i + 1];
    const a = Math.min(Math.max(base[i] + delta, min), pair - min);
    const next = [...base];
    next[i] = a;
    next[i + 1] = pair - a;
    return next;
  }

  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      title="Drag to resize · double-click to even out"
      onPointerDown={(e) => {
        const c = box.current?.getBoundingClientRect();
        if (e.button !== 0 || !c) return;
        e.preventDefault();
        start.current = { p: row ? e.clientX : e.clientY, sizes: d.sizes, px: row ? c.width * d.span.w : c.height * d.span.h };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s) onSizes(sizesFor(((row ? e.clientX : e.clientY) - s.p) / s.px, s.sizes, s.px));
      }}
      onPointerUp={() => { start.current = null; }}
      onPointerCancel={() => { start.current = null; }}
      onDoubleClick={() => {
        const half = (d.sizes[i] + d.sizes[i + 1]) / 2;
        onSizes(d.sizes.map((s, j) => (j === i || j === i + 1 ? half : s)));
      }}
      className={`group absolute z-20 flex touch-none select-none justify-center ${
        row ? "w-1.5 -translate-x-1/2 cursor-col-resize" : "h-1.5 -translate-y-1/2 cursor-row-resize flex-col"
      }`}
      style={
        row
          ? { left: pct(d.at), top: pct(d.span.y), height: pct(d.span.h) }
          : { top: pct(d.at), left: pct(d.span.x), width: pct(d.span.w) }
      }
    >
      <div className={`${row ? "h-full w-px" : "h-px w-full"} bg-[var(--color-border)] group-hover:bg-[var(--color-accent)] group-active:bg-[var(--color-accent)]`} />
    </div>
  );
}
