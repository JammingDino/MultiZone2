// Commands and folders as words in a prompt (0.20.1).

import test from "node:test";
import assert from "node:assert/strict";
import { slashAt, segments, commandsIn, replaceRange, withoutCommand } from "../src/lib/promptTokens.ts";

const known = new Set(["review", "commit", "impeccable"]);

test("a slash opens the menu anywhere a word starts, not mid-word or in a path", () => {
  assert.deepEqual(slashAt("/rev", 4), { start: 0, end: 4, query: "rev" });
  assert.deepEqual(slashAt("fix it then /co", 15), { start: 12, end: 15, query: "co" });
  assert.deepEqual(slashAt("then /", 6), { start: 5, end: 6, query: "" });
  assert.equal(slashAt("a/b", 3), null, "mid-word");
  assert.equal(slashAt("see /usr/bin", 12), null, "a path is not a command");
  assert.equal(slashAt("plain words", 5), null);
});

test("the caret's word is replaced whole, even when the caret is inside it", () => {
  const at = slashAt("x /revi y", 6);
  assert.deepEqual(at, { start: 2, end: 7, query: "rev" });
  assert.deepEqual(replaceRange("x /revi y", at.start, at.end, "/review"), { text: "x /review y", caret: 9 });
});

test("known commands and granted paths split out of the prose", () => {
  assert.deepEqual(segments("/review the parser, then /commit", known), [
    { kind: "command", text: "/review" },
    { kind: "text", text: " the parser, then " },
    { kind: "command", text: "/commit" },
  ]);
  assert.deepEqual(segments("look in D:\\dev\\app now", known, ["D:\\dev", "D:\\dev\\app"]), [
    { kind: "text", text: "look in " },
    { kind: "path", text: "D:\\dev\\app" },
    { kind: "text", text: " now" },
  ]);
});

test("unknown names, mid-word slashes and trailing punctuation stay prose", () => {
  assert.deepEqual(segments("/nope and a/review and /review.", known), [
    { kind: "text", text: "/nope and a/review and /review." },
  ]);
});

test("an acting command comes out of the prompt with its space, and nothing else does", () => {
  assert.equal(withoutCommand("/plan", "plan"), "");
  assert.equal(withoutCommand("/Plan refactor the parser", "plan"), "refactor the parser");
  assert.equal(withoutCommand("fix this /plan please", "plan"), "fix this please");
  assert.equal(withoutCommand("do it\n/plan", "plan"), "do it");
  assert.equal(withoutCommand("see /planning and a/plan", "plan"), "see /planning and a/plan");
  assert.equal(withoutCommand("/plan why does\n    code()  fail", "plan"), "why does\n    code()  fail");
});

test("commandsIn lists each invoked command once, in order, any case", () => {
  assert.deepEqual(commandsIn("/Commit then /review and /commit again", known), ["Commit", "review"]);
});
