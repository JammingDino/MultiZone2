// A saved run as one file, and the template checks the editor shows (0.15.4).
import test from "node:test";
import assert from "node:assert/strict";
import { placeholders, templateGaps, runToFile, runFromFile, runFileName } from "../src/lib/savedRunFile.ts";

test("placeholders are found in order, once each, trimmed", () => {
  assert.deepEqual(placeholders("Review {{ file }} for {{focus}}, then {{file}} again; {{}} is nothing"), ["file", "focus"]);
  assert.deepEqual(placeholders("no blanks"), []);
});

test("gaps name the blanks with no parameter and the parameters nothing uses", () => {
  const gaps = templateGaps("Fix {{bug}} in {{file}}", [{ name: "file" }, { name: "tone" }, { name: " " }]);
  assert.deepEqual(gaps, { missing: ["bug"], unused: ["tone"] });
});

const run = { id: "r1", name: "Release notes", description: "for a tag", template: "Notes for {{version}}", paramsJson: "", zoneId: "z1", createdAt: 0, updatedAt: 0 };
const zones = [{ id: "z1", name: "Writer" }, { id: "z2", name: "Coder" }];

test("a run round-trips through its file, the zone by name", () => {
  const file = runToFile(run, [{ name: "version", default: "1.0", required: true }], "Writer");
  const { input, missingZone } = runFromFile(JSON.stringify(file), zones, []);
  assert.deepEqual(input, { name: "Release notes", description: "for a tag", template: "Notes for {{version}}", params: [{ name: "version", default: "1.0", required: true }], zoneId: "z1" });
  assert.equal(missingZone, null);
  assert.ok(!("id" in input), "an import is always a new run");
});

test("a taken name gets a number, and a zone that isn't here is reported, not fatal", () => {
  const file = runToFile(run, [], "Nowhere");
  const { input, missingZone } = runFromFile(JSON.stringify(file), zones, ["Release notes", "Release notes (2)"]);
  assert.equal(input.name, "Release notes (3)");
  assert.equal(input.zoneId, null);
  assert.equal(missingZone, "Nowhere");
});

test("anything that is not a run file is refused with a reason", () => {
  assert.throws(() => runFromFile("{", zones, []), /isn't JSON/);
  assert.throws(() => runFromFile(JSON.stringify({ name: "x", template: "y" }), zones, []), /isn't a MultiZone saved run/);
  assert.throws(() => runFromFile(JSON.stringify({ kind: "multizone.saved-run", name: " ", template: "y" }), zones, []), /no name/);
});

test("junk parameters are dropped and the rest keep only known fields", () => {
  const text = JSON.stringify({ kind: "multizone.saved-run", version: 1, name: "R", template: "{{a}}", params: [null, { name: "" }, { name: " a ", label: "A", evil: 1, required: 0 }], zone: null });
  assert.deepEqual(runFromFile(text, zones, []).input.params, [{ name: "a", label: "A" }]);
});

test("the file name is the run's name, slugged", () => {
  assert.equal(runFileName("Release notes / v2!"), "release-notes-v2.run.json");
  assert.equal(runFileName("  "), "saved-run.run.json");
});
