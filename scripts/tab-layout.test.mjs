// The main column's tile tree (0.18.3): chats and files move between groups,
// groups split and collapse, and navigating from the sidebar replaces a chat
// in place rather than piling up tabs.

import test from "node:test";
import assert from "node:assert/strict";
import {
  HOME_TAB, chatTab, initialLayout, openTab, closeTab, closeWhere, moveTab, navigate,
  groups, groupOf, isShowing, parseLayout,
  openBeside, studySetTab, studyReviewTab, studyOf, isFileTab, isAuxTab, floatTab,
  SIDEBAR_TAB, DEFAULT_SECTIONS, sectionTab, sectionOf, dockPanel, revealSection, ensureHome,
} from "../src/lib/tabLayout.ts";

const shape = (n) => (n.kind === "group" ? n.tabs : { [n.dir]: n.children.map(shape) });
const A = chatTab("a"), B = chatTab("b"), C = chatTab("c");

test("navigating replaces the chat on screen, keeps a file, and never duplicates", () => {
  let l = navigate(initialLayout(), A);
  assert.deepEqual(shape(l.root), [A]);
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

test("a chat that is not open yet can be dropped into a strip or onto an edge", () => {
  let l = navigate(initialLayout(), A);
  l = moveTab(l, B, l.root.id, "right");
  assert.deepEqual(shape(l.root), { row: [[A], [B]] });
  assert.equal(l.focused, groupOf(l, B).id);
  l = moveTab(l, C, groupOf(l, A).id, "center", 0);
  assert.deepEqual(shape(l.root), { row: [[C, A], [B]] });
  // Onto the empty home screen: there is no edge to split, so it just opens.
  const home = initialLayout();
  assert.deepEqual(shape(moveTab(home, A, home.root.id, "left").root), [A]);
});

test("a study tab pops out beside the chat, and later ones join it", () => {
  const Q = studySetTab("q1"), D = studySetTab("d1");
  let l = navigate(initialLayout(), A);
  l = openBeside(l, Q);
  assert.deepEqual(shape(l.root), { row: [[A], [Q]] }, "the chat stays on screen");
  // Focus back on the chat, then pop out another: it joins the study pane.
  l = { ...l, focused: groupOf(l, A).id };
  l = openBeside(l, D);
  assert.deepEqual(shape(l.root), { row: [[A], [Q, D]] });
  assert.equal(groupOf(l, D).active, D);
  // Already open: brought forward, never duplicated.
  l = openBeside(l, Q);
  assert.equal(groupOf(l, Q).active, Q);
  assert.equal(groups(l.root).flatMap((g) => g.tabs).length, 3);
});

test("navigating from the sidebar keeps a study tab on screen, as it does a file", () => {
  const Q = studySetTab("q1");
  let l = openTab(navigate(initialLayout(), A), Q);
  l = navigate(l, B);
  assert.deepEqual(shape(l.root), [A, Q, B]);
});

test("study tab ids", () => {
  assert.deepEqual(studyOf(studySetTab("x")), { kind: "set", id: "x" });
  assert.deepEqual(studyOf(studyReviewTab("p")), { kind: "review", id: "p" });
  assert.equal(studyOf(A), null);
  assert.equal(studyOf("/home/study:set:x"), null);
  assert.ok(!isFileTab(studySetTab("x")) && isFileTab("/f") && !isFileTab(HOME_TAB));
  assert.ok(isAuxTab(studySetTab("x")) && isAuxTab("/f") && !isAuxTab(A) && !isAuxTab(HOME_TAB));
});

test("a floating window counts as open, takes tabs, and closes like any group", () => {
  const base = navigate(initialLayout(), A);
  const float = { group: { kind: "group", id: "f1", tabs: [B], active: B }, rect: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, z: 1, layer: "overlay" };
  let l = { ...base, floating: [float], focused: "f1" };
  assert.ok(parseLayout(JSON.parse(JSON.stringify(l))));
  assert.ok(isShowing(l, B));
  assert.equal(groupOf(navigate(l, B), B).id, "f1");
  l = openTab(l, "/f");
  assert.deepEqual(l.floating[0].group.tabs, [B, "/f"]);
  // A split goes beside the tiled pane, never inside the window.
  l = navigate(l, C, "right");
  assert.deepEqual(shape(l.root), { row: [[A], [C]] });
  assert.equal(l.floating.length, 1);
  l = closeWhere(l, (t) => t === B || t === "/f");
  assert.equal(l.floating, undefined);
  assert.deepEqual(shape(l.root), { row: [[A], [C]] });
});

test("floating a tab lifts it out, opens it, or brings its window forward", () => {
  let l = openTab(navigate(initialLayout(), A), "/r.html");
  l = floatTab(l, "/r.html");
  assert.deepEqual(shape(l.root), [A]);
  assert.deepEqual(l.floating.map((f) => f.group.tabs), [["/r.html"]]);
  assert.equal(l.focused, l.floating[0].group.id);
  l = floatTab(l, "/new.md");
  assert.equal(l.floating.length, 2);
  const z = l.floating[1].z;
  l = floatTab(l, "/r.html");
  assert.equal(l.floating.length, 2);
  assert.ok(l.floating[0].z > z);
  assert.ok(parseLayout(JSON.parse(JSON.stringify(l))));
});

test("the sidebar and workspace dock at the edges, and chats never open inside them", () => {
  let l = dockPanel(initialLayout(), [SIDEBAR_TAB], "left", 0.2);
  l = dockPanel(l, DEFAULT_SECTIONS.map(sectionTab), "right", 0.26);
  l = ensureHome(l);
  assert.equal(shape(l.root).row.length, 3);
  assert.deepEqual(shape(l.root).row[1], [HOME_TAB]);
  assert.ok(Math.abs(l.root.sizes.reduce((a, b) => a + b) - 1) < 1e-9);
  // Focus left on the sidebar's pane still opens chats and files in the middle.
  l = { ...l, focused: groupOf(l, SIDEBAR_TAB).id };
  l = navigate(l, A);
  l = openTab(l, "/f.md");
  assert.deepEqual(shape(l.root).row, [[SIDEBAR_TAB], [A, "/f.md"], DEFAULT_SECTIONS.map(sectionTab)]);
  assert.ok(!isFileTab(SIDEBAR_TAB) && !isFileTab(sectionTab("files")));
  // Docking what is already open does nothing.
  assert.equal(dockPanel(l, [SIDEBAR_TAB], "left", 0.2), l);
});

test("closing the last chat leaves a new-chat pane beside the sidebar", () => {
  let l = ensureHome(navigate(dockPanel(initialLayout(), [SIDEBAR_TAB], "left", 0.2), A));
  l = ensureHome(closeTab(l, A));
  assert.deepEqual(shape(l.root), { row: [[SIDEBAR_TAB], [HOME_TAB]] });
  // A bare window is left bare: Trellis draws its own empty screen.
  assert.deepEqual(shape(ensureHome(initialLayout()).root), []);
});

test("a section is revealed in place, joins the sections' pane, or docks the workspace", () => {
  let l = navigate(initialLayout(), A);
  const focused = l.focused;
  l = revealSection(l, "plan");
  assert.deepEqual(groupOf(l, sectionTab("plan")).tabs, DEFAULT_SECTIONS.map(sectionTab));
  assert.equal(groupOf(l, sectionTab("plan")).active, sectionTab("plan"));
  assert.equal(l.focused, focused);
  l = revealSection(l, "study");
  assert.equal(groupOf(l, sectionTab("study")).active, sectionTab("study"));
  assert.equal(groupOf(l, sectionTab("study")).id, groupOf(l, sectionTab("plan")).id);
  l = revealSection(l, "files");
  assert.equal(groupOf(l, sectionTab("files")).active, sectionTab("files"));
  assert.equal(sectionOf(sectionTab("context")), "context");
});
