// A `/skill` typed in a prompt, as the message records it (0.21.0).

import test from "node:test";
import assert from "node:assert/strict";
import { parseSkillPart, skillPartText } from "../src/lib/skillRuns.ts";

test("a written skill part reads back as its name, files and first line", () => {
  const text = skillPartText("review", "# Review\n\nRead the change end to end.\nThen report.", ["checklist.md", "severity.md"]);
  assert.match(text, /^The user ran the \/review skill\./);
  assert.match(text, /already in effect/);
  assert.deepEqual(parseSkillPart(text), {
    name: "review",
    files: ["checklist.md", "severity.md"],
    excerpt: "Read the change end to end.",
  });
});

test("a skill with no extra files has none", () => {
  assert.deepEqual(parseSkillPart(skillPartText("about-this-app", "Plain first line.", [])), {
    name: "about-this-app",
    files: [],
    excerpt: "Plain first line.",
  });
});

test("the 0.20.1 wording still parses, so older chats keep their runs", () => {
  const old = 'The user invoked /simplify in their message. Apply this skill to it — its instructions:\n\nClean up.\n\nThis skill has more files, read with load_skill {"name": "simplify", "file": …} as its instructions direct: a.md, b.md';
  assert.deepEqual(parseSkillPart(old), { name: "simplify", files: ["a.md", "b.md"], excerpt: "Clean up." });
});

test("other hidden parts are not skills", () => {
  assert.equal(parseSkillPart("File: notes.md\n```\nhi\n```"), null);
  assert.equal(parseSkillPart("The user ran the tests."), null);
});
