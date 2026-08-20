#!/usr/bin/env node
// An OpenAI-compatible provider that streams a sequence you can check.
//
// Add it in Settings → Providers as an ordinary provider with base URL
// `http://127.0.0.1:8799/v1` and no key. Every completion streams numbered
// tokens (`0001 0002 …`), so the stored message can be diffed against what was
// sent — see token-sequence.mjs. Nothing here needs a key, a real provider, or
// the network, which is what lets the streaming scenarios run on any machine.
//
//   node scripts/mock-provider.mjs [--port 8799] [--tokens 2000] [--delay 2]
//
// Per-request overrides ride in the prompt, so scenarios can be driven from the
// app's own composer without restarting the server:
//
//   tokens=50000   how many tokens to stream
//   delay=0        milliseconds between tokens
//   pause=250      a one-off stall (ms) halfway through, for buffer behaviour
//   fail=8000      abort the connection after this token, for recovery paths
//   tool=1         emit a tool call before the text, for the pending-args path
//   mix=<n>        stream a synthetic answer (prose/code/table/diagram) seeded
//                  by n, for the performance seeder rather than the drop check
//
// e.g. sending "tokens=100000 delay=0" streams 100k tokens as fast as the
// socket takes them.

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { deltas, expectedText } from "./token-sequence.mjs";
import { mixedAnswer } from "./seed-content.mjs";

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : fallback;
}

const PORT = flag("port", 8799);
const DEFAULT_TOKENS = flag("tokens", 2000);
const DEFAULT_DELAY = flag("delay", 2);

const MODEL_ID = "mock-stream";

/** Read `key=value` knobs out of whatever the user last said. */
function optionsFromPrompt(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = [...messages].reverse().find((m) => m?.role === "user");
  const text =
    typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content)
        ? last.content.map((p) => p?.text ?? "").join(" ")
        : "";
  const num = (name, fallback) => {
    const m = text.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`, "i"));
    return m ? Number(m[1]) : fallback;
  };
  return {
    tokens: Math.max(1, num("tokens", DEFAULT_TOKENS)),
    delay: Math.max(0, num("delay", DEFAULT_DELAY)),
    pause: num("pause", 0),
    fail: num("fail", 0),
    tool: num("tool", 0) > 0,
    mix: num("mix", 0),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(res, payload) {
  return res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(delta, finish = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

async function streamCompletion(res, opts) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Nagle would coalesce the per-token writes into buffer-sized ones, which
    // is the opposite of what this server exists to exercise.
    "X-Accel-Buffering": "no",
  });
  res.socket?.setNoDelay?.(true);

  sse(res, chunk({ role: "assistant", content: "" }));

  if (opts.tool) {
    // One tool call, split across deltas the way a real provider splits them —
    // the pending-argument renderer has its own accumulation path and this is
    // the only way to exercise it without a provider.
    sse(res, chunk({ tool_calls: [{ index: 0, id: "call_mock", type: "function", function: { name: "date_time", arguments: "" } }] }));
    sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"time' } }] }));
    sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: 'zone":"UTC"}' } }] }));
    sse(res, chunk({}, "tool_calls"));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // The seeder wants a realistic answer rather than a checkable one, so `mix`
  // replaces the sequence with synthetic content and streams it in one go —
  // seeding 2000 messages token by token would take longer than it is worth.
  if (opts.mix) {
    sse(res, chunk({ content: mixedAnswer(opts.mix) }));
    sse(res, chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const parts = deltas(opts.tokens);
  const halfway = Math.floor(parts.length / 2);

  for (let i = 0; i < parts.length; i++) {
    if (opts.fail && i + 1 >= opts.fail) {
      // A hard socket close mid-stream: no finish_reason, no [DONE]. What the
      // app does next is the thing being tested.
      res.destroy();
      return;
    }
    if (opts.pause && i === halfway) await sleep(opts.pause);

    const ok = sse(res, chunk({ content: parts[i] }));
    // Respect backpressure rather than queueing the whole stream in memory —
    // otherwise a 100k-token run measures Node's buffer, not the app.
    if (!ok) await new Promise((r) => res.once("drain", r));
    if (opts.delay) await sleep(opts.delay);
  }

  sse(res, chunk({}, "stop"));
  // A usage-carrying final chunk with no choices, which is the shape the
  // streaming parser documents as the end of a well-behaved stream.
  sse(res, {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [],
    usage: { prompt_tokens: 8, completion_tokens: opts.tokens, total_tokens: opts.tokens + 8 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function createMockProvider() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname.endsWith("/models")) {
      return json(res, 200, {
        object: "list",
        data: [{ id: MODEL_ID, object: "model", owned_by: "mock" }],
      });
    }

    if (!url.pathname.endsWith("/chat/completions")) return json(res, 404, { error: "not found" });

    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { /* an unparsable body still gets a stream */ }
      const opts = optionsFromPrompt(body);

      if (body.stream === false) {
        if (opts.mix) {
          return json(res, 200, {
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: MODEL_ID,
            choices: [{ index: 0, message: { role: "assistant", content: mixedAnswer(opts.mix) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 200, total_tokens: 208 },
          });
        }
        return json(res, 200, {
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: MODEL_ID,
          choices: [{ index: 0, message: { role: "assistant", content: expectedText(opts.tokens) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: opts.tokens, total_tokens: opts.tokens + 8 },
        });
      }

      streamCompletion(res, opts).catch(() => { try { res.destroy(); } catch { /* already gone */ } });
    });
  });
}

// Run directly (`node scripts/mock-provider.mjs`) rather than imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createMockProvider();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`mock provider on http://127.0.0.1:${PORT}/v1`);
    console.log(`  model:    ${MODEL_ID}`);
    console.log(`  defaults: ${DEFAULT_TOKENS} tokens, ${DEFAULT_DELAY}ms apart`);
    console.log(`  override per message, e.g. "tokens=100000 delay=0" or "fail=500"`);
  });
}
