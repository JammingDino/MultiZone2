// Chat locks (0.20): a lock covers the chat's branches and sub-agents, and an
// opened lock opens all of them.

import test from "node:test";
import assert from "node:assert/strict";
import { lockRoot, isLockedNow } from "../src/lib/chatLock.ts";

const chats = [
  { id: "a", parentChatId: null, lockKind: "app" },
  { id: "a-branch", parentChatId: "a", lockKind: null },
  { id: "a-sub", parentChatId: "a-branch" },
  { id: "b", parentChatId: null, lockKind: null },
  { id: "b-own", parentChatId: "b", lockKind: "chat" },
];

test("a lock covers descendants and nothing above or beside it", () => {
  assert.equal(lockRoot(chats, "a-sub"), "a");
  assert.equal(lockRoot(chats, "b"), null);
  assert.equal(lockRoot(chats, "b-own"), "b-own");
  assert.equal(lockRoot(chats, "missing"), null);
});

test("opening the root opens the family", () => {
  assert.equal(isLockedNow(chats, "a-sub", []), true);
  assert.equal(isLockedNow(chats, "a-sub", ["a"]), false);
  assert.equal(isLockedNow(chats, "b", []), false);
});

test("a parent cycle cannot hang the walk", () => {
  const loop = [{ id: "x", parentChatId: "y" }, { id: "y", parentChatId: "x" }];
  assert.equal(lockRoot(loop, "x"), null);
});
