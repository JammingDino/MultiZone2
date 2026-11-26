import "@danfessler/trellis/style.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GraduationCap, MessageSquare, PanelLeft, Plus, Repeat } from "lucide-react";
import { ViewType, Workspace, useView, useViewBadge, useViewTitle, type MenuEntry, type WorkspaceHandle } from "@danfessler/trellis-react";
import { Sidebar } from "@/components/Sidebar/Sidebar";
import { SectionBody, TABS as SECTIONS, usePlanFocus } from "@/components/Workspace/WorkspacePanel";
import { useIsNarrow } from "@/lib/useIsNarrow";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { iconFor } from "@/components/Workspace/FilesPanel";
import {
  DEFAULT_SECTIONS, HOME_TAB, SIDEBAR_TAB, allGroups, chatOf, closeTab, closeWhere, dockPanel, sectionTab, focusGroup, focusedGroup, groupOf,
  isPanelTab, moveTab, sectionOf, studyOf, type DropZone, type Section, type TabLayout,
} from "@/lib/tabLayout";
import { fromDocument, toDocument } from "@/lib/trellisLayout";

type Phase = "move" | "drop" | "cancel";

/**
 * Follow a press that may turn into a drag. Window listeners from the press,
 * so a quick flick that leaves the element before it counts as a drag is still
 * followed; the pointer is captured once it does count. Pointer events rather
 * than HTML drag-and-drop (which this window has off, for file drops).
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
 * Drag a tab in from outside the tiles — a chat from the sidebar — onto a
 * pane: into it, or onto an edge to open it beside what is there.
 */
export function dragIntoTiles(e: React.PointerEvent<HTMLElement>, tab: string, dragged: { current: boolean }) {
  followDrag(e, (x, y, phase) => tilesDrag?.(tab, x, y, phase), dragged);
}

function nameOf(tab: string, s: ReturnType<typeof useApp.getState>): string {
  const id = chatOf(tab);
  if (id) return s.chats.find((c) => c.id === id)?.title || "Untitled chat";
  if (tab === HOME_TAB) return "New chat";
  if (tab === SIDEBAR_TAB) return "Chats";
  const section = sectionOf(tab);
  if (section) return SECTION_NAMES[section];
  const study = studyOf(tab);
  if (study) return s.studyTabTitles[tab] || (study.kind === "review" ? "Review" : "Study");
  return tab.slice(Math.max(tab.lastIndexOf("/"), tab.lastIndexOf("\\")) + 1);
}

const SECTION_NAMES: Record<Section, string> = {
  files: "Files", plan: "Plan", chat: "This chat", terminals: "Terminals", context: "Context", study: "Study",
};

/**
 * On a phone the sidebar and the workspace stay drawers over the chat — two
 * panes beside it would leave it no width — so Trellis is not shown them, and
 * what it reports back has them put back where they were docked.
 */
const withoutPanels = (l: TabLayout) => closeWhere(l, isPanelTab);
function keepPanels(next: TabLayout, cur: TabLayout): TabLayout {
  const had = allGroups(cur).flatMap((g) => g.tabs).filter(isPanelTab);
  if (had.includes(SIDEBAR_TAB)) next = dockPanel(next, [SIDEBAR_TAB], "left", 0.2);
  const sections = had.filter((t) => sectionOf(t));
  return sections.length ? dockPanel(next, sections, "right", 0.26) : next;
}

// Trellis draws with the app's own colours, so a theme or accent change in
// Settings reaches the tiles too.
const TOKENS: Record<string, string> = {
  "--trellis-bg": "var(--color-bg)",
  "--trellis-stage": "var(--color-bg)",
  "--trellis-slot": "var(--color-bg)",
  "--trellis-panel": "var(--color-bg)",
  "--trellis-tabbar": "var(--color-panel)",
  "--trellis-tab-active": "var(--color-bg)",
  "--trellis-tab-hover": "var(--color-panel-hover)",
  "--trellis-menu": "var(--color-panel)",
  "--trellis-menu-hover": "var(--color-panel-hover)",
  "--trellis-text": "var(--color-text)",
  "--trellis-text-muted": "var(--color-text-muted)",
  "--trellis-border": "var(--color-border)",
  "--trellis-accent": "var(--color-accent)",
  "--trellis-font": "inherit",
  "--trellis-font-size": "12px",
};

/**
 * The window (0.21.0): chats, files, study sets, the new-chat screen, the
 * sidebar and each workspace section as Trellis views — dragged between
 * panels, split onto edges, stacked as tabs, floated out as windows and docked
 * back. The store's `TabLayout` stays the model the app's
 * rules work on (lib/tabLayout.ts); this keeps Trellis and it in step. A
 * change made in the tiles comes back as a document; a change made anywhere
 * else (the sidebar, a shortcut, a tool) is handed to Trellis to draw.
 */
export function Tiles({ renderTab, renderBar }: {
  renderTab: (tab: string) => ReactNode;
  /** A chat's controls, at the end of its pane's tab bar. */
  renderBar: (tab: string) => ReactNode;
}) {
  const layout = useApp((s) => s.tabLayout);
  const change = useApp((s) => s.updateTabLayout);
  const mode = useApp((s) => s.theme.mode);
  const narrow = useIsNarrow();
  const shown = narrow ? withoutPanels(layout) : layout;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const activeChatId = useApp((s) => s.activeChatId);
  // The phone's drawer runs its own (WorkspacePanel).
  usePlanFocus(narrow ? null : activeChatId);
  const [ws, setWs] = useState<WorkspaceHandle | null>(null);
  const host = useRef<HTMLDivElement>(null);
  // The layout the tiles last reported, so it is not handed straight back.
  const fromTiles = useRef<TabLayout | null>(null);
  const initial = useMemo(() => toDocument(shown), []); // eslint-disable-line react-hooks/exhaustive-deps

  function take(reported: TabLayout) {
    const cur = useApp.getState().tabLayout;
    const next = narrowRef.current ? keepPanels(reported, cur) : reported;
    if (JSON.stringify(next) === JSON.stringify(cur)) return;
    fromTiles.current = next;
    change(() => next);
  }

  useEffect(() => {
    if (!ws) return;
    // Compared, not assumed: what Trellis shows can differ from the store's
    // layout without the layout changing — a window widened past the phone
    // breakpoint now has panes to show.
    const drawn = fromDocument(ws.getDocument(), shown.focused);
    if (JSON.stringify(drawn) !== JSON.stringify(shown)) ws.setDocument(toDocument(shown));
    // A change the tiles made already has focus where the user put it.
    if (layout === fromTiles.current) return;
    // The empty group (nothing open) is not a panel Trellis has.
    const g = focusedGroup(shown);
    if (g.tabs.length && ws.getSnapshot().focusedPanel !== g.id) ws.focus(g.id);
  }, [ws, layout, narrow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Moving around the panes from the keyboard (0.21.0).
  useEffect(() => {
    if (!ws) return;
    const onKey = (e: KeyboardEvent) => paneKeys(e, ws);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws]);

  // The backend keeps the last layout for GET /api/layout (0.21.0).
  useEffect(() => {
    const t = window.setTimeout(() => void api.reportLayout(layout).catch(() => {}), 300);
    return () => window.clearTimeout(t);
  }, [layout]);

  // Drags from the sidebar: the pane under the pointer, and which part of it.
  const [drop, setDrop] = useState<{ tab: string; x: number; y: number; target: Target | null } | null>(null);
  const dropRef = useRef(drop);
  dropRef.current = drop;
  useEffect(() => {
    tilesDrag = (tab, x, y, phase) => {
      if (phase === "move") return setDrop({ tab, x, y, target: hit(x, y, host.current) });
      const t = dropRef.current?.target;
      setDrop(null);
      if (phase === "drop" && t) change((l) => moveTab(l, tab, t.panelId ?? l.root.id, t.zone));
    };
    return () => { tilesDrag = null; };
  }, [change]);

  const kinds = ["chat", "home", "study", "file", "sidebar", "section"] as const;
  return (
    <div ref={host} className="relative min-h-0 flex-1 overflow-hidden">
      <Workspace
        ref={setWs}
        theme={mode === "light" ? "light" : "dark"}
        tokens={TOKENS}
        defaultLayout={initial}
        // No Hide: the app has no tray to bring a hidden pane back from.
        panelMenu={(entries) => entries.filter((e) => e === "separator" || e.id !== "hide")}
        keymap={{ "navigation.stepOut": null }}
        tabs={{ inset: 0 }}
        label="Workspace"
        onDocumentChange={(doc) => take(fromDocument(doc, useApp.getState().tabLayout.focused))}
        onFocus={(viewId) => {
          const l = useApp.getState().tabLayout;
          // The sidebar and the sections take focus to be used, but a chat
          // or a file still opens where the user last was.
          const g = viewId && !isPanelTab(viewId) ? groupOf(l, viewId) : undefined;
          if (g) take(focusGroup(l, g.id));
        }}
      >
        {kinds.map((k) => (
          <ViewType
            key={k}
            id={k}
            title={(v) => nameOf(v.id, useApp.getState())}
            icon={<TabIcon />}
            menu={MENUS[k]}
            accessory={k === "chat" ? (v) => renderBar(v.id) : undefined}
          >
            <Tile render={renderTab} />
          </ViewType>
        ))}
        <Workspace.Empty>
          <div className="flex h-full min-h-0 flex-col">{renderTab(HOME_TAB)}</div>
        </Workspace.Empty>
        {/* Only windows open: the new-chat screen behind them, not a blank column. */}
        {shown.root.kind === "group" && shown.root.tabs.length === 0 && shown.floating?.length ? (
          <Workspace.Backdrop>
            <div className="flex h-full min-h-0 flex-col">{renderTab(HOME_TAB)}</div>
          </Workspace.Backdrop>
        ) : null}
      </Workspace>
      {drop?.target && <DropPreview target={drop.target} />}
      {drop && (
        <div
          className="pointer-events-none fixed z-50 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs shadow-lg"
          style={{ left: drop.x + 12, top: drop.y + 8 }}
        >
          {nameOf(drop.tab, useApp.getState())}
        </div>
      )}
    </div>
  );
}

// What the sidebar's own header used to hold, in its pane's menu (0.21.0).
const SIDEBAR_MENU = [
  {
    label: "New chat",
    shortcut: "Ctrl+N",
    run: () => {
      const s = useApp.getState();
      s.triggerNewChat(null);
      void s.setActiveChat(null);
    },
  },
  { label: "Search chats", run: () => useApp.getState().focusChatSearch() },
  { label: "New project", run: () => useApp.getState().openProjectsPanel("__new__") },
  "separator" as const,
];

// A chat's pane has no header of its own (0.21.0); what is not in its tab
// bar is here. Read when the menu opens, so the ticks are current.
function chatMenu(view: { id: string }): MenuEntry[] {
  const id = chatOf(view.id);
  if (!id) return [];
  const s = useApp.getState();
  return [
    { label: "Rename…", run: () => renameChat(id) },
    { label: "View replay session", run: () => s.openReplay(id) },
    { label: "Workspace", checked: s.workspaceOpen, run: () => s.setWorkspaceOpen(!s.workspaceOpen) },
    "separator",
  ];
}

function renameChat(id: string) {
  const s = useApp.getState();
  const old = s.chats.find((c) => c.id === id)?.title ?? "";
  const title = window.prompt("Rename chat", old)?.trim();
  if (!title || title === old) return;
  api.renameChat(id, title)
    .then(() => {
      s.setChatTitle(id, title);
      return s.refreshChats();
    })
    .catch(console.error);
}

// The file viewer's toolbar keeps what is used while reading; the rest is here.
function fileMenu(view: { id: string }): MenuEntry[] {
  return [
    { label: "Open in the default app", run: () => void api.openPath(view.id).catch(console.warn) },
    { label: "Show in the file manager", run: () => void api.revealPath(view.id).catch(console.warn) },
    "separator",
  ];
}

// A closed workspace tab comes back from here, ticked ones close: without it,
// the only way back to one was closing the whole group and reopening it.
function sectionMenu(): MenuEntry[] {
  const s = useApp.getState();
  const open = new Set(allGroups(s.tabLayout).flatMap((g) => g.tabs));
  // Study only belongs to study projects; it is listed once it is open.
  const shown = open.has(sectionTab("study")) ? [...DEFAULT_SECTIONS, "study" as const] : DEFAULT_SECTIONS;
  return [
    ...shown.map((section): MenuEntry => {
      const tab = sectionTab(section);
      return open.has(tab)
        ? { label: SECTION_NAMES[section], checked: true, run: () => s.updateTabLayout((l) => closeTab(l, tab)) }
        : { label: SECTION_NAMES[section], checked: false, run: () => s.focusWorkspace(section) };
    }),
    "separator",
  ];
}

const MENUS: Partial<Record<string, MenuEntry[] | ((view: { id: string }) => MenuEntry[])>> = {
  sidebar: SIDEBAR_MENU,
  chat: chatMenu,
  file: fileMenu,
  section: sectionMenu,
};

const DIRS: Record<string, "left" | "right" | "top" | "bottom"> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom",
};

/**
 * The panes from the keyboard (0.21.0):
 *
 * - Ctrl+Arrow moves to the pane on that side; Ctrl+Shift+Arrow moves the
 *   pane itself past its neighbour on that side.
 * - Ctrl+Enter zooms the pane in front to fill the window, and again to put
 *   the others back; Ctrl+Escape zooms back out too, where Windows lets it
 *   through (it is also the Start menu's).
 *
 * The keys keep their meaning where they already have one: an arrow in a
 * text field that has text in it moves the caret by word, and a Ctrl+Enter
 * the composer or an edit box used (to send or save) is theirs. Those
 * handlers run first, so a used key arrives here marked as handled.
 */
function paneKeys(e: KeyboardEvent, ws: WorkspaceHandle) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented) return;
  if (e.key === "Enter" && !e.shiftKey) {
    if (ws.navigation.toggle()) e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    if (ws.navigation.framed) {
      e.preventDefault();
      ws.navigation.overview();
    }
    return;
  }
  const dir = DIRS[e.key];
  if (!dir) return;
  const field = (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable='true']") as HTMLInputElement | null;
  if (field && (field.value ?? field.textContent ?? "") !== "") return;
  const from = ws.getSnapshot().focusedPanel;
  const to = from ? neighbour(from, dir) : null;
  if (!from || !to) return;
  e.preventDefault();
  if (e.shiftKey) {
    ws.dock(from, { beside: to, edge: dir });
    return;
  }
  ws.focus(to);
  // Into the pane's text box, if it has one, so typing carries on there.
  requestAnimationFrame(() => {
    const selected = ws.views().find((v) => v.panelId === to && v.selected);
    const surface = [...document.querySelectorAll<HTMLElement>('[data-trellis-part="surface"]')].find((el) => el.dataset.view === selected?.id);
    surface?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  });
}

/** The nearest pane on one side of another, by the edges they face. */
function neighbour(panelId: string, dir: "left" | "right" | "top" | "bottom"): string | null {
  const rects = [...document.querySelectorAll<HTMLElement>('[data-trellis-part="panel"]')]
    .map((el) => ({ id: el.dataset.panel ?? "", r: el.getBoundingClientRect() }))
    .filter((p) => p.id && p.r.width > 0);
  const from = rects.find((p) => p.id === panelId)?.r;
  if (!from) return null;
  const across = dir === "left" || dir === "right";
  let best: { id: string; score: number } | null = null;
  for (const { id, r } of rects) {
    if (id === panelId) continue;
    // How far it is in that direction, edge to edge; behind it does not count.
    const gap =
      dir === "left" ? from.left - r.right
      : dir === "right" ? r.left - from.right
      : dir === "top" ? from.top - r.bottom
      : r.top - from.bottom;
    if (gap < -4) continue;
    // How far it is off the line, centre to centre.
    const off = across
      ? Math.abs((r.top + r.bottom) / 2 - (from.top + from.bottom) / 2)
      : Math.abs((r.left + r.right) / 2 - (from.left + from.right) / 2);
    const score = Math.max(gap, 0) + off * 2;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

/** One view's content, with its tab's name kept current. */
function Tile({ render }: { render: (tab: string) => ReactNode }) {
  const view = useView();
  const name = useApp((s) => nameOf(view.id, s));
  useViewTitle(name);
  const section = sectionOf(view.id);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {view.id === SIDEBAR_TAB ? <Sidebar docked /> : section ? <SectionView section={section} /> : render(view.id)}
    </div>
  );
}

/** A workspace section as a pane of its own, about the chat in front. */
function SectionView({ section }: { section: Section }) {
  const chatId = useApp((s) => s.activeChatId);
  const pendingPlan = useApp((s) => (chatId ? !!s.pendingPlanByChat[chatId] : false));
  useViewBadge(section === "plan" && pendingPlan ? true : null);
  if (!chatId) {
    return (
      <p className="p-3 text-[11px] text-[var(--color-text-muted)]">
        Open a chat to see its {SECTION_NAMES[section].toLowerCase()}.
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-panel)]">
      <SectionBody chatId={chatId} section={section} />
    </div>
  );
}

function TabIcon() {
  const tab = useView().id;
  if (tab === SIDEBAR_TAB) return <PanelLeft size={12} />;
  const section = sectionOf(tab);
  if (section) return <>{SECTIONS.find((s) => s.id === section)?.icon}</>;
  const study = studyOf(tab);
  const { Icon, color } = chatOf(tab)
    ? { Icon: MessageSquare, color: undefined }
    : tab === HOME_TAB
      ? { Icon: Plus, color: undefined }
      : study
        ? { Icon: study.kind === "review" ? Repeat : GraduationCap, color: "var(--color-accent)" }
        : iconFor(tab.slice(Math.max(tab.lastIndexOf("/"), tab.lastIndexOf("\\")) + 1));
  return <Icon size={12} style={color ? { color } : undefined} />;
}

type Target = { panelId: string | null; zone: DropZone; rect: DOMRect };

/** The pane under the pointer: its middle joins it, an edge splits it. */
function hit(x: number, y: number, host: HTMLElement | null): Target | null {
  const panel = document.elementsFromPoint(x, y)
    .map((el) => el.closest<HTMLElement>('[data-trellis-part="panel"]'))
    .find((el) => el && host?.contains(el));
  if (!panel) {
    // Nothing open: the whole column is the drop.
    const r = host?.getBoundingClientRect();
    return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && !host!.querySelector('[data-trellis-part="panel"]')
      ? { panelId: null, zone: "center", rect: r }
      : null;
  }
  const r = panel.getBoundingClientRect();
  const bx = (x - r.left) / r.width, by = (y - r.top) / r.height;
  const edges: [DropZone, number][] = [["left", bx], ["right", 1 - bx], ["top", by], ["bottom", 1 - by]];
  const [zone, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { panelId: panel.dataset.panel ?? null, zone: d < 0.3 ? zone : "center", rect: r };
}

function DropPreview({ target: { rect: r, zone } }: { target: Target }) {
  const half = { left: { w: 0.5, h: 1, x: 0, y: 0 }, right: { w: 0.5, h: 1, x: 0.5, y: 0 }, top: { w: 1, h: 0.5, x: 0, y: 0 }, bottom: { w: 1, h: 0.5, x: 0, y: 0.5 }, center: { w: 1, h: 1, x: 0, y: 0 } }[zone];
  return (
    <div
      className="pointer-events-none fixed z-40 rounded border-2 border-[var(--color-accent)] bg-[var(--color-accent)]/15 transition-all duration-100"
      style={{ left: r.left + half.x * r.width, top: r.top + half.y * r.height, width: half.w * r.width, height: half.h * r.height }}
    />
  );
}
