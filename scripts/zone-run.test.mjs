// A zone is a role; what it runs on follows the chat unless it pins a provider
// (0.20.0). Mirrors Rust's `resolve_zone_model` tests.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveZoneRun } from "../src/lib/baseZone.ts";

const providers = [
  { id: "p1", name: "First", defaultModel: "first-default" },
  { id: "p2", name: "Second", defaultModel: "second-default" },
];
const zone = (id, providerId, model) => ({ id, providerId, model });
const runs = (z, zones, baseZoneId) => {
  const r = resolveZoneRun(z, providers, zones, baseZoneId);
  return [r.provider?.id, r.model, r.inherited];
};

test("a zone with no provider follows the base zone", () => {
  const base = zone("base", "p2", "picked");
  assert.deepEqual(runs(zone("role", null, ""), [base], "base"), ["p2", "picked", true]);
});

test("with no base zone it runs the first provider's default", () => {
  assert.deepEqual(runs(zone("role", null, ""), [], null), ["p1", "first-default", true]);
});

test("an inheriting base zone does not follow itself", () => {
  const base = zone("base", null, "");
  assert.deepEqual(runs(base, [base], "base"), ["p1", "first-default", true]);
});

test("a pinned provider with no model uses its default; a pinned model wins", () => {
  assert.deepEqual(runs(zone("z", "p2", ""), [], null), ["p2", "second-default", false]);
  assert.deepEqual(runs(zone("z", "p2", "exact"), [], null), ["p2", "exact", false]);
});
