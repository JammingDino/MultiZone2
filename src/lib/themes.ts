// Built-in themes, backdrops and the numbers the glass is drawn with (0.20).
//
// Pure: everything here is a function of the theme prefs, so the store can
// write the result onto <html> and the settings page can draw previews with it.

import type { ThemePrefs, ThemeColorKey } from "../store/app.ts";

export type BackdropId = "solid" | "glow" | "dusk" | "lagoon" | "meadow" | "ember" | "blush" | "custom";

/** What a see-through window does to whatever is behind it on the desktop. */
export type WindowBlur = "none" | "blur" | "mica";

/**
 * The palette each mode falls back to — a mirror of the `@theme` / `html.light`
 * blocks in styles.css (and DARK_BASE / LIGHT_BASE in theme.rs). Needed because
 * a colour the user hasn't overridden still has to show its real value.
 */
export const BASE_PALETTE: Record<"dark" | "light", Record<ThemeColorKey, string>> = {
  dark:  { bg: "#0b0d10", panel: "#14171c", panelHover: "#242a33", border: "#2d333d", text: "#e4e6eb", textMuted: "#8b929e" },
  light: { bg: "#fafafa", panel: "#ffffff", panelHover: "#e9edf2", border: "#d8dde4", text: "#1f2329", textMuted: "#5b6573" },
};

/**
 * Built-in backdrops: soft glows of two or three hues over the theme's own
 * background colour. Mixed against `--mz-glow` (stronger on dark than on light)
 * rather than fixed colours, so each one reads as deep glows on a dark theme and
 * as pastel on a light one without a second definition.
 */
export const BACKDROPS: { id: BackdropId; label: string; hues: string[] }[] = [
  { id: "solid",  label: "Plain",       hues: [] },
  { id: "glow",   label: "Accent glow", hues: ["var(--color-accent)", "var(--color-accent)"] },
  { id: "dusk",   label: "Dusk",        hues: ["#7c5cff", "#ff5c8a", "#3a7bff"] },
  { id: "lagoon", label: "Lagoon",      hues: ["#00a6c8", "#2f6bff", "#00c896"] },
  { id: "meadow", label: "Meadow",      hues: ["#3fb56b", "#b8cf3a", "#1f9e8f"] },
  { id: "ember",  label: "Ember",       hues: ["#ff7a3d", "#e0386b", "#ffb03b"] },
  { id: "blush",  label: "Blush",       hues: ["#ff8fb1", "#ffb38a", "#b48cff"] },
  { id: "custom", label: "Your own",    hues: [] },
];

const SPOTS = ["65% 70% at 12% 8%", "70% 75% at 92% 95%", "45% 45% at 70% 12%"];

type BackdropPrefs = Pick<ThemePrefs, "backdrop" | "backdropFrom" | "backdropTo" | "backdropAngle">;

export const CUSTOM_GRADIENT = { from: "#1d2b53", to: "#5b2350", angle: 135 };

/** The `background-image` painted behind the panes; `none` for a plain colour. */
export function backdropImage(t: BackdropPrefs): string {
  const id = t.backdrop ?? "solid";
  if (id === "custom") {
    const angle = Math.round(t.backdropAngle ?? CUSTOM_GRADIENT.angle);
    return `linear-gradient(${angle}deg, ${t.backdropFrom || CUSTOM_GRADIENT.from}, ${t.backdropTo || CUSTOM_GRADIENT.to})`;
  }
  const hues = BACKDROPS.find((b) => b.id === id)?.hues ?? [];
  if (!hues.length) return "none";
  return hues
    .map((h, i) => `radial-gradient(ellipse ${SPOTS[i]}, color-mix(in srgb, ${h} var(--mz-glow, 35%), transparent), transparent)`)
    .join(", ");
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** Whether surfaces are drawn see-through at all: glass, or a see-through window. */
export function isTranslucent(t: ThemePrefs): boolean {
  return !!t.glassEnabled || windowAlpha(t) < 1;
}

export function windowAlpha(t: ThemePrefs): number {
  return t.windowTransparent ? clamp(t.windowOpacity ?? 0.85, 0.3, 1) : 1;
}

/** glassStrength's range. Up to 1 it is what it always was (panes down to
 *  ~35% solid); past 1 the panes thin out to a faint film (~7% at 1.5), for
 *  someone who wants to look at the background rather than through a pane. */
export const GLASS_STRENGTH_MAX = 1.5;

/** How solid a glass pane is (1 = opaque), before a see-through window scales it. */
export function paneAlpha(t: ThemePrefs): number {
  if (!t.glassEnabled) return 1;
  const s = clamp(t.glassStrength ?? 0.5, 0.1, GLASS_STRENGTH_MAX);
  return t.glassStyle === "clear" ? 0.82 - 0.5 * s : 0.9 - 0.55 * s;
}

/**
 * The blur behind the panes, in px. Frosted and tinted blur more as the glass
 * gets stronger (capped at strength 1); `glassBlur` scales that, 0 meaning the
 * background shows crisp through the panes. Clear glass is never blurred.
 */
export function paneBlur(t: ThemePrefs): number {
  if (!t.glassEnabled || t.glassStyle === "clear") return 0;
  const s = clamp(t.glassStrength ?? 0.5, 0.1, 1);
  return Math.round((10 + 18 * s) * clamp(t.glassBlur ?? 1, 0, 2));
}

/**
 * The CSS variables the glass and see-through window are drawn from. Worked
 * out here rather than in `calc()` chains in the stylesheet, so each number is
 * one place, testable, and the stylesheet only says where it goes.
 *
 * - pane: how solid a pane is (paneAlpha). A see-through window scales it.
 * - float: menus and dialogs. They sit over text rather than a soft backdrop,
 *   so they stay much more solid than the panes.
 */
export function surfaceVars(t: ThemePrefs): Record<string, string> {
  const s = clamp(t.glassStrength ?? 0.5, 0.1, 1);
  const glass = !!t.glassEnabled;
  const style = t.glassStyle ?? "frosted";
  const w = windowAlpha(t);
  return {
    "--mz-window-alpha": String(Math.round(w * 100) / 100),
    "--mz-pane-alpha": pct(paneAlpha(t) * w),
    "--mz-float-alpha": pct(glass ? 0.97 - 0.14 * s : 1),
    "--mz-blur": `${paneBlur(t)}px`,
    "--mz-saturate": glass ? (style === "clear" ? "1" : style === "tinted" ? "1.7" : "1.5") : "1",
    "--mz-backdrop": backdropImage(t),
  };
}

// ─── Built-in themes ──────────────────────────────────────────────────────────

/** The fields a built-in theme sets. Everything else (effects, fonts, the
 *  see-through window, custom CSS) is the user's own and survives a switch. */
export type PresetPrefs = Pick<
  ThemePrefs,
  "mode" | "accent" | "colorsDark" | "colorsLight" | "backdrop" | "glassEnabled" | "glassStyle" | "glassStrength"
>;

export interface ThemePreset {
  id: string;
  name: string;
  prefs: Partial<PresetPrefs>;
}

const PRESET_BASE: PresetPrefs = {
  mode: "dark",
  accent: "#4f9cf9",
  colorsDark: {},
  colorsLight: {},
  backdrop: "solid",
  glassEnabled: false,
  glassStyle: "frosted",
  glassStrength: 0.5,
};

export const THEME_PRESETS: ThemePreset[] = [
  { id: "default", name: "Default", prefs: {} },
  { id: "daylight", name: "Daylight", prefs: { mode: "light", accent: "#2f80ed" } },
  {
    id: "midnight", name: "Midnight glass",
    prefs: {
      accent: "#8b7cf6", backdrop: "dusk", glassEnabled: true, glassStrength: 0.6,
      colorsDark: { bg: "#08091a", panel: "#10122a", panelHover: "#1d2042", border: "#2a2e52", text: "#e7e8f6", textMuted: "#9297b8" },
    },
  },
  {
    id: "mist", name: "Mist",
    prefs: {
      mode: "light", accent: "#4f62e8", backdrop: "lagoon", glassEnabled: true, glassStrength: 0.5,
      colorsLight: { bg: "#eef1f6", panel: "#ffffff", panelHover: "#e2e7f0", border: "#d0d7e3", text: "#1b2130", textMuted: "#566076" },
    },
  },
  {
    id: "ember", name: "Ember",
    prefs: {
      accent: "#f0884a", backdrop: "ember",
      colorsDark: { bg: "#14110f", panel: "#1c1815", panelHover: "#2a241f", border: "#372f28", text: "#efe7df", textMuted: "#a8998b" },
    },
  },
  {
    id: "lagoon", name: "Lagoon",
    prefs: {
      accent: "#2bbfc4", backdrop: "lagoon", glassEnabled: true, glassStrength: 0.45,
      colorsDark: { bg: "#08141a", panel: "#0e1d24", panelHover: "#17303a", border: "#1f3b46", text: "#dceef1", textMuted: "#87a6b0" },
    },
  },
  {
    id: "fjord", name: "Fjord",
    prefs: {
      accent: "#86b8d4",
      colorsDark: { bg: "#232832", panel: "#2a303b", panelHover: "#373e4b", border: "#414958", text: "#e3e7ef", textMuted: "#9ba4b6" },
    },
  },
  {
    id: "grove", name: "Grove",
    prefs: {
      accent: "#5fbf7f", backdrop: "meadow",
      colorsDark: { bg: "#0d1410", panel: "#131c16", panelHover: "#1e2b22", border: "#29382e", text: "#e1ece4", textMuted: "#8ea697" },
    },
  },
  {
    id: "petal", name: "Petal",
    prefs: {
      accent: "#ec6f9a", backdrop: "blush", glassEnabled: true, glassStyle: "tinted", glassStrength: 0.4,
      colorsDark: { bg: "#161013", panel: "#1f161a", panelHover: "#2e2127", border: "#3b2a32", text: "#f2e5ea", textMuted: "#b2969f" },
    },
  },
  {
    id: "paper", name: "Paper",
    prefs: {
      mode: "light", accent: "#c0622a",
      colorsLight: { bg: "#f5f2ec", panel: "#fbf9f5", panelHover: "#ebe5da", border: "#ddd4c6", text: "#2a2521", textMuted: "#6b6157" },
    },
  },
  {
    id: "contrast", name: "High contrast",
    prefs: {
      accent: "#ffd60a",
      colorsDark: { bg: "#000000", panel: "#0b0b0b", panelHover: "#262626", border: "#707070", text: "#ffffff", textMuted: "#cfcfcf" },
    },
  },
];

/** A built-in theme as the full set of fields it writes. */
export function presetPrefs(p: ThemePreset): PresetPrefs {
  return { ...PRESET_BASE, ...p.prefs };
}

const sameColor = (a?: string, b?: string) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

function samePalette(a: Partial<Record<ThemeColorKey, string>> | undefined, b: Partial<Record<ThemeColorKey, string>> | undefined) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]) as Set<ThemeColorKey>;
  return [...keys].every((k) => sameColor(a?.[k], b?.[k]));
}

/**
 * The built-in theme the current prefs are, or null for "Custom". Judged on what
 * is on screen: only the palette for the mode in force counts, and the glass
 * style and strength only while glass is on — a tinted style saved from some
 * earlier experiment does not stop a glass-free theme from being recognised.
 */
export function activePreset(t: ThemePrefs): string | null {
  const palette = t.mode === "light" ? "colorsLight" : "colorsDark";
  for (const p of THEME_PRESETS) {
    const want = presetPrefs(p);
    const glass = !!t.glassEnabled;
    if (
      t.mode === want.mode &&
      sameColor(t.accent, want.accent) &&
      samePalette(t[palette], want[palette]) &&
      (t.backdrop ?? "solid") === want.backdrop &&
      glass === want.glassEnabled &&
      (!glass || ((t.glassStyle ?? "frosted") === want.glassStyle && Math.abs((t.glassStrength ?? 0.5) - want.glassStrength!) < 0.001))
    ) return p.id;
  }
  return null;
}

/** A preset's colours with the stock palette filled in, for drawing its preview. */
export function presetPalette(p: ThemePreset): Record<ThemeColorKey, string> & { accent: string } {
  const prefs = presetPrefs(p);
  const mode = prefs.mode === "light" ? "light" : "dark";
  return { ...BASE_PALETTE[mode], ...(mode === "light" ? prefs.colorsLight : prefs.colorsDark), accent: prefs.accent };
}
