// The main column's tile tree (0.18.3): chats and files move between groups,
// groups split and collapse, and navigating from the sidebar replaces a chat
// in place rather than piling up tabs.

import test from "node:test";
import assert from "node:assert/strict";
import {
  HOME_TAB, chatTab, initialLayout, openTab, closeTab, closeWhere, moveTab, navigate,
  groups, groupOf, measure, isShowing, isBare, parseLayout,
} from "../src/lib/tabLayout.ts";

const shape = (n) => (n.kind === "group" ? n.tabs : { [n.dir]: n.children.map(shape) });
const A = chatTab("a"), B = chatTab("b"), C = chatTab("c");

test("navigating replaces the chat on screen, keeps a file, and never duplicates", () => {
  let l = navigate(initialLayout(), A);
  assert.deepEqual(shape(l.root), [A]);
  assert.ok(isBare(l));
  l = navigate(l, B);
  assert.deepEqual(shape(l.root), [B]);
  l = navigate(l, A, "tab");
  assert.deepEqual(shape(l.root), [B, A]);
  l = openTab(l, "/f");
  l = navigate(l, C);
  assert.deepEqual(shape(l.root), [B, A, "/f", C]);
  l = navigate(l, B);
  assert.equal(groupOf(l, B).active, B);
  assert.equal(groups(l.root).flatMap((g) => g.tabs).length, 4);
  l = navigate(l, HOME_TAB);
  assert.deepEqual(shape(l.root), [HOME_TAB, A, "/f", C]);
});

test("open to the side makes a second chat pane", () => {
  const l = navigate(navigate(initialLayout(), A), B, "right");
  assert.deepEqual(shape(l.root), { row: [[A], [B]] });
  assert.equal(l.focused, groupOf(l, B).id);
  assert.ok(isShowing(l, A) && isShowing(l, B));
});

test("an edge drop splits, and a same-direction drop makes a sibling, not nesting", () => {
  let l = openTab(openTab(navigate(initialLayout(), A), "/a"), "/b");
  const g = l.root.id;
  l = moveTab(l, "/a", g, "right");
  assert.deepEqual(shape(l.root), { row: [[A, "/b"], ["/a"]] });
  l = moveTab(l, "/b", g, "left");
  assert.deepEqual(shape(l.root), { row: [["/b"], [A], ["/a"]] });
  assert.ok(Math.abs(l.root.sizes.reduce((a, b) => a + b) - 1) < 1e-9);
  l = moveTab(l, "/b", groupOf(l, "/a").id, "bottom");
  assert.deepEqual(shape(l.root), { row: [[A], { col: [["/a"], ["/b"]] }] });
  const { rects, dividers } = measure(l.root);
  assert.equal(Object.keys(rects).length, 3);
  assert.equal(dividers.length, 2);
});

test("emptying a group collapses its split; closing everything leaves the home screen", () => {
  let l = openTab(openTab(navigate(initialLayout(), A), "/a"), "/b");
  l = moveTab(l, "/a", l.root.id, "bottom");
  l = closeTab(l, "/a");
  assert.deepEqual(shape(l.root), [A, "/b"]);
  assert.equal(l.focused, l.root.id);
  l = closeTab(closeTab(l, A), "/b");
  assert.deepEqual(shape(l.root), []);
});

test("deleted chats are closed wherever they are", () => {
  let l = navigate(navigate(initialLayout(), A), B, "right");
  l = closeWhere(l, (t) => t === A);
  assert.deepEqual(shape(l.root), [B]);
  assert.equal(closeWhere(l, () => false), l);
});

test("a lone tab cannot split off itself; reordering and joining strips", () => {
  let l = openTab(openTab(openTab(navigate(initialLayout(), A), "/a"), "/b"), "/c");
  const one = navigate(initialLayout(), A);
  assert.equal(moveTab(one, A, one.root.id, "top"), one);
  l = moveTab(l, "/c", l.root.id, "center", 0);
  assert.deepEqual(shape(l.root), ["/c", A, "/a", "/b"]);
  l = moveTab(l, "/c", l.root.id, "center", 3);
  assert.deepEqual(shape(l.root), [A, "/a", "/c", "/b"]);
  l = moveTab(l, "/b", l.root.id, "right");
  l = moveTab(l, "/a", groupOf(l, "/b").id, "center", 0);
  assert.deepEqual(shape(l.root), { row: [[A, "/c"], ["/a", "/b"]] });
});

test("a stored layout is only trusted when it has the right shape", () => {
  const l = navigate(navigate(initialLayout(), A), B, "right");
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(l))), l);
  assert.equal(parseLayout({ root: { kind: "split", dir: "row", children: [], sizes: [] }, focused: "x" }), null);
  assert.equal(parseLayout("nope"), null);
});
