// Keyboard control (0.21): which shortcuts a dialog lets through, and where
// arrows and typing move focus in a group.

import test from "node:test";
import assert from "node:assert/strict";
import { rovingIndex, rovingTab, shortcutFires, typeaheadIndex } from "../src/lib/keyboard.ts";

const none = { settings: false, zones: false, projects: false, palette: false, help: false };

test("with nothing open every shortcut fires", () => {
  for (const a of ["newChat", "toggleSidebar", "openSettings", "prevChat"]) assert.equal(shortcutFires(a, false, none), true);
});

test("an open layer blocks shortcuts that act behind it", () => {
  const open = { ...none, settings: true };
  for (const a of ["newChat", "toggleSidebar", "focusComposer", "nextChat", "openCommandPalette", "openProjects"]) {
    assert.equal(shortcutFires(a, true, open), false, a);
  }
});

test("a shortcut still closes the surface it opened", () => {
  assert.equal(shortcutFires("openSettings", true, { ...none, settings: true }), true);
  assert.equal(shortcutFires("openCommandPalette", true, { ...none, palette: true }), true);
  assert.equal(shortcutFires("toggleShortcutsHelp", true, { ...none, help: true }), true);
  assert.equal(shortcutFires("openZoneLibrary", true, { ...none, settings: true }), false);
  // A popover with no surface of its own open blocks them all.
  assert.equal(shortcutFires("openSettings", true, none), false);
});

test("arrows wrap, Home and End jump, other keys do nothing", () => {
  assert.equal(rovingIndex("ArrowDown", 0, 3), 1);
  assert.equal(rovingIndex("ArrowRight", 2, 3), 0);
  assert.equal(rovingIndex("ArrowUp", 0, 3), 2);
  assert.equal(rovingIndex("Home", 2, 3), 0);
  assert.equal(rovingIndex("End", 0, 3), 2);
  assert.equal(rovingIndex("a", 0, 3), null);
  assert.equal(rovingIndex("ArrowDown", 0, 0), null);
});

test("orientation keeps the other axis's arrows free", () => {
  assert.equal(rovingIndex("ArrowLeft", 1, 3, "vertical"), null);
  assert.equal(rovingIndex("ArrowDown", 1, 3, "horizontal"), null);
  assert.equal(rovingIndex("ArrowUp", 1, 3, "vertical"), 0);
});

test("from nothing focused, forward is the first and back the last", () => {
  assert.equal(rovingIndex("ArrowDown", -1, 4), 0);
  assert.equal(rovingIndex("ArrowUp", -1, 4), 3);
});

test("one Tab stop: the chosen item, else the first", () => {
  assert.deepEqual([0, 1, 2].map((i) => rovingTab(i === 1, i, true)), [-1, 0, -1]);
  assert.deepEqual([0, 1, 2].map((i) => rovingTab(false, i, false)), [0, -1, -1]);
});

test("typing jumps to the next item starting with it", () => {
  const labels = ["Quick chat", "Smart chat", "Coder", "Claude", "Scribe"];
  assert.equal(typeaheadIndex(labels, -1, "c"), 2);
  assert.equal(typeaheadIndex(labels, 2, "c"), 3);
  assert.equal(typeaheadIndex(labels, 3, "c"), 2, "wraps");
  assert.equal(typeaheadIndex(labels, 2, "cl"), 3, "a longer query refines");
  assert.equal(typeaheadIndex(labels, 3, "cl"), 3, "and keeps a match it already has");
  assert.equal(typeaheadIndex(labels, 1, "ss"), 4, "a repeated letter steps on");
  assert.equal(typeaheadIndex(labels, 0, "z"), -1);
});
