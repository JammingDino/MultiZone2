// The phone layout (0.21): when the window is a phone, and which tab it shows.

import test from "node:test";
import assert from "node:assert/strict";
import { isPhone, phonePane, NARROW_QUERY } from "../src/lib/mobileLayout.ts";
import {
  HOME_TAB, SIDEBAR_TAB, SETTINGS_TAB, DEFAULT_SECTIONS, chatTab, dockPanel, initialLayout, navigate, openTab, sectionTab, activate, groupOf,
} from "../src/lib/tabLayout.ts";

const A = chatTab("a"), B = chatTab("b");

test("phones portrait and landscape, desktops and tablets not", () => {
  for (const w of [360, 390, 412, 430]) assert.equal(isPhone(w, 844, true), true, `${w} portrait`);
  for (const [w, h] of [[844, 390], [932, 430], [640, 360]]) assert.equal(isPhone(w, h, true), true, `${w}x${h} landscape`);
  // A desktop window dragged narrow gets the phone layout; a short one keeps its panes.
  assert.equal(isPhone(700, 900, false), true);
  assert.equal(isPhone(1280, 420, false), false);
  assert.equal(isPhone(768, 1024, true), false);
  assert.equal(isPhone(1024, 768, true), false);
  assert.equal(isPhone(1920, 1080, false), false);
  assert.match(NARROW_QUERY, /max-width: 767px.*max-height: 500px/);
});

test("one tab at a time: the focused pane's, panels and Settings left out", () => {
  assert.deepEqual(phonePane(initialLayout()), { tabs: [], active: HOME_TAB });

  let l = navigate(initialLayout(), A);
  l = navigate(l, B, "right");
  l = openTab(l, "/notes.md");
  l = dockPanel(l, [SIDEBAR_TAB], "left", 0.2);
  l = dockPanel(l, DEFAULT_SECTIONS.map(sectionTab), "right", 0.26);
  const p = phonePane(l);
  assert.deepEqual(p.tabs, [A, B, "/notes.md"]);
  assert.equal(p.active, "/notes.md");

  // Picking a tab from the strip focuses its pane; the split stays.
  l = activate(l, groupOf(l, A).id, A);
  assert.equal(phonePane(l).active, A);
  assert.equal(l.root.kind, "split");

  // Focus left on a pane of panels falls back to a pane with content.
  assert.notEqual(phonePane({ ...l, focused: groupOf(l, SIDEBAR_TAB).id }).active, SIDEBAR_TAB);

  // A panel dragged into a chat's pane and in front there: the chat shows.
  const mixed = { root: { kind: "group", id: "g", tabs: [A, SIDEBAR_TAB, SETTINGS_TAB], active: SIDEBAR_TAB }, focused: "g" };
  assert.deepEqual(phonePane(mixed), { tabs: [A], active: A });
});
