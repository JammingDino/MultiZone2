/**
 * Splits a markdown document into top-level block groups.
 *
 * Streaming re-renders re-parse whatever they are handed, so handing the
 * renderer the whole answer on every tick makes the cost of one tick grow with
 * the length of the answer — which is why a long answer (and worse, two of
 * them at once) turns jittery near the end. Everything above the last blank
 * line is finished text that can no longer change, so it is split off into
 * groups that are parsed once each and then left alone; only the trailing
 * group is re-parsed as tokens arrive.
 *
 * The split is deliberately conservative: it happens only at a blank line that
 * is genuinely at the top level, and adjacent groups are re-joined wherever
 * splitting them would change what markdown means (see `mergeContinuations`).
 */

/** Opening or closing fence: three or more backticks/tildes, indented < 4. */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
/** Bullet or ordered list item. */
const LIST_RE = /^\s{0,3}(?:[-*+]\s|\d{1,9}[.)]\s)/;
/** Blockquote line. */
const QUOTE_RE = /^\s{0,3}>/;
/** Indented continuation — a paragraph belonging to the list item above it. */
const INDENT_RE = /^\s{2,}\S/;
/**
 * Reference-style link and footnote definitions sit at the bottom of a
 * document but change how text *above* them renders, so a document using them
 * cannot be parsed group by group. Rare enough to be worth simply opting out.
 */
const REF_DEF_RE = /^\s{0,3}\[(?:\^)?[^\]]+\]:\s/m;

export interface MarkdownSplit {
  /** Finished groups, in order. Each is stable once it appears. */
  settled: string[];
  /** The trailing group — the only part a streaming update can still change. */
  tail: string;
}

/** True when the line closes a fence opened with `open`. */
function closesFence(line: string, open: string): boolean {
  const m = FENCE_RE.exec(line);
  if (!m) return false;
  const marker = m[1];
  return marker[0] === open[0] && marker.length >= open.length && /^\s*$/.test(line.slice(m[0].length));
}

/** Number of non-overlapping matches of `re` (which must be global) in `line`. */
function count(line: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(line) !== null) n += 1;
  return n;
}

const DOLLARS_RE = /\$\$/g;
const MATH_OPEN_RE = /\\\[/g;
const MATH_CLOSE_RE = /\\\]/g;
const ENV_OPEN_RE = /\\begin\{/g;
const ENV_CLOSE_RE = /\\end\{/g;

/**
 * Splits on blank lines that are genuinely at the top level — not inside a code
 * fence, and not inside a display-math region. Models routinely write math that
 * spans a blank line (`$$ … $$`, `\[ … \]`, `\begin{align} … \end{align}`), and
 * normalizeMath rewrites those as whole units, so cutting one in half would
 * leave two fragments that render as literal LaTeX.
 */
function rawBlocks(src: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  let dollarOpen = false;
  let mathDepth = 0;

  const flush = () => {
    if (cur.length > 0) blocks.push(cur.join("\n"));
    cur = [];
  };

  for (const line of src.split("\n")) {
    if (fence !== null) {
      cur.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (line.trim() === "" && !dollarOpen && mathDepth === 0) {
      flush();
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open) {
      fence = open[1];
    } else {
      if (count(line, DOLLARS_RE) % 2 === 1) dollarOpen = !dollarOpen;
      mathDepth +=
        count(line, MATH_OPEN_RE) - count(line, MATH_CLOSE_RE) +
        count(line, ENV_OPEN_RE) - count(line, ENV_CLOSE_RE);
      if (mathDepth < 0) mathDepth = 0;
    }
    cur.push(line);
  }
  flush();
  return blocks;
}

/**
 * Re-joins groups whose separation would change the rendering: a blank line
 * between list items makes a *loose* list, not two lists — splitting there
 * would restart an ordered list's numbering — and the same holds for an
 * indented paragraph under an item, or a blockquote broken by a blank line.
 */
function mergeContinuations(blocks: string[]): string[] {
  const merged: string[] = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    const continuesList = prev !== undefined && LIST_RE.test(prev) && (LIST_RE.test(block) || INDENT_RE.test(block));
    const continuesQuote = prev !== undefined && QUOTE_RE.test(prev) && QUOTE_RE.test(block);
    if (continuesList || continuesQuote) {
      merged[merged.length - 1] = `${prev}\n\n${block}`;
    } else {
      merged.push(block);
    }
  }
  return merged;
}

export function splitMarkdownBlocks(src: string): MarkdownSplit {
  if (REF_DEF_RE.test(src)) return { settled: [], tail: src };
  const blocks = mergeContinuations(rawBlocks(src));
  if (blocks.length === 0) return { settled: [], tail: "" };
  return { settled: blocks.slice(0, -1), tail: blocks[blocks.length - 1] };
}
