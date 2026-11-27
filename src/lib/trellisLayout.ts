import type { LayoutDocument, LayoutNode, PanelNode, SplitNode } from "@danfessler/trellis";
import { HOME_TAB, SETTINGS_TAB, SIDEBAR_TAB, chatOf, initialLayout, isPanelTab, isStudyTab, sectionOf, type TabGroup, type TabLayout, type TabNode } from "./tabLayout.ts";

/**
 * The main column's layout as Trellis draws it (0.21.0), and back.
 *
 * The store keeps `TabLayout` — the tested navigate/open/close rules work on
 * it — and Trellis draws, drags, docks and floats. A tab's id is its view id,
 * so the two describe the same views; a group is a panel and keeps its id.
 */
export type TabKind = "chat" | "home" | "study" | "file" | "sidebar" | "section" | "settings";
export const kindOf = (tab: string): TabKind =>
  chatOf(tab) ? "chat"
  : tab === HOME_TAB ? "home"
  : tab === SIDEBAR_TAB ? "sidebar"
  : tab === SETTINGS_TAB ? "settings"
  : sectionOf(tab) ? "section"
  : isStudyTab(tab) ? "study"
  : "file";

const panel = (g: TabGroup): PanelNode => ({ kind: "panel", id: g.id, views: g.tabs, selected: g.active });

function node(n: TabNode): LayoutNode {
  return n.kind === "group"
    ? panel(n)
    : { kind: "split", id: n.id, axis: n.dir === "row" ? "x" : "y", weights: n.sizes, children: n.children.map(node) };
}

export function toDocument(l: TabLayout): LayoutDocument {
  const empty = l.root.kind === "group" && l.root.tabs.length === 0;
  const floating = (l.floating ?? []).map((f) => ({ panel: panel(f.group), rect: f.rect, z: f.z, layer: f.layer }));
  const tabs = [...(empty ? [] : tabsOf(l.root)), ...(l.floating ?? []).flatMap((f) => f.group.tabs)];
  return {
    schema: 1,
    root: empty ? null : node(l.root),
    floating,
    hidden: [],
    views: Object.fromEntries(tabs.map((t) => [t, { type: kindOf(t) }])),
  };
}

const tabsOf = (n: TabNode): string[] => (n.kind === "group" ? n.tabs : n.children.flatMap(tabsOf));

function back(n: LayoutNode): TabNode | null {
  if (n.kind === "stage") return n.child ? back(n.child) : null;
  if (n.kind === "panel") return { kind: "group", id: n.id, tabs: n.views, active: n.selected };
  const kids = n.children.map(back);
  const children: TabNode[] = [];
  const sizes: number[] = [];
  kids.forEach((k, i) => { if (k) { children.push(k); sizes.push(n.weights[i] ?? 1); } });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return { kind: "split", id: n.id, dir: n.axis === "x" ? "row" : "col", children, sizes: sizes.map((s) => s / total) };
}

/**
 * Trellis's document as a `TabLayout`. Hidden panels come back as floating
 * windows — the app has no tray to restore them from, and a tab that vanished
 * would leave its chat unreachable from the tiles.
 */
export function fromDocument(doc: LayoutDocument, focused: string): TabLayout {
  const root = (doc.root && back(doc.root)) ?? initialLayout().root;
  const floating = [
    ...doc.floating,
    ...doc.hidden.map((h, i) => ({ panel: h.panel, rect: { x: 0.25 + i * 0.03, y: 0.2 + i * 0.03, w: 0.5, h: 0.6 }, z: 1000 + i, layer: "overlay" as const })),
  ].map((f) => ({ group: { kind: "group" as const, id: f.panel.id, tabs: f.panel.views, active: f.panel.selected }, rect: f.rect, z: f.z, layer: f.layer }));
  const l: TabLayout = { root, focused };
  if (floating.length) l.floating = floating;
  const ids = [...(root.kind === "group" ? [root.id] : []), ...tabsGroups(root), ...floating.map((f) => f.group.id)];
  if (!ids.includes(focused)) l.focused = ids[0];
  return l;
}

const tabsGroups = (n: TabNode): string[] => (n.kind === "group" ? [n.id] : n.children.flatMap(tabsGroups));

/** The smallest share of its split a pane is resized down to from the keyboard. */
const MIN_SHARE = 0.1;

const normalised = (w: number[]) => {
  const total = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / total);
};

function swap(n: LayoutNode, s: SplitNode): LayoutNode {
  if (n.id === s.id) return s;
  if (n.kind === "split") return { ...n, children: n.children.map((c) => swap(c, s)) };
  if (n.kind === "stage" && n.child) return { ...n, child: swap(n.child, s) as SplitNode | PanelNode };
  return n;
}

/**
 * Grow (delta > 0) or shrink a docked panel from the keyboard (0.21.0), by
 * `delta` of the innermost row it is in — width is what a pane is usually
 * short of — or of the innermost column when it is in no row. Its siblings
 * give or take in proportion, so their balance with each other stays.
 */
export function resizePanel(root: LayoutNode | null, panelId: string, delta: number): LayoutNode | null {
  const path: { split: SplitNode; i: number }[] = [];
  const find = (n: LayoutNode): boolean => {
    if (n.kind === "panel") return n.id === panelId;
    if (n.kind === "stage") return !!n.child && find(n.child);
    return n.children.some((c, i) => {
      path.push({ split: n, i });
      if (find(c)) return true;
      path.pop();
      return false;
    });
  };
  if (!root || !find(root)) return root;
  const at = [...path].reverse().find((p) => p.split.axis === "x") ?? path[path.length - 1];
  if (!at) return root;
  const { split, i } = at;
  const w = normalised(split.weights);
  const own = Math.min(Math.max(w[i] + delta, MIN_SHARE), 1 - MIN_SHARE * (w.length - 1));
  if (Math.abs(own - w[i]) < 1e-6 || w[i] >= 1) return root;
  const weights = w.map((x, j) => (j === i ? own : (x / (1 - w[i])) * (1 - own)));
  return swap(root, { ...split, weights });
}

/**
 * Even the panes out (0.21.0): in every split, what holds chats and files
 * shares what is left equally. The sidebar and the workspace sections keep
 * their widths — a third of the window each would not be an even layout but
 * a broken one.
 */
export function evenPanels(root: LayoutNode | null): LayoutNode | null {
  const even = (n: LayoutNode): LayoutNode => {
    if (n.kind === "panel") return n;
    if (n.kind === "stage") return n.child ? { ...n, child: even(n.child) as SplitNode | PanelNode } : n;
    const w = normalised(n.weights);
    const fixed = n.children.map((c) => c.kind === "panel" && c.views.length > 0 && c.views.every(isPanelTab));
    const count = fixed.filter((f) => !f).length;
    const free = 1 - w.reduce((a, x, i) => a + (fixed[i] ? x : 0), 0);
    return { ...n, children: n.children.map(even), weights: w.map((x, i) => (fixed[i] || !count ? x : free / count)) };
  };
  return root && even(root);
}
