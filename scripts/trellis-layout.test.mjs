// The main column's layout survives the trip through Trellis's document
// (0.21.0): the store's rules and Trellis's drawing describe the same tiles.

import test from "node:test";
import assert from "node:assert/strict";
import { chatTab, initialLayout, navigate, openTab, studySetTab } from "../src/lib/tabLayout.ts";
import { fromDocument, kindOf, toDocument } from "../src/lib/trellisLayout.ts";

const A = chatTab("a"), B = chatTab("b");

test("tabs map to their kinds", () => {
  assert.equal(kindOf(A), "chat");
  assert.equal(kindOf("@home"), "home");
  assert.equal(kindOf(studySetTab("s")), "study");
  assert.equal(kindOf("C:/x/report.md"), "file");
});

test("a split layout with a floating window round-trips", () => {
  let l = openTab(navigate(navigate(initialLayout(), A), B, "right"), "C:/x/y.md");
  l = { ...l, floating: [{ group: { kind: "group", id: "w", tabs: ["/z"], active: "/z" }, rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, z: 2, layer: "overlay" }] };
  const doc = toDocument(l);
  assert.equal(doc.root.kind, "split");
  assert.equal(doc.root.axis, "x");
  assert.deepEqual(Object.keys(doc.views).sort(), [A, B, "/z", "C:/x/y.md"].sort());
  assert.deepEqual(fromDocument(doc, l.focused), l);
});

test("nothing open is an empty document, and comes back as the home screen's group", () => {
  const doc = toDocument(initialLayout());
  assert.equal(doc.root, null);
  const back = fromDocument(doc, "gone");
  assert.equal(back.root.kind, "group");
  assert.deepEqual(back.root.tabs, []);
  assert.equal(back.focused, back.root.id);
});

test("a hidden panel comes back as a window, not lost", () => {
  const doc = toDocument(navigate(initialLayout(), A));
  doc.hidden = [{ panel: { kind: "panel", id: "h", views: [B], selected: B }, restore: { kind: "tab", panel: doc.root.id } }];
  doc.views[B] = { type: "chat" };
  const l = fromDocument(doc, "h");
  assert.deepEqual(l.floating[0].group.tabs, [B]);
  assert.equal(l.focused, "h");
});
