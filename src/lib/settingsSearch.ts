/**
 * Settings search (0.21): matching and ranking over the index that
 * scripts/gen-settings-index.mjs reads out of the Settings tabs.
 */

/** One `<h3>` section of a Settings tab. */
export type SettingsEntry = {
  tab: string;
  tabLabel: string;
  heading: string;
  description: string;
  /** Other words the section shows: toggle and option labels, help text. */
  keywords: string[];
  /** Folded under the tab's "Advanced" disclosure. */
  advanced?: true;
};

export type SettingsHit = {
  entry: SettingsEntry;
  score: number;
  /** Indices into `entry.heading` to mark. */
  headingMarks: number[];
  /** The line that explains the match: a description or keyword, or "". */
  detail: string;
  detailMarks: number[];
};

/**
 * Subsequence match, the standard palette contract: the query's characters must
 * appear in order but not adjacently, so "nwc" finds "New chat" and "zonlib"
 * finds "Zone library".
 *
 * Returns a score (lower is better) and the matched indices, or null for no
 * match. Consecutive runs and matches at a word boundary score better, which is
 * what makes a short query put the obvious answer first instead of whichever
 * item happened to be built earliest.
 */
export function fuzzyMatch(query: string, text: string, from = 0): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let ti = from;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;
    // Distance from the previous match is the gap we skipped over.
    score += found - prevMatch - 1;
    // A match at the start of a word is worth more than one mid-word.
    if (found === 0 || /[\s\-_/:]/.test(t[found - 1] ?? "")) score -= 2;
    indices.push(found);
    prevMatch = found;
    ti = found + 1;
  }
  // Prefer shorter targets when the match is otherwise equal, so "chat" ranks
  // "New chat" above "Show / hide the sidebar in a chat".
  return { score: score + t.length * 0.01, indices };
}

/** Where `word` starts a word of `text` (case-insensitive), or -1. */
export function wordPrefixAt(word: string, text: string): number {
  const t = text.toLowerCase();
  const w = word.toLowerCase();
  for (let i = t.indexOf(w); i !== -1; i = t.indexOf(w, i + 1)) {
    if (i === 0 || !/[\p{L}\p{N}]/u.test(t[i - 1])) return i;
  }
  return -1;
}

const range = (start: number, len: number) => Array.from({ length: len }, (_, i) => start + i);
const atWordStart = (t: string, i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(t[i - 1]);

/**
 * A subsequence match on a heading that a person would make: jumps to the start
 * of a word are free, and the letters skipped inside words add up to no more
 * than the query is long. "lgt dark" finds "Light or dark"; "tray" does not
 * find "Typography". Tried from every place the first letter occurs, because
 * the leftmost one is often the wrong word ("chat" in "Clicking a chat").
 */
export function headingMatch(q: string, heading: string): { score: number; indices: number[] } | null {
  const t = heading.toLowerCase();
  let best: { score: number; indices: number[] } | null = null;
  for (let at = t.indexOf(q[0]?.toLowerCase()); at !== -1; at = t.indexOf(q[0].toLowerCase(), at + 1)) {
    const m = fuzzyMatch(q, heading, at);
    if (!m) break;
    let skipped = 0;
    for (let i = 1; i < m.indices.length; i++) {
      if (!atWordStart(t, m.indices[i])) skipped += m.indices[i] - m.indices[i - 1] - 1;
    }
    if (skipped <= q.length && (!best || m.score < best.score)) best = m;
  }
  return best;
}

/** Long lines are cut to start near their first mark, so the mark is on screen. */
function snippet(text: string, marks: number[]): { detail: string; detailMarks: number[] } {
  const first = Math.min(...marks);
  if (!marks.length || first < 48) return { detail: text, detailMarks: marks };
  const cut = text.lastIndexOf(" ", first - 16) + 1;
  return { detail: "…" + text.slice(cut), detailMarks: marks.map((m) => m - cut + 1) };
}

function matchEntry(entry: SettingsEntry, q: string): Omit<SettingsHit, "entry"> | null {
  // The heading is what people remember, so it gets the forgiving match.
  const hm = headingMatch(q, entry.heading);
  if (hm) return { score: hm.score, headingMarks: hm.indices, detail: entry.description, detailMarks: [] };

  // Otherwise every word has to start a word somewhere in the section, so
  // "new tab" finds "Clicking a chat" by its option "Opens a new tab".
  const fields = [
    { text: entry.heading, cost: 0 },
    { text: entry.tabLabel, cost: 2 },
    { text: entry.description, cost: 4 },
    ...entry.keywords.map((text) => ({ text, cost: 6 })),
  ];
  let score = 10;
  const headingMarks: number[] = [];
  let detail = "";
  let detailMarks: number[] = [];
  for (const word of q.split(/\s+/)) {
    const f = fields.find((f) => wordPrefixAt(word, f.text) !== -1);
    if (!f) return null;
    const at = wordPrefixAt(word, f.text);
    score += f.cost;
    if (f.text === entry.heading) headingMarks.push(...range(at, word.length));
    else if (f.cost >= 4 && (!detail || detail === f.text)) {
      detail = f.text;
      detailMarks = [...detailMarks, ...range(at, word.length)];
    }
  }
  return detail ? { score, headingMarks, ...snippet(detail, detailMarks) } : { score, headingMarks, detail: entry.description, detailMarks: [] };
}

/** One entry's score against `query` (lower is better), or null — for the command palette. */
export function scoreSetting(entry: SettingsEntry, query: string): number | null {
  const q = query.trim().replace(/\s+/g, " ");
  return q ? (matchEntry(entry, q)?.score ?? null) : null;
}

/** Every section matching `query`, best first. */
export function searchSettings(index: SettingsEntry[], query: string, limit = 50): SettingsHit[] {
  const q = query.trim().replace(/\s+/g, " ");
  if (!q) return [];
  const hits: SettingsHit[] = [];
  for (const entry of index) {
    const m = matchEntry(entry, q);
    if (m) hits.push({ entry, ...m });
  }
  // Stable sort keeps the tabs' own order between equal scores.
  return hits.sort((a, b) => a.score - b.score).slice(0, limit);
}

/** Hits grouped by tab, the tab with the best hit first. */
export function groupByTab(hits: SettingsHit[]): { tab: string; tabLabel: string; hits: SettingsHit[] }[] {
  const groups = new Map<string, { tab: string; tabLabel: string; hits: SettingsHit[] }>();
  for (const h of hits) {
    const g = groups.get(h.entry.tab) ?? { tab: h.entry.tab, tabLabel: h.entry.tabLabel, hits: [] };
    g.hits.push(h);
    groups.set(h.entry.tab, g);
  }
  return [...groups.values()];
}

/** Split `text` into runs, marked where `marks` says, for rendering a match. */
export function markRuns(text: string, marks: number[]): { text: string; hit: boolean }[] {
  const set = new Set(marks);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}
