// The main column's tile tree (0.18.3): tabs move, groups split and collapse,
// and the transcript can never be closed away.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_TAB, initialLayout, openTab, closeTab, moveTab, groups, groupOf, measure, isShowing,
} from "../src/lib/tabLayout.ts";

const shape = (n) => (n.kind === "group" ? n.tabs : { [n.dir]: n.children.map(shape) });

test("opening files adds tabs to the focused group; background leaves the view", () => {
  let l = openTab(initialLayout(), "/a");
  l = openTab(l, "/b", true);
  assert.deepEqual(shape(l.root), [CHAT_TAB, "/a", "/b"]);
  assert.equal(l.root.active, "/a");
  assert.ok(isShowing(l, "/a") && !isShowing(l, "/b"));
});

test("an edge drop splits, and a same-direction drop makes a sibling, not nesting", () => {
  let l = openTab(openTab(initialLayout(), "/a"), "/b");
  const g = l.root.id;
  l = moveTab(l, "/a", g, "right");
  assert.deepEqual(shape(l.root), { row: [[CHAT_TAB, "/b"], ["/a"]] });
  l = moveTab(l, "/b", g, "left");
  assert.deepEqual(shape(l.root), { row: [["/b"], [CHAT_TAB], ["/a"]] });
  assert.ok(Math.abs(l.root.sizes.reduce((a, b) => a + b) - 1) < 1e-9);
  // Mixed: a column inside the row.
  l = moveTab(l, "/b", groupOf(l, "/a").id, "bottom");
  assert.deepEqual(shape(l.root), { row: [[CHAT_TAB], { col: [["/a"], ["/b"]] }] });
  const { rects, dividers } = measure(l.root);
  assert.equal(Object.keys(rects).length, 3);
  assert.equal(dividers.length, 2);
});

test("emptying a group removes it and collapses its split", () => {
  let l = openTab(openTab(initialLayout(), "/a"), "/b");
  l = moveTab(l, "/a", l.root.id, "bottom");
  l = closeTab(l, "/a");
  assert.deepEqual(shape(l.root), [CHAT_TAB, "/b"]);
  assert.equal(groups(l.root).length, 1);
  assert.equal(l.focused, l.root.id);
});

test("the transcript cannot be closed, and a lone tab cannot split off itself", () => {
  const l = openTab(initialLayout(), "/a");
  assert.equal(closeTab(l, CHAT_TAB), l);
  const split = moveTab(l, "/a", l.root.id, "right");
  const lone = groupOf(split, "/a").id;
  assert.equal(moveTab(split, "/a", lone, "top"), split);
});

test("reordering within a strip and joining another strip", () => {
  let l = openTab(openTab(openTab(initialLayout(), "/a"), "/b"), "/c");
  l = moveTab(l, "/c", l.root.id, "center", 0);
  assert.deepEqual(shape(l.root), ["/c", CHAT_TAB, "/a", "/b"]);
  l = moveTab(l, "/c", l.root.id, "center", 3);
  assert.deepEqual(shape(l.root), [CHAT_TAB, "/a", "/c", "/b"]);
  l = moveTab(l, "/b", l.root.id, "right");
  l = moveTab(l, "/a", groupOf(l, "/b").id, "center", 0);
  assert.deepEqual(shape(l.root), { row: [[CHAT_TAB, "/c"], ["/a", "/b"]] });
  assert.equal(groupOf(l, "/a").active, "/a");
});
