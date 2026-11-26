/**
 * The main column as tiles of tab groups (0.18.3).
 *
 * The column showed one chat, with its open files as a strip of tabs and one
 * of them on screen at a time. Reading a report while asking about it meant
 * flipping back and forth, and two chats side by side was not possible at
 * all. Now the column is a tree: leaves are groups (a tab strip and the active
 * tab's body), inner nodes split their space in a row or a column. Any tab —
 * a chat, a file, the new-chat screen — can be dragged onto another group's
 * edge to split it, or into its strip to join it.
 *
 * Pure functions over plain objects: the store holds one layout and every
 * change is a new value.
 */

/**
 * A chat's tab id is `chat:<id>`; the new-chat screen is `@home`; a study
 * set popped out of a chat is `study:set:<id>`, and a project's review
 * session `study:review:<projectId>`; anything else is a file's absolute path.
 */
export const HOME_TAB = "@home";
export const chatTab = (id: string) => `chat:${id}`;
export const chatOf = (tab: string | undefined): string | null =>
  tab?.startsWith("chat:") ? tab.slice(5) : null;
export const studySetTab = (setId: string) => `study:set:${setId}`;
export const studyReviewTab = (projectId: string) => `study:review:${projectId}`;
export const isStudyTab = (tab: string) => tab.startsWith("study:");
/** What a study tab shows, or null for any other tab. */
export function studyOf(tab: string): { kind: "set" | "review"; id: string } | null {
  const m = /^study:(set|review):(.+)$/.exec(tab);
  return m ? { kind: m[1] as "set" | "review", id: m[2] } : null;
}
/**
 * The app's own panels as tabs (0.21.0): the sidebar, and each section of the
 * workspace panel. They dock, stack, float and close like any tab, but they
 * belong to no chat — a pane holding only these is never where a chat or a
 * file opens.
 */
export const SIDEBAR_TAB = "@sidebar";
export type Section = "chat" | "plan" | "study" | "terminals" | "files" | "context";
/** The sections the workspace opens with; Study joins when it is asked for. */
export const DEFAULT_SECTIONS: Section[] = ["files", "plan", "chat", "terminals", "context"];
export const sectionTab = (s: Section) => `@ws:${s}`;
export const sectionOf = (tab: string): Section | null => (tab.startsWith("@ws:") ? (tab.slice(4) as Section) : null);
export const isPanelTab = (tab: string) => tab === SIDEBAR_TAB || tab.startsWith("@ws:");
export const isFileTab = (tab: string) => tab !== HOME_TAB && !tab.startsWith("chat:") && !isStudyTab(tab) && !isPanelTab(tab);
/**
 * A tab that is not a chat but belongs to one — a file, a study set. Bringing
 * it forward keeps the chat it was opened from as the active one, so the
 * workspace panel and the composer's shortcuts stay with that chat.
 */
export const isAuxTab = (tab: string) => !!tab && tab !== HOME_TAB && !tab.startsWith("chat:");

export type TabGroup = { kind: "group"; id: string; tabs: string[]; active: string };
export type TabSplit = { kind: "split"; id: string; dir: "row" | "col"; children: TabNode[]; sizes: number[] };
export type TabNode = TabGroup | TabSplit;
/**
 * A group lifted out of the tiles into a window of its own (0.21.0). `rect` is
 * in fractions of the column; `z` orders overlapping windows.
 */
export type TabFloat = { group: TabGroup; rect: Rect; z: number; layer: "stage" | "overlay" };
export type TabLayout = { root: TabNode; focused: string; floating?: TabFloat[] };
export type DropZone = "center" | "left" | "right" | "top" | "bottom";
export type Rect = { x: number; y: number; w: number; h: number };

let seq = 0;
const uid = () => `t${++seq}${Math.random().toString(36).slice(2, 7)}`;
const group = (tabs: string[], active = tabs[0]): TabGroup => ({ kind: "group", id: uid(), tabs, active });

/** Nothing open: one empty group, which shows the new-chat screen. */
export function initialLayout(): TabLayout {
  const g: TabGroup = { kind: "group", id: uid(), tabs: [], active: "" };
  return { root: g, focused: g.id };
}

export function groups(node: TabNode): TabGroup[] {
  return node.kind === "group" ? [node] : node.children.flatMap(groups);
}

/** Every group, tiled or floating. */
export function allGroups(layout: TabLayout): TabGroup[] {
  return [...groups(layout.root), ...(layout.floating ?? []).map((f) => f.group)];
}

export function groupOf(layout: TabLayout, tab: string): TabGroup | undefined {
  return allGroups(layout).find((g) => g.tabs.includes(tab));
}

/** Whether a tab is the one showing in its group — on screen, not just open. */
export function isShowing(layout: TabLayout | undefined, tab: string): boolean {
  return !!layout && allGroups(layout).some((g) => g.active === tab);
}

/** A group a chat or a file may open in: anything but a pane of panels. */
const holdsContent = (g: TabGroup) => g.tabs.length === 0 || g.tabs.some((t) => !isPanelTab(t));

export function focusedGroup(layout: TabLayout): TabGroup {
  const all = allGroups(layout);
  return all.find((g) => g.id === layout.focused && holdsContent(g)) ?? all.find(holdsContent) ?? all[0];
}

/** The focused group if it is tiled, else the first tiled one: what a split splits. */
function tiledFocus(layout: TabLayout): TabGroup {
  const tiled = groups(layout.root);
  return tiled.find((g) => g.id === layout.focused && holdsContent(g)) ?? tiled.find(holdsContent) ?? tiled[0];
}

/**
 * Rebuild the tree with `fn` applied to every group. A group mapped to null is
 * dropped; a split left with one child is replaced by it; a child split running
 * the same way as its parent is folded into it, so repeated edge drops make
 * siblings rather than ever-deeper nesting. Sizes are renormalised to sum to 1.
 */
function rewrite(node: TabNode, fn: (g: TabGroup) => TabNode | null): TabNode | null {
  if (node.kind === "group") return fn(node);
  const children: TabNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = rewrite(c, fn);
    if (!r) return;
    if (r.kind === "split" && r.dir === node.dir) {
      r.children.forEach((cc, j) => { children.push(cc); sizes.push(node.sizes[i] * r.sizes[j]); });
    } else {
      children.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

function withGroups(layout: TabLayout, fn: (g: TabGroup) => TabNode | null, focused = layout.focused): TabLayout {
  const root = rewrite(layout.root, fn) ?? initialLayout().root;
  // A floating window holds one group; nothing here splits one (splits go to
  // `tiledFocus`), so a split back is not expected and keeps the window as it was.
  const floating = (layout.floating ?? []).flatMap((f) => {
    const r = fn(f.group);
    return r === null ? [] : [{ ...f, group: r.kind === "group" ? r : f.group }];
  });
  const next: TabLayout = { root, focused };
  if (floating.length) next.floating = floating;
  const all = allGroups(next);
  if (!all.some((g) => g.id === focused)) next.focused = (all.find(holdsContent) ?? all[0]).id;
  return next;
}

export function activate(layout: TabLayout, groupId: string, tab: string): TabLayout {
  return withGroups(layout, (g) => (g.id === groupId && g.tabs.includes(tab) ? { ...g, active: tab } : g), groupId);
}

export function focusGroup(layout: TabLayout, groupId: string): TabLayout {
  return layout.focused === groupId ? layout : { ...layout, focused: groupId };
}

/**
 * Show a tab: brought forward where it already is, or added to the focused
 * group. `background` opens it without changing what is on screen.
 */
export function openTab(layout: TabLayout, tab: string, background = false): TabLayout {
  const home = groupOf(layout, tab);
  if (home) return background ? layout : activate(layout, home.id, tab);
  const target = focusedGroup(layout);
  return withGroups(layout, (g) =>
    g.id === target.id ? { ...g, tabs: [...g.tabs, tab], active: background && g.active ? g.active : tab } : g,
  );
}

/** Remove a tab from wherever it is; a group left empty goes with it. */
function without(layout: TabLayout, tab: string): TabLayout {
  return withGroups(layout, (g) => {
    const i = g.tabs.indexOf(tab);
    if (i < 0) return g;
    const tabs = g.tabs.filter((t) => t !== tab);
    if (tabs.length === 0) return null;
    // Closing the tab you are on lands on its neighbour, so closing three in a
    // row does not bounce you somewhere else between each.
    return { ...g, tabs, active: g.active === tab ? tabs[i] ?? tabs[i - 1] : g.active };
  });
}

export function closeTab(layout: TabLayout, tab: string): TabLayout {
  return groupOf(layout, tab) ? without(layout, tab) : layout;
}

/** Close every tab `drop` picks — the chats that were deleted. */
export function closeWhere(layout: TabLayout, drop: (tab: string) => boolean): TabLayout {
  const all = allGroups(layout);
  return all.some((g) => g.tabs.some(drop)) ? all.flatMap((g) => g.tabs).filter(drop).reduce(without, layout) : layout;
}

/**
 * Go to a chat (or the new-chat screen) from outside the tiles — the sidebar,
 * search, a shortcut. Already open: brought forward where it is. `here`
 * takes the focused group's place when that group is showing a chat, so
 * clicking down the chat list moves one view along rather than piling up a
 * tab per click, as the single view always did; a file on screen is kept and
 * the chat opens beside it as a tab. `tab` adds one (the default for a click
 * since 0.21.0), except over the new-chat screen, which the chat started from
 * it takes the place of rather than leaving an empty screen behind; `right`
 * opens it in a new group to the right.
 */
export function navigate(layout: TabLayout, tab: string, where: "here" | "tab" | "right" = "here"): TabLayout {
  const home = groupOf(layout, tab);
  if (home) return activate(layout, home.id, tab);
  const g = focusedGroup(layout);
  if (where === "right") {
    const t = tiledFocus(layout);
    if (t.tabs.length === 0) return withGroups(layout, (x) => (x.id === t.id ? { ...x, tabs: [tab], active: tab } : x), t.id);
    const fresh = group([tab]);
    return withGroups(
      layout,
      (x) => (x.id === t.id ? { kind: "split", id: uid(), dir: "row", children: [x, fresh], sizes: [0.5, 0.5] } : x),
      fresh.id,
    );
  }
  if (where === "here" ? g.active && !isAuxTab(g.active) : g.active === HOME_TAB) {
    return withGroups(layout, (x) =>
      x.id === g.id ? { ...x, tabs: x.tabs.map((t) => (t === x.active ? tab : t)), active: tab } : x,
    );
  }
  return openTab(layout, tab);
}

/**
 * A layout read back from storage, or null if it is not one. localStorage is
 * user-writable and outlives versions, so nothing is trusted by shape alone.
 */
export function parseLayout(raw: unknown): TabLayout | null {
  const node = (n: any): boolean =>
    n?.kind === "group"
      ? typeof n.id === "string" && Array.isArray(n.tabs) && n.tabs.every((t: unknown) => typeof t === "string") && typeof n.active === "string"
      : n?.kind === "split" && (n.dir === "row" || n.dir === "col") && Array.isArray(n.children) && n.children.length > 1 &&
        Array.isArray(n.sizes) && n.sizes.length === n.children.length && n.sizes.every((x: unknown) => typeof x === "number" && x > 0) &&
        n.children.every(node);
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const float = (f: any): boolean =>
    f?.group?.kind === "group" && node(f.group) && num(f.z) && (f.layer === "stage" || f.layer === "overlay") &&
    num(f.rect?.x) && num(f.rect?.y) && num(f.rect?.w) && num(f.rect?.h);
  const l = raw as TabLayout;
  return l && typeof l.focused === "string" && node(l.root) && (l.floating === undefined || (Array.isArray(l.floating) && l.floating.every(float)))
    ? l
    : null;
}

/**
 * Drop a tab on a group: into its strip (`center`, before `index`), or on one
 * of its edges, which splits the group and gives the tab a new one on that side.
 * The tab need not be open yet — a chat dragged in from the sidebar lands the
 * same way one dragged between strips does.
 */
export function moveTab(layout: TabLayout, tab: string, targetId: string, zone: DropZone, index?: number): TabLayout {
  const src = groupOf(layout, tab);
  const target = allGroups(layout).find((g) => g.id === targetId);
  if (!target) return layout;
  // An empty group (the new-chat screen, nothing open) has no edge to split,
  // and a floating window is one group.
  if (target.tabs.length === 0 || !groups(layout.root).includes(target)) zone = "center";

  if (zone === "center") {
    const from = target.tabs.indexOf(tab);
    let at = index ?? target.tabs.length;
    if (from >= 0 && from < at) at -= 1;
    const moved = !src || src.id === target.id ? layout : without(layout, tab);
    return withGroups(
      moved,
      (g) => {
        if (g.id !== targetId) return g;
        const tabs = g.tabs.filter((t) => t !== tab);
        tabs.splice(Math.min(at, tabs.length), 0, tab);
        return { ...g, tabs, active: tab };
      },
      targetId,
    );
  }

  // Splitting a group off its own only tab would leave it where it started.
  if (src?.id === target.id && src.tabs.length === 1) return layout;
  const fresh = group([tab]);
  const dir = zone === "left" || zone === "right" ? "row" : "col";
  const before = zone === "left" || zone === "top";
  return withGroups(
    src ? without(layout, tab) : layout,
    (g) =>
      g.id === targetId
        ? { kind: "split", id: uid(), dir, children: before ? [fresh, g] : [g, fresh], sizes: [0.5, 0.5] }
        : g,
    fresh.id,
  );
}

/**
 * Pop a study tab out beside the chat: brought forward if it is open; added to
 * the pane already showing study tabs, so a second quiz does not carve the
 * column into thirds; otherwise in a new pane to the right of the focused one,
 * so the chat it came from stays on screen.
 */
export function openBeside(layout: TabLayout, tab: string): TabLayout {
  const home = groupOf(layout, tab);
  if (home) return activate(layout, home.id, tab);
  const study = allGroups(layout).find((g) => g.tabs.some(isStudyTab));
  if (study) {
    return withGroups(layout, (g) => (g.id === study.id ? { ...g, tabs: [...g.tabs, tab], active: tab } : g), study.id);
  }
  return navigate(layout, tab, "right");
}

/**
 * Put a tab in a floating window over the tiles (0.21.0) — something that
 * needs the user now. Already floating: brought forward. Open in a tiled
 * group: lifted out of it. Not open: opened in the window.
 */
export function floatTab(layout: TabLayout, tab: string, rect: Rect = { x: 0.52, y: 0.08, w: 0.44, h: 0.62 }): TabLayout {
  const floats = layout.floating ?? [];
  const z = Math.max(0, ...floats.map((f) => f.z)) + 1;
  const there = floats.find((f) => f.group.tabs.includes(tab));
  if (there) {
    return {
      ...layout,
      focused: there.group.id,
      floating: floats.map((f) => (f === there ? { ...f, z, group: { ...f.group, active: tab } } : f)),
    };
  }
  const rest = groupOf(layout, tab) ? without(layout, tab) : layout;
  const g = group([tab]);
  return { ...rest, focused: g.id, floating: [...(rest.floating ?? []), { group: g, rect, z, layer: "overlay" }] };
}

/**
 * Dock tabs as one new pane along the left or right edge of the whole window
 * (0.21.0), taking `share` of its width — where the sidebar and the workspace
 * open. Tabs already open somewhere stay where the user put them.
 */
export function dockPanel(layout: TabLayout, tabs: string[], edge: "left" | "right", share: number): TabLayout {
  const add = tabs.filter((t) => !groupOf(layout, t));
  if (add.length === 0) return layout;
  const g = group(add);
  const r = layout.root;
  const [children, sizes]: [TabNode[], number[]] =
    r.kind === "split" && r.dir === "row" ? [r.children, r.sizes.map((s) => s * (1 - share))] : [[r], [1 - share]];
  const root: TabNode = {
    kind: "split",
    id: r.kind === "split" && r.dir === "row" ? r.id : uid(),
    dir: "row",
    children: edge === "left" ? [g, ...children] : [...children, g],
    sizes: edge === "left" ? [share, ...sizes] : [...sizes, share],
  };
  return { ...layout, root };
}

/**
 * Bring a tab forward in its group without moving focus to it — a workspace
 * section asked for while the user is typing in a chat.
 */
export function reveal(layout: TabLayout, tab: string): TabLayout {
  const home = groupOf(layout, tab);
  return home ? withGroups(layout, (g) => (g.id === home.id ? { ...g, active: tab } : g)) : layout;
}

/**
 * Show a workspace section (0.21.0): brought forward where it is; else added
 * to the pane already holding sections; else the workspace docks on the right
 * with its usual sections and this one in front.
 */
export function revealSection(layout: TabLayout, section: Section): TabLayout {
  const tab = sectionTab(section);
  if (groupOf(layout, tab)) return reveal(layout, tab);
  const home = allGroups(layout).find((g) => g.tabs.some((t) => sectionOf(t)));
  if (home) return withGroups(layout, (g) => (g.id === home.id ? { ...g, tabs: [...g.tabs, tab], active: tab } : g));
  const tabs = [...DEFAULT_SECTIONS.map(sectionTab), ...(DEFAULT_SECTIONS.includes(section) ? [] : [tab])];
  return reveal(dockPanel(layout, tabs, "right", 0.26), tab);
}

/**
 * There is always somewhere to start a chat (0.21.0). With the sidebar and the
 * workspace as panes, closing the last chat would otherwise leave only them;
 * the new-chat screen takes the empty group, or a pane of its own beside the
 * sidebar.
 */
export function ensureHome(layout: TabLayout): TabLayout {
  const all = allGroups(layout);
  if (all.some((g) => g.tabs.some((t) => !isPanelTab(t)))) return layout;
  const empty = groups(layout.root).find((g) => g.tabs.length === 0);
  if (empty) {
    // Nothing open at all keeps the bare empty group — Trellis draws the
    // new-chat screen for an empty window — unless panels share the window.
    if (all.length === 1) return layout;
    return withGroups(layout, (g) => (g.id === empty.id ? { ...g, tabs: [HOME_TAB], active: HOME_TAB } : g), empty.id);
  }
  const home = group([HOME_TAB]);
  const r = layout.root;
  if (r.kind === "split" && r.dir === "row") {
    const at = r.children.findIndex((c) => c.kind === "group" && c.tabs.includes(SIDEBAR_TAB)) + 1;
    const children = [...r.children];
    children.splice(at, 0, home);
    const sizes = r.sizes.map((s) => s * 0.4);
    sizes.splice(at, 0, 0.6);
    return { ...layout, root: { ...r, children, sizes }, focused: home.id };
  }
  const beside = r.kind === "group" && r.tabs.includes(SIDEBAR_TAB);
  return {
    ...layout,
    root: { kind: "split", id: uid(), dir: "row", children: beside ? [r, home] : [home, r], sizes: beside ? [0.25, 0.75] : [0.7, 0.3] },
    focused: home.id,
  };
}

