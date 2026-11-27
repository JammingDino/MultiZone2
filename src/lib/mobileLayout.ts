import { HOME_TAB, SETTINGS_TAB, allGroups, focusedGroup, isPanelTab, type TabLayout } from "./tabLayout.ts";

/**
 * The phone layout (0.21).
 *
 * Since 0.20.0 the window is a workspace of panes. A phone has room for one,
 * so below the breakpoint the app shows one tab at a time with every open tab
 * in a strip above it, and the sidebar and the workspace are drawers. The
 * layout itself is left as it is — splits, docked panels and all — so a
 * window that widens again gets its panes back exactly where they were.
 */

/** Tailwind's `md` boundary less one. */
export const PHONE_MAX_WIDTH = 767;
/** A phone on its side: 390–430px tall. A tablet on its side is 750+. */
export const PHONE_MAX_HEIGHT = 500;

/**
 * Narrow, or a touchscreen too short for panes (a phone in landscape is
 * wider than the width breakpoint, and the desktop layout at 390px tall left
 * the chat a strip between its tab bar and the composer). A short *desktop*
 * window keeps its panes: the pointer is what tells a phone from it.
 */
export function isPhone(width: number, height: number, coarse: boolean): boolean {
  return width <= PHONE_MAX_WIDTH || (coarse && height <= PHONE_MAX_HEIGHT);
}

/** The same line as a media query, for CSS and `matchMedia`. The `narrow:`
 *  variant in styles.css spells it out again and must not drift. */
export const NARROW_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px), (max-height: ${PHONE_MAX_HEIGHT}px) and (pointer: coarse)`;

export function phoneNow(): boolean {
  if (typeof window === "undefined") return false;
  return isPhone(window.innerWidth, window.innerHeight, window.matchMedia("(pointer: coarse)").matches);
}

/**
 * What a phone shows: every open tab but the panels, in order, and the one
 * on screen — the focused pane's tab, so a phone opens where the window was.
 * Settings is left out: on a phone it is the full-screen dialog.
 */
export function phonePane(l: TabLayout): { tabs: string[]; active: string } {
  const shown = (t: string) => !!t && !isPanelTab(t) && t !== SETTINGS_TAB;
  const tabs = allGroups(l).flatMap((g) => g.tabs).filter(shown);
  const g = focusedGroup(l);
  const active = shown(g.active) ? g.active : g.tabs.find(shown) ?? tabs[0] ?? HOME_TAB;
  return { tabs, active };
}
