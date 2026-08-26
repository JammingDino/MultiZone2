// The rule that turns a command call into an HTTP request.
//
// This is the part of the remote transport most likely to be subtly wrong, and
// the part where being wrong is quietest: a path parameter filled from the
// wrong argument produces a valid-looking URL for the wrong chat. So it is pure
// functions in `src/lib/remote/mapping.ts`, imported here directly (node strips
// the types), and checked two ways — the rule against hand-written cases, and
// the rule against *every* route in the generated map.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildRequest,
  errorMessage,
  fillPath,
  leftoverArgs,
  normalizeBaseUrl,
  parsePairingLink,
  singularId,
} from "../src/lib/remote/mapping.ts";
import { ROUTE_MAP, GUI_ONLY } from "../src/lib/remote/routeMap.generated.ts";

const BASE = "http://192.168.1.5:8765";

/** What the transport does before calling `buildRequest`: look the command up. */
function request(command, args) {
  const binding = ROUTE_MAP[command];
  assert.ok(binding, `${command} is not in the route map`);
  return buildRequest(binding, command, args, BASE);
}

// ─── The naming rule ─────────────────────────────────────────────────────────

test("a named parameter is filled from the argument of the same name", () => {
  const { path, rest } = fillPath("/api/chats/:id/tags/:tagId", {
    chatId: "c1",
    tagId: "t1",
    enabled: true,
  });
  assert.equal(path, "/api/chats/c1/tags/t1");
  assert.deepEqual(rest, { enabled: true });
});

// The ambiguity worth having a rule for: the app calls the same value `id` in
// one command and `chatId` in the next, and both must reach `/api/chats/:id`.
test(":id accepts either `id` or the collection's singular", () => {
  assert.equal(fillPath("/api/chats/:id/zone", { id: "c1" }).path, "/api/chats/c1/zone");
  assert.equal(fillPath("/api/chats/:id/zone", { chatId: "c1" }).path, "/api/chats/c1/zone");
  assert.equal(fillPath("/api/plans/:id/approve", { planId: "p1" }).path, "/api/plans/p1/approve");
});

test("singularisation handles the shapes the API actually uses", () => {
  assert.equal(singularId("chats"), "chatId");
  assert.equal(singularId("memories"), "memoryId");
  assert.equal(singularId("staged-edits"), "stagedEditId");
  assert.equal(singularId("mcp"), "mcpId");
});

// The failure that must be loud: a request to a literal `/api/chats/:id/zone`
// would 404 in a way that reads like the desktop being broken.
test("a missing path argument throws instead of sending `:id` as a value", () => {
  assert.throws(
    () => fillPath("/api/chats/:id/zone", { zoneId: "z1" }, "set_chat_zone"),
    /set_chat_zone needs chatId or id/,
  );
});

test("path values are encoded, so an id with a slash cannot forge a path", () => {
  const { path } = fillPath("/api/chats/:id", { id: "a/../b" });
  assert.equal(path, "/api/chats/a%2F..%2Fb");
});

// ─── Method decides where the leftovers go ───────────────────────────────────

test("a GET puts what is left in the query string", () => {
  const req = request("list_session_events", { chatId: "c1", limit: 30 });
  assert.equal(req.method, "GET");
  assert.equal(req.url, `${BASE}/api/chats/c1/events?limit=30`);
  assert.equal(req.body, undefined);
});

test("a null argument is left out rather than sent as the string 'null'", () => {
  const req = request("list_session_events", { chatId: "c1", limit: null });
  assert.equal(req.url, `${BASE}/api/chats/c1/events`);
});

test("a POST puts what is left in the body", () => {
  const req = request("set_chat_zone", { id: "c1", zoneId: "z1" });
  assert.equal(req.method, "POST");
  assert.equal(req.url, `${BASE}/api/chats/c1/zone`);
  assert.deepEqual(JSON.parse(req.body), { zoneId: "z1" });
});

// Some DELETE handlers read a query flag and some read a JSON body. Sending
// both is what lets this file not know which.
test("a DELETE sends its leftovers as both query and body", () => {
  const req = request("delete_project", { id: "p1", deleteChats: true });
  assert.equal(req.method, "DELETE");
  assert.equal(req.url, `${BASE}/api/projects/p1?deleteChats=true`);
  assert.deepEqual(JSON.parse(req.body), { deleteChats: true });
});

// ─── The two exceptions ──────────────────────────────────────────────────────

test("search renames its argument to the query parameter the route reads", () => {
  const req = request("search_messages", { query: "hello world" });
  assert.equal(req.url, `${BASE}/api/search?q=hello+world`);
});

test("forget adds the flag that distinguishes it from revoke on a shared route", () => {
  const revoke = request("revoke_paired_device", { id: "d1" });
  const forget = request("forget_paired_device", { id: "d1" });
  assert.equal(revoke.url, `${BASE}/api/devices/d1`);
  assert.equal(forget.url, `${BASE}/api/devices/d1?forget=true`);
  assert.notEqual(revoke.url, forget.url, "the weaker action must not stand in for the stronger");
});

test("a command the app calls but the map does not know is caught here", () => {
  assert.equal(ROUTE_MAP["not_a_command"], undefined);
});

// ─── The rule against the whole map ──────────────────────────────────────────

/**
 * The argument names each command is actually called with, read out of
 * `src/lib/tauri.ts`.
 *
 * Reading the real call sites rather than a list written for this test is the
 * whole point: it is the app's own bindings that have to survive the rule, and
 * a hand-written list would be a third copy of the API's shape.
 */
function callSiteArguments() {
  const source = readFileSync("src/lib/tauri.ts", "utf8");
  const calls = new Map();
  // `invoke<T>("command", { a, b: x, c })` — the object literal, one level deep.
  const pattern = /invoke<[^>]*>\(\s*"([a-z_0-9]+)"\s*(?:,\s*\{([^{}]*)\})?\s*\)/g;
  for (const [, command, argsSrc = ""] of source.matchAll(pattern)) {
    // Split on commas and take the key half of each entry, rather than one
    // regex over the whole literal: `{ chatId, tagId }` and
    // `{ chatId, force: force ?? false }` are both ordinary here, and a single
    // pattern that handles both tends to quietly match only the first key —
    // which makes this sweep pass by finding nothing.
    const keys = argsSrc
      .split(",")
      .map((entry) => entry.split(":")[0].trim())
      .filter((key) => /^[A-Za-z_$][\w$]*$/.test(key));
    calls.set(command, keys);
  }
  return calls;
}

test("the call sites are found, so the sweep below is not vacuous", () => {
  const calls = callSiteArguments();
  assert.ok(calls.size > 100, `only ${calls.size} invoke call sites parsed`);
  assert.deepEqual(calls.get("set_chat_zone"), ["id", "zoneId"]);
});

/**
 * The sweep this file exists for.
 *
 * Every command the app calls, run through the same rule the transport uses. A
 * command whose arguments cannot fill its route's parameters is one that works
 * on the desktop and throws on a phone — and would otherwise be found by
 * somebody tapping the wrong screen a release later.
 */
test("every command the app calls can build its own route", () => {
  const calls = callSiteArguments();
  const broken = [];

  for (const [command, keys] of calls) {
    if (GUI_ONLY[command]) continue;
    const binding = ROUTE_MAP[command];
    if (!binding) {
      broken.push(`${command}: called by the app, but neither routed nor GUI-only`);
      continue;
    }
    // Stand-in values: the rule only looks at which names are present.
    const args = Object.fromEntries(keys.map((k) => [k, "x"]));
    try {
      const { rest } = fillPath(binding.path, args, command);
      leftoverArgs(command, rest);
    } catch (e) {
      broken.push(`${command}: ${e.message}`);
    }
  }

  assert.deepEqual(broken, [], `commands that cannot be called remotely:\n${broken.join("\n")}`);
});

// ─── Addresses and links ─────────────────────────────────────────────────────

test("an address is accepted in the forms a person types it", () => {
  assert.equal(normalizeBaseUrl("192.168.1.5"), "http://192.168.1.5:8765");
  assert.equal(normalizeBaseUrl("192.168.1.5:9000"), "http://192.168.1.5:9000");
  assert.equal(normalizeBaseUrl(" http://192.168.1.5:8765/ "), "http://192.168.1.5:8765");
  assert.throws(() => normalizeBaseUrl("   "), /address/);
});

test("a pairing link carries the desktop and the code", () => {
  assert.deepEqual(parsePairingLink("multizone://pair?host=192.168.1.5&port=8765&code=042317"), {
    baseUrl: "http://192.168.1.5:8765",
    code: "042317",
  });
});

// A QR scanner points at whatever is in front of it. Anything that is not one
// of our links has to come back null rather than half-parsed into an address
// the phone then tries to pair with.
// A link with only an address is the armed case: the desktop is waiting and no
// code exists yet, so scanning it still saves typing the IP.
test("a link with no code carries the address alone", () => {
  assert.deepEqual(parsePairingLink("multizone://pair?host=192.168.1.5&port=8765"), {
    baseUrl: "http://192.168.1.5:8765",
    code: null,
  });
});

// A QR scanner points at whatever is in front of it. Anything that is not one
// of our links has to come back null rather than half-parsed into an address
// the phone then tries to pair with.
test("anything that is not a pairing link is refused", () => {
  assert.equal(parsePairingLink("https://example.com/?code=1"), null);
  assert.equal(parsePairingLink("multizone://pair?code=042317"), null, "no host");
  assert.equal(parsePairingLink("not a url"), null);
});

test("an error reads the way a Tauri command's would", () => {
  assert.equal(errorMessage({ error: "no chat abc" }, 404), "no chat abc");
  assert.match(errorMessage(undefined, 401), /no longer paired/);
  assert.equal(errorMessage(undefined, 500), "The desktop answered 500.");
});
