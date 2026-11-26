import type { LayoutDocument, LayoutNode, PanelNode } from "@danfessler/trellis";
import { HOME_TAB, chatOf, initialLayout, isStudyTab, type TabGroup, type TabLayout, type TabNode } from "./tabLayout.ts";

/**
 * The main column's layout as Trellis draws it (0.21.0), and back.
 *
 * The store keeps `TabLayout` — the tested navigate/open/close rules work on
 * it — and Trellis draws, drags, docks and floats. A tab's id is its view id,
 * so the two describe the same views; a group is a panel and keeps its id.
 */
export type TabKind = "chat" | "home" | "study" | "file";
export const kindOf = (tab: string): TabKind =>
  chatOf(tab) ? "chat" : tab === HOME_TAB ? "home" : isStudyTab(tab) ? "study" : "file";

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
