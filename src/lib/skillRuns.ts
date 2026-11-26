/**
 * A `/skill` typed in a prompt, as the message records it (0.21.0).
 *
 * When a prompt is sent, each `/skill` in it is loaded and its instructions go
 * to the model as a hidden part (`skillParts` in PromptHighlight.tsx). That
 * part is the only record that the skill ran, so this file is the one place
 * that knows its shape: the composer writes it with `skillPartText` and the
 * transcript's run blocks read it back with `parseSkillPart`.
 */

/**
 * The hidden part for one loaded skill. Worded so the model knows the app has
 * already run the command: an earlier "The user invoked /x … Apply this skill"
 * led models to report that `/x` "isn't installed as a slash command", reading
 * it as a CLI command that failed rather than a skill that was applied.
 */
export function skillPartText(name: string, instructions: string, files: string[]): string {
  const more = files.length
    ? `\n\nThis skill has more files, read with load_skill {"name": "${name}", "file": …} as its instructions direct: ${files.join(", ")}`
    : "";
  return `The user ran the /${name} skill. MultiZone loaded it when the message was sent, so it is not a missing or unavailable command: its instructions are below and are already in effect for this turn. Follow them, and do not tell the user the command did not run.\n\n${instructions}${more}`;
}

export type SkillPart = {
  name: string;
  /** The skill's extra files, beyond its instructions. */
  files: string[];
  /** The instructions' first line of prose, for a run's detail. */
  excerpt: string;
};

// The current wording, and the 0.20.1 one that chats sent before it carry.
const HEAD = /^The user (?:ran the \/([\w.:-]+) skill\.|invoked \/([\w.:-]+) in their message\.)[^\n]*\n\n/;
const FILES = /\n\nThis skill has more files[^\n]*? as its instructions direct: ([^\n]*)$/;

/** The skill a hidden part loaded, or null when the part is something else. */
export function parseSkillPart(text: string): SkillPart | null {
  const head = HEAD.exec(text);
  if (!head) return null;
  let body = text.slice(head[0].length);
  const tail = FILES.exec(body);
  if (tail) body = body.slice(0, tail.index);
  const line = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("---")) ?? "";
  return {
    name: head[1] ?? head[2],
    files: tail ? tail[1].split(", ").filter(Boolean) : [],
    excerpt: line.length > 160 ? `${line.slice(0, 157)}…` : line,
  };
}
