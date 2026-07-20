/**
 * On-disk format for an exported skill: YAML frontmatter carrying the fields
 * that live outside the body (name, description) followed by the skill content.
 *
 * Export previously wrote the bare content, so importing on another machine
 * recovered the name from the filename and dropped the description entirely.
 * Files in the old format still import cleanly — they simply have no
 * frontmatter, and the caller's filename fallback supplies the name.
 */

export type SkillSeed = { name: string; description: string; content: string };

/** Quote a scalar so colons/newlines in a description can't break the block. */
function yamlScalar(v: string): string {
  return JSON.stringify(v.replace(/\r?\n/g, " ").trim());
}

export function serializeSkill(name: string, description: string, content: string): string {
  const lines = ["---", `name: ${yamlScalar(name.trim())}`];
  if (description.trim()) lines.push(`description: ${yamlScalar(description.trim())}`);
  lines.push("---", "", content.replace(/^﻿/, ""));
  return lines.join("\n");
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Read a scalar that may be JSON-quoted (as we write it) or bare (hand-authored). */
function readScalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    try {
      return JSON.parse(v.startsWith("'") ? `"${v.slice(1, -1)}"` : v);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

export function parseSkill(raw: string, fallbackName: string): SkillSeed {
  const m = FRONTMATTER.exec(raw);
  if (!m) return { name: fallbackName, description: "", content: raw };

  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1].toLowerCase()] = readScalar(kv[2]);
  }
  return {
    name: fields.name || fallbackName,
    description: fields.description ?? "",
    content: raw.slice(m[0].length),
  };
}
