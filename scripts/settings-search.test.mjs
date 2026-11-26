// Settings search (0.21): the index is read from the tabs, so it cannot drift
// from them; the matcher finds a setting by its name, its words or its options.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OUTPUT, generate } from "./gen-settings-index.mjs";
import { SETTINGS_INDEX } from "../src/lib/settingsIndex.generated.ts";
import { fuzzyMatch, groupByTab, headingMatch, markRuns, scoreSetting, searchSettings, wordPrefixAt } from "../src/lib/settingsSearch.ts";

test("the checked-in settings index matches the Settings tabs", () => {
  assert.equal(readFileSync(OUTPUT, "utf8"), generate(), `${OUTPUT} is stale — run: node scripts/gen-settings-index.mjs`);
});

test("the index reaches sections in other files, nested components and Advanced", () => {
  const find = (tab, heading) => SETTINGS_INDEX.find((e) => e.tab === tab && e.heading === heading);
  assert.ok(find("chat", "Clicking a chat"));
  assert.ok(find("remote", "Pair a device"), "RemoteAccess.tsx, rendered by RemoteTab");
  assert.equal(find("appearance", "Typography")?.advanced, true);
  assert.equal(find("appearance", "Theme")?.advanced, undefined);
  assert.ok(find("chat", "Clicking a chat").keywords.includes("Opens a new tab"), "option labels are keywords");
  assert.ok(!SETTINGS_INDEX.some((e) => e.heading === "Install"), "a heading about a dynamic name is left out");
});

test("fuzzyMatch is a subsequence match that prefers word starts", () => {
  assert.deepEqual(fuzzyMatch("nwc", "New chat")?.indices, [0, 2, 4]);
  assert.equal(fuzzyMatch("xyz", "New chat"), null);
  assert.ok(fuzzyMatch("chat", "New chat").score < fuzzyMatch("chat", "Show / hide the sidebar in a chat").score);
});

test("wordPrefixAt only matches at the start of a word", () => {
  assert.equal(wordPrefixAt("tab", "Opens a new tab"), 12);
  assert.equal(wordPrefixAt("ab", "Opens a new tab"), -1);
  assert.equal(wordPrefixAt("NEW", "Opens a new tab"), 8);
});

const INDEX = [
  { tab: "chat", tabLabel: "Chat", heading: "Clicking a chat", description: "In the sidebar and search.", keywords: ["Opens a new tab", "Replaces the current tab"] },
  { tab: "chat", tabLabel: "Chat", heading: "Send key", description: "", keywords: ["Enter", "Ctrl+Enter"] },
  { tab: "appearance", tabLabel: "Appearance", heading: "Typography", description: "", keywords: ["Font"], advanced: true },
];

test("a heading matches loosely, other words by word prefix", () => {
  assert.equal(searchSettings(INDEX, "clk")[0].entry.heading, "Clicking a chat");
  const hit = searchSettings(INDEX, "new tab")[0];
  assert.equal(hit.entry.heading, "Clicking a chat");
  assert.equal(hit.detail, "Opens a new tab");
  assert.deepEqual(hit.detailMarks, [8, 9, 10, 12, 13, 14]);
  assert.equal(searchSettings(INDEX, "font")[0].entry.heading, "Typography");
  assert.deepEqual(searchSettings(INDEX, "  "), []);
  assert.deepEqual(searchSettings(INDEX, "zzz"), []);
});

test("a heading match has to read like an abbreviation, not letters strewn across it", () => {
  assert.deepEqual(headingMatch("chat", "Clicking a chat")?.indices, [11, 12, 13, 14], "not the leftmost c");
  assert.ok(headingMatch("lgt dark", "Light or dark"));
  assert.equal(headingMatch("tray", "Typography"), null);
  assert.equal(headingMatch("font", "File checkpoints"), null);
  assert.equal(scoreSetting(INDEX[2], "font") !== null, true, "found by keyword instead");
});

test("a long detail line is cut to show its mark", () => {
  const long = { tab: "x", tabLabel: "X", heading: "Thing", description: "word ".repeat(20) + "needle at the end", keywords: [] };
  const hit = searchSettings([long], "needle")[0];
  assert.ok(hit.detail.startsWith("…"));
  assert.equal(hit.detail.slice(hit.detailMarks[0], hit.detailMarks[0] + 6), "needle");
});

test("a heading hit outranks a keyword hit", () => {
  const hits = searchSettings(INDEX, "enter");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entry.heading, "Send key");
  const both = searchSettings([...INDEX, { tab: "voice", tabLabel: "Dictation", heading: "Enter to send", description: "", keywords: [] }], "enter");
  assert.equal(both[0].entry.heading, "Enter to send");
});

test("hits group by tab, best tab first, and marks become runs", () => {
  const groups = groupByTab(searchSettings(INDEX, "t"));
  assert.ok(groups.length >= 2);
  assert.deepEqual(new Set(groups.map((g) => g.tab)).size, groups.length);
  assert.deepEqual(markRuns("Send key", [0, 1, 5]), [
    { text: "Se", hit: true },
    { text: "nd ", hit: false },
    { text: "k", hit: true },
    { text: "ey", hit: false },
  ]);
});
