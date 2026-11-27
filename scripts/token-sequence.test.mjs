// Tests for the sequence checker and the mock provider.
//
// The point of this pair is that "no dropped tokens" becomes falsifiable, so
// the tests that matter most here are the ones proving the checker *fails* on
// a stream that lost something. A checker that always passes would close the
// 1.0.0 item and prove nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deltas, describe, expectedText, token, verifySequence } from "./token-sequence.mjs";
import { createMockProvider, scriptStep } from "./mock-provider.mjs";

test("the expected text is the padded sequence, space separated", () => {
  assert.equal(expectedText(3), "0001 0002 0003");
  assert.equal(token(42), "0042");
});

test("a clean stream verifies", () => {
  const r = verifySequence(expectedText(500), 500);
  assert.equal(r.ok, true);
  assert.equal(r.received, 500);
  assert.equal(r.firstGap, null);
  assert.match(describe(r), /all 500 tokens/);
});

test("a dropped token is named by index", () => {
  const text = expectedText(100).replace(" 0037", "");
  const r = verifySequence(text, 100);
  assert.equal(r.ok, false);
  assert.equal(r.firstGap, 37);
  assert.deepEqual(r.missing, [37]);
  assert.match(describe(r), /first: 0037/);
});

test("a whole dropped window is reported, not just its first token", () => {
  const kept = [];
  for (let i = 1; i <= 200; i++) if (i < 90 || i > 99) kept.push(token(i));
  const r = verifySequence(kept.join(" "), 200);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 10);
  assert.equal(r.firstGap, 90);
});

test("chunks reassembled out of order are a different failure from dropped", () => {
  const r = verifySequence("0001 0003 0002 0004", 4);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.disordered, [2]);
  assert.match(describe(r), /out of order/);
});

test("surrounding prose does not fail the check", () => {
  const r = verifySequence(`Here you go:\n\n${expectedText(20)}\n\nLet me know.`, 20);
  assert.equal(r.ok, true);
});

test("a truncated stream fails rather than passing on what arrived", () => {
  const r = verifySequence(expectedText(500).split(" ").slice(0, 300).join(" "), 500);
  assert.equal(r.ok, false);
  assert.equal(r.received, 300);
  assert.equal(r.firstGap, 301);
});

// ─── The mock provider itself ────────────────────────────────────────────────

/** Start the mock on an ephemeral port so tests never collide with a running one. */
async function withServer(fn) {
  const server = createMockProvider();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Consume an SSE completion the way the app's parser does, returning the text. */
async function collect(base, prompt) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mock-stream", stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  assert.equal(res.status, 200);

  let text = "";
  let toolArgs = "";
  let done = false;
  let buffer = "";
  for await (const piece of res.body) {
    buffer += Buffer.from(piece).toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      if (!frame.startsWith("data: ")) continue;
      const data = frame.slice(6);
      if (data === "[DONE]") { done = true; continue; }
      const parsed = JSON.parse(data);
      for (const choice of parsed.choices ?? []) {
        if (choice.delta?.content) text += choice.delta.content;
        for (const t of choice.delta?.tool_calls ?? []) toolArgs += t.function?.arguments ?? "";
      }
    }
  }
  return { text, toolArgs, done };
}

test("the mock streams a sequence that verifies clean", async () => {
  await withServer(async (base) => {
    const { text, done } = await collect(base, "tokens=300 delay=0");
    assert.equal(done, true);
    const r = verifySequence(text, 300);
    assert.equal(r.ok, true, describe(r));
  });
});

test("one SSE frame per token, so the transport is exercised per token", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock-stream", stream: true, messages: [{ role: "user", content: "tokens=50 delay=0" }] }),
    });
    const body = await res.text();
    const contentFrames = body.split("\n\n").filter((f) => f.includes('"content"') && !f.includes('"role"'));
    assert.equal(contentFrames.length, 50);
  });
});

test("the deltas concatenate to exactly the expected text", () => {
  assert.equal(deltas(4).join(""), expectedText(4));
});

test("fail= aborts mid-stream, and the checker catches the truncation", async () => {
  await withServer(async (base) => {
    let text = "";
    try {
      ({ text } = await collect(base, "tokens=200 delay=0 fail=60"));
    } catch {
      // A destroyed socket may surface as a read error rather than a clean end;
      // either way the assertion below is about what arrived, not how it stopped.
    }
    const r = verifySequence(text, 200);
    assert.equal(r.ok, false);
    assert.ok(r.received < 200, `expected a truncated stream, got ${r.received}`);
  });
});

test("tool=1 emits a tool call whose arguments accumulate to valid JSON", async () => {
  await withServer(async (base) => {
    const { toolArgs, done } = await collect(base, "tool=1");
    assert.equal(done, true);
    assert.deepEqual(JSON.parse(toolArgs), { timezone: "UTC" });
  });
});

test("stream:false returns the same sequence as one message", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock-stream", stream: false, messages: [{ role: "user", content: "tokens=25" }] }),
    });
    const body = await res.json();
    assert.equal(verifySequence(body.choices[0].message.content, 25).ok, true);
  });
});

test("the models endpoint lists the mock, so the app's model picker fills in", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/models`);
    const body = await res.json();
    assert.deepEqual(body.data.map((m) => m.id), ["mock-stream"]);
  });
});

// ─── The seeder's content ────────────────────────────────────────────────────

test("mix= returns the same answer for the same seed and a different one otherwise", async () => {
  await withServer(async (base) => {
    const a = await collect(base, "mix=7");
    const b = await collect(base, "mix=7");
    const c = await collect(base, "mix=8");
    assert.equal(a.text, b.text, "the same seed must produce the same chat twice");
    assert.notEqual(a.text, c.text);
    assert.ok(a.text.length > 50);
  });
});

test("mix= with delay= streams the answer a word at a time, as long as tokens= asks", async () => {
  const { pacedMix } = await import("./mock-provider.mjs");
  const parts = pacedMix(3, 400);
  assert.ok(parts.join("").split(/\s+/).length >= 400);
  assert.ok(parts.join("").startsWith((await import("./seed-content.mjs")).mixedAnswer(3)));
  await withServer(async (base) => {
    const { text } = await collect(base, "mix=3 tokens=400 delay=0");
    assert.equal(text, parts.join(""));
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock-stream", stream: true, messages: [{ role: "user", content: "mix=3 tokens=400 delay=0" }] }),
    });
    const frames = (await res.text()).split("\n\n").filter((f) => f.includes('"content"') && !f.includes('"role"'));
    assert.equal(frames.length, parts.length, "one frame per word");
  });
});

test("the stated mix holds across a run, so two measurements are comparable", async () => {
  const { mixedAnswer } = await import("./seed-content.mjs");
  const kinds = { prose: 0, code: 0, table: 0, diagram: 0 };
  for (let i = 0; i < 400; i++) {
    const a = mixedAnswer(i);
    if (a.includes("```mermaid")) kinds.diagram++;
    else if (a.includes("```ts")) kinds.code++;
    else if (a.includes("| --- |")) kinds.table++;
    else kinds.prose++;
  }
  // Proportions are 55/20/15/10; the bands are wide enough not to be flaky and
  // tight enough to catch the mix being changed by accident.
  assert.ok(kinds.prose > 180 && kinds.prose < 260, `prose ${kinds.prose}`);
  assert.ok(kinds.code > 40 && kinds.code < 120, `code ${kinds.code}`);
  assert.ok(kinds.table > 25 && kinds.table < 100, `table ${kinds.table}`);
  assert.ok(kinds.diagram > 15 && kinds.diagram < 80, `diagram ${kinds.diagram}`);
});

test("script= steps through one round per assistant reply, and repeats or finishes", () => {
  const tools = [{ type: "function", function: { name: "read_file" } }];
  const script = 'go script=[{"tool":"read_file","args":{"path":"a.txt"}},{"text":"done","tool":"write_file","args":{}},{"tool":"read_file","repeat":true}]';
  const at = (after) => scriptStep({ tools, messages: [{ role: "system", content: "s" }, { role: "user", content: script }, ...after] });
  const round = { role: "assistant", content: "" };
  const result = { role: "tool", content: "ok" };
  assert.equal(at([]).tool, "read_file");
  assert.deepEqual(at([]).args, { path: "a.txt" });
  assert.equal(at([round, result]).text, "done");
  assert.equal(at([round, result, round, result]).tool, "read_file");
  assert.equal(at(Array(20).fill(round)).tool, "read_file", "a repeating last step never ends");
  const once = (n) => scriptStep({ tools, messages: [{ role: "user", content: 'script=[{"text":"hi"}]' }, ...Array(n).fill(round)] });
  assert.equal(once(1).text, "script finished");
  assert.equal(scriptStep({ messages: [{ role: "user", content: script }] }), null, "no tools offered: not scripted");
  assert.match(scriptStep({ messages: [{ role: "user", content: script }, round, result] }).text, /tools withdrawn/, "tools taken away mid-script");
  assert.equal(scriptStep({ tools, messages: [{ role: "user", content: "tokens=5" }] }), null);
  assert.match(scriptStep({ tools, messages: [{ role: "user", content: "script=[nope]" }] }).text, /not valid JSON/);
});

test("a scripted tool step streams one call whose arguments accumulate to the step's", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock-stream", stream: true, tools: [{ type: "function", function: { name: "read_file" } }],
        messages: [{ role: "user", content: 'script=[{"text":"looking","tool":"read_file","args":{"path":"x/y.txt"}}]' }] }),
    });
    const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: {")).map((f) => JSON.parse(f.slice(6)));
    const deltas = frames.flatMap((f) => f.choices.map((c) => c.delta ?? {}));
    assert.equal(deltas.map((d) => d.content ?? "").join(""), "looking");
    assert.deepEqual(JSON.parse(deltas.flatMap((d) => d.tool_calls ?? []).map((t) => t.function?.arguments ?? "").join("")), { path: "x/y.txt" });
    assert.equal(frames.at(-1).choices[0].finish_reason, "tool_calls");
  });
});

test("a {tools: true} step answers with the tool names this round offers", () => {
  const body = {
    tools: [{ function: { name: "write" } }, { function: { name: "read" } }],
    messages: [{ role: "user", content: 'go script=[{"tools":true}]' }],
  };
  assert.equal(scriptStep(body).text, "tools: read,write");
});
