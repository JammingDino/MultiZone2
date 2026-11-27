// The main column's layout survives the trip through Trellis's document
// (0.21.0): the store's rules and Trellis's drawing describe the same tiles.

import test from "node:test";
import assert from "node:assert/strict";
import { chatTab, initialLayout, navigate, openTab, studySetTab } from "../src/lib/tabLayout.ts";
import { evenPanels, fromDocument, kindOf, resizePanel, toDocument } from "../src/lib/trellisLayout.ts";

const A = chatTab("a"), B = chatTab("b");

test("tabs map to their kinds", () => {
  assert.equal(kindOf(A), "chat");
  assert.equal(kindOf("@home"), "home");
  assert.equal(kindOf(studySetTab("s")), "study");
  assert.equal(kindOf("C:/x/report.md"), "file");
  assert.equal(kindOf("@settings"), "settings");
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

const p = (id, views) => ({ kind: "panel", id, views, selected: views[0] });
const round = (w) => w.map((x) => Math.round(x * 1000) / 1000);
// The sidebar | a column of two chats | the workspace sections.
const tiles = () => ({
  kind: "split", id: "row", axis: "x", weights: [0.2, 0.5, 0.3],
  children: [p("side", ["@sidebar"]), { kind: "split", id: "col", axis: "y", weights: [0.5, 0.5], children: [p("a", [A]), p("b", [B])] }, p("ws", ["@ws:files"])],
});

test("a pane grows along the row it is in, its siblings giving in proportion", () => {
  const r = resizePanel(tiles(), "a", 0.1);
  assert.deepEqual(round(r.weights), [0.16, 0.6, 0.24]);
  assert.deepEqual(r.children[1].weights, [0.5, 0.5]);
  assert.deepEqual(round(resizePanel(tiles(), "side", -0.05).weights), [0.15, 0.531, 0.319]);
});

test("a pane in no row resizes in its column, and stops at the minimum", () => {
  const col = tiles().children[1];
  assert.deepEqual(round(resizePanel(col, "b", 0.1).weights), [0.4, 0.6]);
  assert.deepEqual(round(resizePanel(col, "b", 5).weights), [0.1, 0.9]);
  const full = resizePanel(col, "b", 5);
  assert.equal(resizePanel(full, "b", 0.1), full);
  assert.equal(resizePanel(col, "nope", 0.1), col);
  assert.equal(resizePanel(p("a", [A]), "a", 0.1).kind, "panel");
});

test("evening out shares the room between chats and files, not the sidebar or the sections", () => {
  const t = tiles();
  t.children[1].weights = [0.8, 0.2];
  t.weights = [0.2, 0.3, 0.5];
  const e = evenPanels(t);
  assert.deepEqual(round(e.weights), [0.2, 0.3, 0.5]);
  assert.deepEqual(round(e.children[1].weights), [0.5, 0.5]);
  const two = { kind: "split", id: "r", axis: "x", weights: [0.2, 0.6, 0.2], children: [p("side", ["@sidebar"]), p("a", [A]), p("b", [B])] };
  assert.deepEqual(round(evenPanels(two).weights), [0.2, 0.4, 0.4]);
  assert.equal(evenPanels(null), null);
});
