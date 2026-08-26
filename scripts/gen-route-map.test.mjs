// The remote transport's half of the drift guard.
//
// The Rust side already fails the build when a Tauri command has neither a
// route nor a stated reason to be GUI-only. That keeps the *API* honest. It
// says nothing about the generated map the remote client dispatches on, which
// is a checked-in file and therefore something a commit can forget.
//
// So: the same table, checked from the other end. A command that gains a route
// reaches the phone in the same commit it reaches the app, or `npm test` fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COVERAGE_SOURCE, OUTPUT, generate, parseCoverage } from "./gen-route-map.mjs";

const source = readFileSync(COVERAGE_SOURCE, "utf8");

test("the checked-in route map matches the Rust coverage table", () => {
  const expected = generate(source);
  const actual = readFileSync(OUTPUT, "utf8");
  assert.equal(
    actual,
    expected,
    `${OUTPUT} is stale — run: node scripts/gen-route-map.mjs`,
  );
});

test("every routed command has a method and a path", () => {
  const { routed } = parseCoverage(source);
  for (const r of routed) {
    assert.match(r.method, /^(GET|POST|PUT|PATCH|DELETE)$/, `${r.command}: ${r.method}`);
    assert.ok(r.path.startsWith("/api/"), `${r.command}: ${r.path}`);
  }
});

// The GUI-only list is what a remote client shows instead of failing with a
// 404, so an entry with no reason would produce the sentence "only works on the
// computer itself — ." on a phone.
test("every GUI-only command explains itself", () => {
  const { guiOnly } = parseCoverage(source);
  assert.ok(guiOnly.length > 0, "some commands genuinely need the window");
  for (const g of guiOnly) {
    assert.ok(g.reason.trim().length > 10, `${g.command} has no usable reason`);
  }
});

// A command cannot be both routed and GUI-only: the transport checks the
// exemption list first, so the route would be unreachable and the phone would
// be told the feature does not work remotely when it does.
test("no command is both routed and GUI-only", () => {
  const { routed, guiOnly } = parseCoverage(source);
  const exempt = new Set(guiOnly.map((g) => g.command));
  for (const r of routed) {
    assert.ok(!exempt.has(r.command), `${r.command} is listed both ways`);
  }
});

// The parser is a regex over Rust. It is worth one assertion that it is
// actually finding the table rather than quietly matching nothing — a stale map
// generated from zero entries would pass the comparison above against itself.
test("the coverage table is parsed, not merely matched", () => {
  const { routed, guiOnly } = parseCoverage(source);
  assert.ok(routed.length > 100, `only ${routed.length} routed commands parsed`);
  const chat = routed.find((r) => r.command === "list_chats");
  assert.deepEqual(chat, { command: "list_chats", method: "GET", path: "/api/chats" });
  assert.ok(guiOnly.some((g) => g.command === "start_dictation"));
});
