// pruneChatMaps: a deleted chat's cached state leaves every *ByChat map.
import test from "node:test";
import assert from "node:assert/strict";
import { pruneChatMaps } from "../src/lib/chatMaps.ts";

const state = {
  chats: [{ id: "a" }],
  messagesByChat: { a: [1], gone: [2, 3] },
  streamingByChat: { gone: { text: "…" } },
  tagsByChat: { a: [] },
  activeChatId: "gone",
  pendingJump: { chatId: "gone" },
  listByChat: ["not", "a", "map"],
};

test("a deleted chat leaves every *ByChat map, and only those maps change", () => {
  const out = pruneChatMaps(state, new Set(["gone"]));
  assert.deepEqual(out, { messagesByChat: { a: [1] }, streamingByChat: {} });
  assert.deepEqual(state.messagesByChat, { a: [1], gone: [2, 3] }, "the input is not mutated");
});

test("a chat that is merely missing from a stale list is left alone", () => {
  assert.deepEqual(pruneChatMaps(state, new Set()), {});
  assert.deepEqual(pruneChatMaps(state, new Set(["never-cached"])), {});
});
