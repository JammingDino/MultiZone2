// Streamed text pacing and the reveal spans (0.18.3).

import test from "node:test";
import assert from "node:assert/strict";
import { step, rehypeReveal } from "../src/lib/streamReveal.ts";

test("off shows everything that has arrived", () => {
  assert.deepEqual(step("hello world", 0, 0, 16, 0, "char"), { pos: 11, end: 11 });
});

test("a burst is spread out: a backlog drains over about the smoothing window", () => {
  const src = "x".repeat(300);
  let pos = 0, shown = 0, ticks = 0;
  const first = step(src, pos, shown, 33, 300, "char");
  assert.ok(first.end > 0 && first.end < 60, `first tick shows a slice, not the burst (${first.end})`);
  while (shown < src.length && ticks < 1000) {
    ({ pos, end: shown } = step(src, pos, shown, 33, 300, "char"));
    ticks++;
  }
  assert.equal(shown, 300);
  assert.ok(ticks > 10, `took ${ticks} ticks`);
});

test("by word, a word still arriving is held back until it is whole", () => {
  const src = "alpha beta gamma";
  const r = step(src, 0, 0, 180, 300, "word");
  assert.ok(r.end === 0 || /\s/.test(src[r.end - 1]), `ends at a word boundary (${r.end})`);
  // The end of the text is always reached, whatever the unit.
  assert.equal(step(src, 15.9, 11, 1000, 300, "word").end, src.length);
});

test("the reveal never goes backwards", () => {
  assert.equal(step("abc def", 3, 5, 1, 300, "word").end, 5);
});

test("spans wrap words and characters, and leave code and whitespace alone", () => {
  const tree = { type: "root", children: [
    { type: "element", tagName: "p", children: [{ type: "text", value: "hi you" }] },
    { type: "element", tagName: "pre", children: [{ type: "text", value: "code here" }] },
  ] };
  rehypeReveal({ unit: "char" })(tree);
  const p = tree.children[0].children;
  assert.equal(p.length, 3);
  assert.deepEqual(p[1], { type: "text", value: " " });
  assert.equal(p[0].children.length, 2);
  assert.deepEqual(p[0].children[0].properties.className, ["mz-tok"]);
  assert.deepEqual(tree.children[1].children, [{ type: "text", value: "code here" }]);

  const words = { type: "root", children: [{ type: "element", tagName: "p", children: [{ type: "text", value: "hi you" }] }] };
  rehypeReveal({ unit: "word" })(words);
  assert.deepEqual(words.children[0].children[0].properties.className, ["mz-w", "mz-tok"]);
});
