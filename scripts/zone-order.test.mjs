// The chronological zone layout: replies in the order they arrived.

import test from "node:test";
import assert from "node:assert/strict";
import { chronological } from "../src/lib/grouping.ts";

const keys = (rs) => chronological(rs).map((r) => r.key);

test("finished replies are ordered by when they last wrote, not by who is primary", () => {
  assert.deepEqual(
    keys([
      { key: "claude", lastAt: 300 },
      { key: "deepseek", lastAt: 100 },
      { key: "deepseek-consult", lastAt: 200 },
    ]),
    ["deepseek", "deepseek-consult", "claude"],
  );
});

test("replies still streaming sit below every finished one, in their original order", () => {
  assert.deepEqual(
    keys([
      { key: "a", lastAt: 0, streaming: {} },
      { key: "b", lastAt: 500 },
      { key: "c", lastAt: 900, streaming: {} },
    ]),
    ["b", "a", "c"],
  );
});

test("a tie keeps the original order, so the chat's own zone stays first", () => {
  assert.deepEqual(keys([{ key: "primary", lastAt: 5 }, { key: "x", lastAt: 5 }]), ["primary", "x"]);
});
