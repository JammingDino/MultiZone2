#!/usr/bin/env node
// Build a synthetic chat of a stated size, so scroll and render performance can
// be measured against the same thing twice.
//
// TEST_STRATEGY.md's performance item needs seed data before it needs
// optimisation: 50 / 500 / 2000 messages with a stated mix of prose, code,
// tables and diagrams, deterministic from a seed so two runs measure the same
// chat. The mix lives in seed-content.mjs and is served by the mock provider.
//
// It seeds by *sending*, through the real engine and the real persistence path,
// because there is no route that inserts a message without a turn — which is
// the right design, and means what lands is exactly what a real chat holds.
//
//   node scripts/mock-provider.mjs
//   node scripts/seed-chat.mjs --token <api-token> --messages 500
//
//   --port 8765       the app's API port (Settings → Data)
//   --mock 8799       the mock provider's port
//   --messages 500    total messages (user + assistant), rounded down to pairs
//   --seed 1          any integer; the same seed gives the same chat
//   --title "..."     defaults to "perf — <n> messages"
//
// Then open the chat and, in devtools, run `__mzPerf.scroll()`.

import { userTurn } from "./seed-content.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const PORT = Number(opt("port", 8765));
const MOCK_PORT = Number(opt("mock", 8799));
const TOTAL = Math.max(2, Number(opt("messages", 500)));
const SEED = Number(opt("seed", 1));
const TOKEN = opt("token", process.env.MULTIZONE_API_TOKEN ?? "");
const TITLE = opt("title", `perf — ${TOTAL} messages`);

const API = `http://127.0.0.1:${PORT}/api`;

if (!TOKEN) {
  console.error("No API token. Settings → Data → HTTP API, then --token <token>.");
  process.exit(2);
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  try {
    await call("GET", "/health");
  } catch (e) {
    console.error(`Cannot reach the app on ${API}. Enable the HTTP API in Settings → Data.`);
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

  const provider = await call("POST", "/providers", {
    name: "Mock stream (seed)",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    defaultModel: "mock-stream",
  });
  const zone = await call("POST", "/zones", {
    name: "Mock stream (seed)",
    providerId: provider.id,
    model: "mock-stream",
    toolsEnabled: "[]",
  });
  const chat = await call("POST", "/chats", { title: TITLE, zoneId: zone.id });

  const pairs = Math.floor(TOTAL / 2);
  const started = Date.now();

  for (let i = 0; i < pairs; i++) {
    // `mix=` picks the synthetic answer; the rest of the line is what the user
    // "said", so the thread reads like a conversation rather than a log.
    const n = SEED * 100000 + i;
    await call("POST", `/chats/${chat.id}/messages?wait=true`, {
      text: `mix=${n} ${userTurn(n)}`,
    });
    if (i % 25 === 0) {
      const rate = (i + 1) / ((Date.now() - started) / 1000);
      process.stdout.write(`\r  ${i * 2}/${pairs * 2} messages (${rate.toFixed(1)} turns/s)   `);
    }
  }

  console.log(`\r  ${pairs * 2}/${pairs * 2} messages${" ".repeat(20)}`);
  console.log(`\nchat ${chat.id} — "${TITLE}" (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  console.log("Open it, then in devtools: __mzPerf.scroll()");
  console.log(`\nThe provider and zone "Mock stream (seed)" are left behind — delete them in Settings when done.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
