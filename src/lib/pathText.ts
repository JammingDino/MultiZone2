/**
 * Filesystem paths in pasted text (0.19.3).
 *
 * A pasted path stays in the message as text — pasted text is often just text.
 * What this finds is offered as a one-click "Give access" chip instead, and
 * only once the desktop confirms the path exists. So this is deliberately
 * narrow: absolute Windows paths (`C:\…`, `\\server\share\…`), one per line,
 * with the double quotes Explorer's *Copy as path* adds, or single ones.
 * Prose that merely mentions a drive letter in passing is not matched — the
 * path has to be the line, or a whole quoted run within it.
 *
 * Kept free of imports so the tests in `scripts/` can load it directly.
 */

const MAX_PATHS = 10;

const DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\[^\\/\s]+[\\/][^\\/\s]+/;

function isAbsoluteWindowsPath(s: string): boolean {
  return DRIVE.test(s) || UNC.test(s);
}

/** Strip one layer of matching quotes and surrounding whitespace. */
export function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1).trim();
  }
  return t;
}

export function findPaths(text: string): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    const cleaned = p.replace(/[\\/]+$/, (m) => (/^[A-Za-z]:[\\/]$/.test(p) ? m : ""));
    if (isAbsoluteWindowsPath(cleaned) && !out.includes(cleaned)) out.push(cleaned);
  };
  for (const rawLine of text.split(/\r?\n/)) {
    if (out.length >= MAX_PATHS) break;
    const line = rawLine.trim();
    if (!line) continue;
    // Several quoted paths on one line: Explorer's "Copy as path" with more
    // than one item selected puts them on separate lines, but people join them.
    const quoted = [...line.matchAll(/"([^"\r\n]+)"/g)].map((m) => m[1]);
    if (quoted.length > 0 && quoted.every((q) => isAbsoluteWindowsPath(q.trim()))) {
      for (const q of quoted) {
        if (out.length >= MAX_PATHS) break;
        add(q.trim());
      }
      continue;
    }
    const bare = unquote(line);
    // A path with spaces is fine; a line of prose that starts with one is not.
    // Paths don't contain these, sentences usually do.
    if (/[<>|*?]/.test(bare.slice(2))) continue;
    add(bare);
  }
  return out.slice(0, MAX_PATHS);
}
