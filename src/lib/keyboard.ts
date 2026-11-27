import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ShortcutAction } from "./shortcuts.ts";

/**
 * Keyboard plumbing shared by dialogs, menus and Settings' controls (0.21).
 * The decisions are pure and tested (scripts/keyboard.test.mjs); the DOM
 * helpers below them only apply those decisions.
 */

/** What can take keyboard focus, before visibility and tabindex are checked. */
export const FOCUSABLE =
  "button:not(:disabled), [href], input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), [tabindex]";

/** Surfaces a global shortcut toggles, and whether each is open right now. */
export type OpenSurfaces = {
  settings: boolean;
  zones: boolean;
  projects: boolean;
  palette: boolean;
  help: boolean;
};

/**
 * Whether a global shortcut fires while a dialog, menu or the palette is up.
 * The surface on top owns the keyboard, so a shortcut only gets through when
 * pressing it closes a surface it opened (Ctrl+K again to leave the palette);
 * Ctrl+N, Ctrl+B and the rest would act on the window behind it.
 */
export function shortcutFires(action: ShortcutAction, layerOpen: boolean, open: OpenSurfaces): boolean {
  if (!layerOpen) return true;
  switch (action) {
    case "openSettings": return open.settings;
    case "openZoneLibrary": return open.zones;
    case "openProjects": return open.projects;
    case "openCommandPalette": return open.palette;
    case "toggleShortcutsHelp": return open.help;
    default: return false;
  }
}

export type Orientation = "horizontal" | "vertical" | "both";

/**
 * Where an arrow, Home or End moves focus in a row or column of `count`
 * items, wrapping at the ends; null for any other key. From nothing focused
 * (`index` -1), forward lands on the first and back on the last.
 */
export function rovingIndex(key: string, index: number, count: number, orientation: Orientation = "both"): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const across = orientation !== "vertical";
  const down = orientation !== "horizontal";
  const fwd = (across && key === "ArrowRight") || (down && key === "ArrowDown");
  const back = (across && key === "ArrowLeft") || (down && key === "ArrowUp");
  if (!fwd && !back) return null;
  if (index < 0 || index >= count) return fwd ? 0 : count - 1;
  return (index + (fwd ? 1 : -1) + count) % count;
}

/**
 * Type-to-jump in a list: the next item after `from` whose label starts with
 * `query`, wrapping; -1 when none does. Repeating one letter steps through the
 * items that start with it, the way a native select does.
 */
export function typeaheadIndex(labels: string[], from: number, query: string): number {
  const q = query.toLowerCase();
  if (!q || !labels.length) return -1;
  const same = [...q].every((c) => c === q[0]);
  // "aaa" means the third item starting with "a", not one starting with "aaa".
  const needle = same ? q[0] : q;
  // A longer query refines the current item; a repeated letter moves past it.
  const start = same ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < labels.length; k++) {
    const i = (start + k + labels.length) % labels.length;
    if (labels[i].trim().toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/** Visible, Tab-reachable elements inside `root`, in document order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

/**
 * Arrow keys over a group's items. Focus moves; with `select` (a radio group)
 * the item it lands on is also chosen, as native radios do. Items are the
 * group's enabled `selector` matches.
 */
export function rovingKeyDown(
  e: ReactKeyboardEvent<HTMLElement>,
  selector: string,
  { orientation = "both", select = false }: { orientation?: Orientation; select?: boolean } = {},
) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
  );
  const at = items.findIndex((el) => el.contains(e.target as Node));
  if (at === -1) return;
  const next = rovingIndex(e.key, at, items.length, orientation);
  if (next === null) return;
  e.preventDefault();
  e.stopPropagation();
  items[next].focus();
  if (select) items[next].click();
}

/**
 * The one Tab stop of a roving group: the chosen item, or the first when
 * nothing is chosen, so the group can always be reached.
 */
export function rovingTab(chosen: boolean, index: number, anyChosen: boolean): 0 | -1 {
  return chosen || (!anyChosen && index === 0) ? 0 : -1;
}
