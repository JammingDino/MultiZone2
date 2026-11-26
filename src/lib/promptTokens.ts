/**
 * Commands and folders as words in a prompt (0.20.1).
 *
 * Claude Code runs a slash command only as the whole message. Here `/name` is
 * a word anywhere a word starts — `/review the parser, then /commit` is one
 * message — and a folder handed to the chat sits in the text as its path. These
 * are the pure parts: where the caret's `/word` is, and how a prompt splits
 * into prose, commands and paths for the composer's overlay and the transcript.
 */

/** A command name: no spaces, no second slash (so `/usr/bin` is a path, not a command). */
const NAME = /^[\w.:-]*$/;

/** The `/word` the caret is in, or null. It must start a word. */
export function slashAt(text: string, caret: number): { start: number; end: number; query: string } | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const word = text.slice(start, end);
  if (!word.startsWith("/")) return null;
  const query = text.slice(start + 1, caret);
  if (!NAME.test(word.slice(1))) return null;
  return { start, end, query };
}

export type Segment = { kind: "text" | "command" | "path"; text: string };

/**
 * Split a prompt into prose, known `/commands` (matched case-insensitively,
 * whole words only) and occurrences of the given paths.
 */
export function segments(text: string, commands: Set<string>, paths: string[] = []): Segment[] {
  const marks: { start: number; end: number; kind: "command" | "path" }[] = [];
  const cmd = /(^|\s)\/([\w.:-]+)(?=\s|$)/g;
  for (let m; (m = cmd.exec(text)); ) {
    if (commands.has(m[2].toLowerCase())) {
      const start = m.index + m[1].length;
      marks.push({ start, end: start + 1 + m[2].length, kind: "command" });
    }
  }
  // Longest first, so a granted folder inside another one marks the longer path.
  for (const p of [...paths].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (let i = text.indexOf(p); i !== -1; i = text.indexOf(p, i + p.length)) {
      if (!marks.some((m) => i < m.end && i + p.length > m.start)) {
        marks.push({ start: i, end: i + p.length, kind: "path" });
      }
    }
  }
  marks.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start > at) out.push({ kind: "text", text: text.slice(at, m.start) });
    out.push({ kind: m.kind, text: text.slice(m.start, m.end) });
    at = m.end;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/** The distinct known commands a prompt invokes, in the order they appear. */
export function commandsIn(text: string, commands: Set<string>): string[] {
  const seen: string[] = [];
  for (const s of segments(text, commands)) {
    const name = s.text.slice(1);
    if (s.kind === "command" && !seen.some((n) => n.toLowerCase() === name.toLowerCase())) seen.push(name);
  }
  return seen;
}

/**
 * The prompt with each `/name` word taken out, and the space after it — for a
 * command that acts rather than being sent (`/plan`). Other spacing is left
 * alone, so indented code in the prompt survives.
 */
export function withoutCommand(text: string, name: string): string {
  const word = name.replace(/\./g, "\\.");
  return text.replace(new RegExp(`(^|\\s)/${word}(?=\\s|$)[ \\t]?`, "gi"), "$1").trim();
}

/** Put `insert` in place of `[start, end)`, returning the text and where the caret goes. */
export function replaceRange(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}
