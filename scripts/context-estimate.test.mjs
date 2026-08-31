// What the context meter claims the next request will carry.
//
// The interesting half is compaction. `compact_context` reports success, the
// summary lands on the chat row, and every figure the user can see is produced
// *here* — so if this function ignores the compaction, the meter reports the
// same number before and after and the feature is indistinguishable from a
// no-op. That is the bug these cases pin down.
//
// The rule being mirrored lives in `build_history` in
// `src-tauri/src/commands/messages.rs`: messages at or before the cutoff are
// replaced by the summary, the summary is a system message and so counts as
// input, and a cutoff that elides nothing is not a compaction.

import test from "node:test";
import assert from "node:assert/strict";
import { chatContextEstimate } from "../src/lib/tokens.ts";

/** A stored message, with only the fields the estimator reads. */
function msg(id, role, text, createdAt) {
  return {
    id,
    role,
    content: JSON.stringify([{ type: "text", text }]),
    reasoning: null,
    toolCalls: null,
    createdAt,
  };
}

/** Four turns at t=10..40, each long enough that rounding cannot hide a change. */
function conversation() {
  return [
    msg("m1", "user", "a".repeat(4000), 10),
    msg("m2", "assistant", "b".repeat(4000), 20),
    msg("m3", "user", "c".repeat(4000), 30),
    msg("m4", "assistant", "d".repeat(4000), 40),
  ];
}

test("with no compaction, every message counts", () => {
  const est = chatContextEstimate(conversation(), null);
  assert.equal(est.compacted, null);
  // 8000 input chars and 8000 output chars, at ~4 chars/token.
  assert.equal(est.inputTokens, 2000);
  assert.equal(est.outputTokens, 2000);
  assert.equal(est.totalTokens, 4000);
});

test("an absent compaction argument behaves as no compaction", () => {
  assert.deepEqual(chatContextEstimate(conversation()), chatContextEstimate(conversation(), null));
});

test("a compaction replaces the elided turns with the summary", () => {
  const est = chatContextEstimate(conversation(), {
    contextSummary: "s".repeat(400),
    contextSummaryThrough: 20,
  });

  assert.ok(est.compacted, "the compaction must be reported, not silently applied");
  assert.equal(est.compacted.messages, 2, "m1 and m2 are at or before the cutoff");

  // m3 (input) and m4 (output) survive; the summary is a system message, so it
  // lands on the input side along with the preamble the backend wraps it in.
  assert.equal(est.outputTokens, 1000, "only the surviving assistant turn is output");
  assert.equal(est.inputTokens, 1000 + est.compacted.summaryTokens);
  assert.equal(est.totalTokens, est.inputTokens + est.outputTokens);
});

test("the saving is reported against the uncondensed figure, so it reads as evidence", () => {
  const full = chatContextEstimate(conversation(), null);
  const est = chatContextEstimate(conversation(), {
    contextSummary: "s".repeat(400),
    contextSummaryThrough: 20,
  });

  assert.equal(est.compacted.wasTokens, full.totalTokens);
  assert.equal(est.compacted.savedTokens, full.totalTokens - est.totalTokens);
  assert.ok(est.totalTokens < full.totalTokens, "condensing four long turns must shrink the request");
});

test("a summary longer than what it replaced is reported as a cost, not hidden", () => {
  // One short turn, condensed into a very long summary. Signed rather than
  // clamped: a compaction that made things worse is exactly what a user
  // checking the meter needs to be able to see.
  const est = chatContextEstimate([msg("m1", "user", "a".repeat(40), 10), msg("m2", "user", "b", 20)], {
    contextSummary: "s".repeat(8000),
    contextSummaryThrough: 10,
  });
  assert.ok(est.compacted.savedTokens < 0, "a summary that costs more must show as negative");
});

test("a cutoff that elides nothing is not a compaction", () => {
  // The backend declines to inject the summary when the cutoff is older than
  // every surviving message; reporting one here would claim a saving that the
  // request does not make.
  const est = chatContextEstimate(conversation(), {
    contextSummary: "s".repeat(400),
    contextSummaryThrough: 5,
  });
  assert.equal(est.compacted, null);
  assert.equal(est.totalTokens, 4000, "nothing was elided, so nothing changes");
});

test("an empty or whitespace summary is not a compaction", () => {
  for (const contextSummary of [null, "", "   "]) {
    const est = chatContextEstimate(conversation(), { contextSummary, contextSummaryThrough: 20 });
    assert.equal(est.compacted, null, `summary ${JSON.stringify(contextSummary)} must not compact`);
    assert.equal(est.totalTokens, 4000);
  }
});

test("a cutoff with no summary leaves the estimate alone", () => {
  const est = chatContextEstimate(conversation(), { contextSummary: "s".repeat(400), contextSummaryThrough: null });
  assert.equal(est.compacted, null);
  assert.equal(est.totalTokens, 4000);
});
