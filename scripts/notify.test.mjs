// When a turn's end is announced, and as what (0.18.1).
//
// The failure to guard against is noise: a question announced twice (once as a
// question, once as "finished"), or an error followed by a "finished" for the
// same turn. A toast that repeats itself is a toast people learn to dismiss.

import test from "node:test";
import assert from "node:assert/strict";
import { finishedNotice } from "../src/lib/notify.ts";

const answer = (text) => ({
  role: "assistant",
  zoneId: null,
  content: JSON.stringify([{ type: "text", text }]),
});

test("a plain turn ends with the first line of its answer", () => {
  finishedNotice("a", { type: "user_message_saved" }, []);
  const n = finishedNotice("a", { type: "done" }, [answer("## All tests pass\n\nDetails…")]);
  assert.deepEqual(n, { title: "Finished", body: "All tests pass" });
});

test("a question is not announced again as finished", () => {
  finishedNotice("b", { type: "user_message_saved" }, []);
  finishedNotice("b", { type: "tool_call_result", name: "ask_user", index: 0, result: "{}" }, []);
  assert.equal(finishedNotice("b", { type: "done" }, [answer("Which one?")]), null);
});

test("an error is announced once, and its done stays quiet", () => {
  finishedNotice("c", { type: "user_message_saved" }, []);
  assert.equal(finishedNotice("c", { type: "error", message: "boom" }, []).title, "Run failed");
  assert.equal(finishedNotice("c", { type: "done" }, []), null);
});

test("a guard stop is named at the done that follows it", () => {
  finishedNotice("d", { type: "user_message_saved" }, []);
  finishedNotice("d", { type: "runaway", kind: "repeat", label: "Repeating the same call" }, []);
  assert.deepEqual(finishedNotice("d", { type: "done" }, []), { title: "Stopped", body: "Repeating the same call" });
});

test("the next turn starts clean", () => {
  finishedNotice("e", { type: "error", message: "x" }, []);
  finishedNotice("e", { type: "user_message_saved" }, []);
  assert.equal(finishedNotice("e", { type: "done" }, [answer("ok")]).title, "Finished");
});
