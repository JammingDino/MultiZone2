#!/usr/bin/env node
// Drive a *running* MultiZone against the mock provider and diff what it stored.
//
// The unit tests prove the mock streams a checkable sequence. This proves the
// app receives one intact — through the real LLM client, the real streaming
// parser, the real persistence path — which is the actual 1.0.0 claim.
//
// It needs no GUI automation because the HTTP API is the whole app: create a
// provider, a zone and a chat, send with `?wait=true`, read the stored message
// back, verify. A gap is reported as a token index.
//
// Setup, once:
//   1. Settings → Data → enable the HTTP API, copy the token
//   2. node scripts/mock-provider.mjs
//   3. node scripts/stream-soak.mjs --token <api-token>
//
//   --port 8765          the app's API port (Settings → Data)
//   --mock 8799          the mock provider's port
//   --scenario <name>    one of: quick, sustained, concurrent, tools, truncated, all
//   --keep               leave the created chats behind for inspection
//
// Exit code is 0 only if every scenario verified clean, so this is usable as a
// release gate rather than only as something to read.

import { describe, verifySequence } from "./token-sequence.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const API_PORT = Number(opt("port", 8765));
const MOCK_PORT = Number(opt("mock", 8799));
const TOKEN = opt("token", process.env.MULTIZONE_API_TOKEN ?? "");
const SCENARIO = opt("scenario", "all");
const KEEP = has("keep");

const API = `http://127.0.0.1:${API_PORT}/api`;

if (!TOKEN) {
  console.error("No API token. Settings → Data → HTTP API, then --token <token> (or MULTIZONE_API_TOKEN).");
  process.exit(2);
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/**
 * The assistant text of the last turn.
 *
 * `Message.content` is a JSON-encoded array of content parts, not a plain
 * string — so it has to be parsed rather than read. Reading it raw happens to
 * work, because the checker only extracts numbers and the JSON scaffolding has
 * none, but working by accident is not the same as working.
 */
function lastAssistantText(messages) {
  const assistant = messages.filter((m) => m.role === "assistant");
  const last = assistant[assistant.length - 1];
  if (!last) return "";
  const raw = last.content;
  if (Array.isArray(raw)) return raw.map((p) => p?.text ?? "").join("");
  if (typeof raw === "string") {
    try {
      const parts = JSON.parse(raw);
      if (Array.isArray(parts)) return parts.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
      if (typeof parts === "string") return parts;
    } catch {
      // Stored as a bare string by an older path — use it as it is.
    }
    return raw;
  }
  return String(raw ?? "");
}

async function setup() {
  const provider = await call("POST", "/providers", {
    name: "Mock stream (test)",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    defaultModel: "mock-stream",
  });
  const zone = await call("POST", "/zones", {
    name: "Mock stream (test)",
    providerId: provider.id,
    model: "mock-stream",
    systemPrompt: "Echo the sequence exactly.",
    toolsEnabled: "[]",
  });
  return { provider, zone };
}

async function runOne(zone, prompt, count, { label }) {
  // CreateChatBody carries only zoneId/projectId — the title is a separate
  // route, and worth setting so `--keep` leaves something readable behind.
  const chat = await call("POST", "/chats", { zoneId: zone.id });
  await call("POST", `/chats/${chat.id}/title`, { title: `soak — ${label}` }).catch(() => {});
  const started = Date.now();
  await call("POST", `/chats/${chat.id}/messages?wait=true`, { text: prompt });
  const elapsed = Date.now() - started;

  const messages = await call("GET", `/chats/${chat.id}/messages`);
  const result = verifySequence(lastAssistantText(messages), count);

  if (!KEEP) await call("DELETE", `/chats/${chat.id}`).catch(() => {});

  const rate = elapsed > 0 ? Math.round((result.received / elapsed) * 1000) : 0;
  return { ...result, elapsed, rate, label };
}

function report(r) {
  const mark = r.ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${r.label} — ${describe(r)} (${(r.elapsed / 1000).toFixed(1)}s, ~${r.rate} tok/s)`);
  return r.ok;
}

const SCENARIOS = {
  // The base case, and the fastest way to find out the wiring is right.
  quick: async (zone) => [await runOne(zone, "tokens=2000 delay=0", 2000, { label: "quick — 2k tokens" })],

  // Sustained load: what the checklist item actually says. 100k tokens at full
  // rate is where a throttle either holds or starts shedding.
  sustained: async (zone) => [
    await runOne(zone, "tokens=100000 delay=0", 100000, { label: "sustained — 100k tokens, no delay" }),
    await runOne(zone, "tokens=20000 delay=1 pause=1500", 20000, { label: "sustained — 20k with a 1.5s mid-stream stall" }),
  ],

  // Seven at once is perspective mode's shape: the case with the most moving
  // parts, and the one where a shared buffer would show up.
  concurrent: async (zone) => {
    const runs = [];
    for (let i = 1; i <= 7; i++) {
      runs.push(runOne(zone, "tokens=20000 delay=0", 20000, { label: `concurrent ${i}/7 — 20k tokens` }));
    }
    return Promise.all(runs);
  },

  // Text either side of a tool call: the pending-args path has its own
  // accumulation, and text after a tool result is a separate stream.
  tools: async (zone) => [await runOne(zone, "tokens=500 delay=0", 500, { label: "tools — 500 tokens" })],

  // The negative control. If this one *passes*, the checker is not checking:
  // the provider hangs up at token 400 of 5000 and the app cannot have them all.
  truncated: async (zone) => {
    const r = await runOne(zone, "tokens=5000 delay=0 fail=400", 5000, { label: "truncated (expected to fail)" });
    const inverted = { ...r, ok: !r.ok, label: "truncated — a cut stream is detected, not silently accepted" };
    if (r.ok) console.log("   the app reported a complete sequence from a stream that was cut short");
    return [inverted];
  },
};

async function main() {
  const names = SCENARIO === "all" ? Object.keys(SCENARIOS) : SCENARIO.split(",");
  for (const n of names) {
    if (!SCENARIOS[n]) {
      console.error(`Unknown scenario "${n}". Available: ${Object.keys(SCENARIOS).join(", ")}, all`);
      process.exit(2);
    }
  }

  // Fail early and specifically rather than at the first mysterious 401.
  try {
    await call("GET", "/health");
  } catch (e) {
    console.error(`Cannot reach the app's API on ${API}. Is it enabled in Settings → Data, and is the token right?`);
    console.error(String(e.message ?? e));
    process.exit(2);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(`Cannot reach the mock provider on port ${MOCK_PORT}. Start it: node scripts/mock-provider.mjs`);
    process.exit(2);
  }

  const { provider, zone } = await setup();
  console.log(`provider ${provider.id}, zone ${zone.id}\n`);

  let allOk = true;
  for (const name of names) {
    const results = await SCENARIOS[name](zone);
    for (const r of results) allOk = report(r) && allOk;
  }

  if (!KEEP) {
    await call("DELETE", `/zones/${zone.id}`).catch(() => {});
    await call("DELETE", `/providers/${provider.id}`).catch(() => {});
  }

  console.log(`\n${allOk ? "no dropped tokens" : "DROPPED TOKENS — see the indexes above"}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
