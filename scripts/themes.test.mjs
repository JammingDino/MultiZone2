// Built-in themes and the numbers glass is drawn with (0.20): picking a theme
// is recognised as that theme, tweaking it is "Custom", and the default theme
// stays exactly as solid as before.

import test from "node:test";
import assert from "node:assert/strict";
import {
  THEME_PRESETS, activePreset, presetPrefs, backdropImage, surfaceVars, isTranslucent,
} from "../src/lib/themes.ts";

// The store's DEFAULT_THEME, as far as these functions read it.
const DEFAULTS = {
  mode: "dark", accent: "#4f9cf9", backgroundEffect: "none", shadowsEnabled: true,
  glassEnabled: false, glassStyle: "frosted", glassStrength: 0.5, backdrop: "solid",
  windowTransparent: false, windowOpacity: 0.85,
};

test("every built-in theme is recognised once applied, and only as itself", () => {
  const ids = new Set();
  for (const p of THEME_PRESETS) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.equal(activePreset({ ...DEFAULTS, ...presetPrefs(p) }), p.id);
  }
});

test("a fresh install is the Default theme, whatever glass style is lying around", () => {
  assert.equal(activePreset(DEFAULTS), "default");
  assert.equal(activePreset({ ...DEFAULTS, glassStyle: "tinted", glassStrength: 0.1 }), "default");
  // The other mode's palette is not on screen, so it does not count.
  assert.equal(activePreset({ ...DEFAULTS, colorsLight: { bg: "#ffeeee" } }), "default");
  // Effects, shadows and the window are the user's own, not the theme's.
  assert.equal(activePreset({ ...DEFAULTS, backgroundEffect: "stars", shadowsEnabled: false, windowTransparent: true }), "default");
});

test("tweaking a theme makes it Custom", () => {
  const midnight = { ...DEFAULTS, ...presetPrefs(THEME_PRESETS.find((p) => p.id === "midnight")) };
  assert.equal(activePreset(midnight), "midnight");
  assert.equal(activePreset({ ...midnight, accent: "#ff0000" }), null);
  assert.equal(activePreset({ ...midnight, glassStrength: 0.7 }), null);
  assert.equal(activePreset({ ...midnight, backdrop: "ember" }), null);
  assert.equal(activePreset({ ...midnight, colorsDark: { ...midnight.colorsDark, text: "#ffffff" } }), null);
  assert.equal(activePreset({ ...midnight, accent: midnight.accent.toUpperCase() }), "midnight");
});

test("the default look is fully solid: no translucency, no blur, no backdrop image", () => {
  const v = surfaceVars(DEFAULTS);
  assert.equal(isTranslucent(DEFAULTS), false);
  assert.equal(v["--mz-pane-alpha"], "100%");
  assert.equal(v["--mz-window-alpha"], "1");
  assert.equal(v["--mz-blur"], "0px");
  assert.equal(v["--mz-backdrop"], "none");
  // A see-through window is only see-through when switched on.
  assert.equal(surfaceVars({ ...DEFAULTS, windowOpacity: 0.4 })["--mz-window-alpha"], "1");
});

test("glass keeps a ground under the text, and the window slider is clamped", () => {
  const strong = surfaceVars({ ...DEFAULTS, glassEnabled: true, glassStrength: 1 });
  assert.ok(parseFloat(strong["--mz-pane-alpha"]) >= 30, strong["--mz-pane-alpha"]);
  assert.ok(parseFloat(strong["--mz-float-alpha"]) >= 70, strong["--mz-float-alpha"]);
  assert.equal(surfaceVars({ ...DEFAULTS, glassEnabled: true, glassStyle: "clear" })["--mz-blur"], "0px");
  const faint = surfaceVars({ ...DEFAULTS, windowTransparent: true, windowOpacity: 0.01 });
  assert.equal(faint["--mz-window-alpha"], "0.3");
  assert.equal(isTranslucent({ ...DEFAULTS, windowTransparent: true }), true);
  assert.equal(isTranslucent({ ...DEFAULTS, windowTransparent: true, windowOpacity: 1 }), false);
});

test("backdrops: built-ins are glows, custom is a two-colour gradient", () => {
  assert.equal(backdropImage({ backdrop: "solid" }), "none");
  assert.equal(backdropImage({}), "none");
  assert.match(backdropImage({ backdrop: "dusk" }), /^radial-gradient\(/);
  assert.match(backdropImage({ backdrop: "glow" }), /var\(--color-accent\)/);
  assert.equal(
    backdropImage({ backdrop: "custom", backdropFrom: "#111111", backdropTo: "#222222", backdropAngle: 90 }),
    "linear-gradient(90deg, #111111, #222222)",
  );
  assert.match(backdropImage({ backdrop: "custom" }), /^linear-gradient\(135deg, #/);
});
