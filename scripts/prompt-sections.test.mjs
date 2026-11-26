// Prompt-section switches and the lean preset (0.20.2).

import test from "node:test";
import assert from "node:assert/strict";
import { isLean, isOn, leanSwitches, readSwitches, sectionWarning, writeSwitches } from "../src/lib/promptSections.ts";

test("the zone's switch beats the app default, and both default to on", () => {
  assert.equal(isOn("memory", {}, {}), true);
  assert.equal(isOn("memory", {}, { memory: false }), false);
  assert.equal(isOn("memory", { memory: true }, { memory: false }), true);
});

test("switches round-trip through the tool config without touching the rest", () => {
  const tc = writeSwitches('{"read_only":true}', { env: false });
  assert.deepEqual(JSON.parse(tc), { read_only: true, prompt_sections: { env: false } });
  assert.deepEqual(readSwitches(tc), { env: false });
  assert.deepEqual(JSON.parse(writeSwitches(tc, {})), { read_only: true });
  assert.deepEqual(readSwitches("not json"), {});
});

test("the loop preamble and env are load-bearing only with the tools that need them", () => {
  assert.equal(sectionWarning("continuity", []), null);
  assert.ok(sectionWarning("continuity", ["date_time"]));
  assert.equal(sectionWarning("env", ["date_time"]), null);
  assert.ok(sectionWarning("env", ["file_system"]));
  assert.equal(sectionWarning("memory", ["memory"]), null);
});

test("lean keeps what the tools need and drops the rest", () => {
  const lean = leanSwitches(["file_system"]);
  assert.equal(lean.continuity, true);
  assert.equal(lean.env, true);
  assert.equal(lean.memory, false);
  assert.equal(lean.tool_descriptions, false);
  assert.equal(lean.skills, false);
  assert.equal(leanSwitches(["skills"]).skills, true);
  assert.ok(isLean(lean, {}, ["file_system"]));
  assert.ok(!isLean({}, {}, ["file_system"]));
});
