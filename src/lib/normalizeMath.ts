/**
 * Normalize the LaTeX delimiters an LLM tends to emit into the `$` / `$$` forms
 * that remark-math actually understands, so display math renders as a centered
 * block instead of being squeezed inline (or dropped entirely).
 *
 * remark-math v6 only recognizes dollar delimiters, and only treats `$$…$$` as a
 * display block when it sits on its own lines. Two things therefore go wrong with
 * typical model output:
 *
 *  1. Models very often wrap display math in `\[ … \]` and inline math in
 *     `\( … \)`. remark-math recognizes neither, so `\[ … \]` reaches the page as
 *     literal backslash-bracket text and never becomes math at all.
 *  2. A `$$ … $$` block written inline inside a sentence is parsed as *inline*
 *     math, which KaTeX then renders in the cramped inline style rather than the
 *     centered display style the author meant.
 *
 * We fix both by converting `\[…\]` → block `$$…$$` and `\(…\)` → inline `$…$`,
 * and by lifting every `$$…$$` onto its own lines so remark-math's block math
 * picks it up. Code — fenced blocks and inline spans — is left untouched so a
 * shell snippet like `arr\[i\]`, a regex, or a literal `$$` is never rewritten.
 *
 * We also star unstarred amsmath environments (`align` → `align*`, etc.). KaTeX
 * auto-numbers those via a CSS counter (`.eqn-num`) that is reset only once, on
 * `body` — this app's `<body>` never re-renders, so the counter climbs forever
 * across every message in the session rather than resetting per equation. The
 * numbering also renders in an absolutely-positioned `.tag` column that widens
 * the equation's effective box past its container, tripping `.katex-display`'s
 * `overflow-x: auto` into showing a scrollbar on equations that otherwise fit.
 * None of that numbering means anything in a chat transcript — nothing ever
 * cross-references "equation (7)" — so we suppress it outright rather than try
 * to rescope a counter we don't control.
 *
 * Two more repairs, both about text a model wrote without delimiters:
 *
 *  - A bare `\begin{aligned} … \end{aligned}` (or `cases`, `pmatrix`, …) with
 *    no `$$` around it is lifted into a display block. Left alone it reaches
 *    the page as raw LaTeX.
 *  - A `$` that cannot pair is escaped, so "costs $5 and $10" stays prose
 *    instead of becoming the formula "5 and ". The rule is pandoc's, relaxed
 *    for the `$ x $` models write: an opening `$` followed by a digit only
 *    closes on a `$` with no space before it, and no closing `$` is followed
 *    by a digit.
 */
export function normalizeMath(src: string): string {
  if (!src || (!src.includes("\\[") && !src.includes("\\(") && !src.includes("$") && !src.includes("\\begin{"))) {
    // Nothing to normalize — skip the split/rejoin work on ordinary prose.
    return src;
  }
  // Split into code / non-code segments; only the non-code parts are rewritten.
  // The capturing group keeps the code segments in the array (odd indices).
  const parts = src.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g);
  return parts.map((seg, i) => (i % 2 === 1 ? seg : rewriteSegment(seg))).join("");
}

// amsmath environments KaTeX auto-numbers when unstarred.
const NUMBERED_ENV = /\\(begin|end)\{(align|alignat|gather|equation|multline|flalign|eqnarray)\}/g;

function rewriteSegment(text: string): string {
  let out = text;
  // Star numbered environments first — before the delimiter rewrites below, so
  // it runs once on the source form regardless of which delimiter wraps it.
  out = out.replace(NUMBERED_ENV, (_m, kind, env) => `\\${kind}{${env}*}`);
  // \[ … \]  →  display block
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner) => blockMath(inner));
  // \( … \)  →  inline
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner) => "$" + inner.trim() + "$");
  // Any $$ … $$ (including those just produced above) onto their own lines so
  // remark-math renders them as a display block, not inline. Idempotent: a block
  // that was already standalone comes back the same after the newline collapse.
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner) => blockMath(inner));
  // Outside the display blocks: bare environments become blocks, and lone
  // dollars are escaped. Split again, since the step above made new blocks.
  out = out
    .split(/(\$\$[\s\S]*?\$\$)/g)
    .map((piece, i) => (i % 2 === 1 ? piece : escapeLoneDollars(liftBareEnvironments(piece))))
    .join("");
  // Collapse the runs of blank lines the insertions may have produced.
  return out.replace(/\n{3,}/g, "\n\n");
}

// Math environments KaTeX renders, which only work inside math. Starred forms
// are covered by the optional `*`.
const MATH_ENV =
  "aligned|align|alignat|alignedat|gathered|gather|equation|multline|split|cases|dcases|rcases|" +
  "matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|array|darray|subarray|CD";
const BARE_ENV = new RegExp(`\\\\begin\\{(${MATH_ENV})(\\*?)\\}[\\s\\S]*?\\\\end\\{\\1\\2\\}`, "g");

const BARE_ENV_AT = new RegExp(BARE_ENV.source, "y");

/**
 * Whether a whitespace-separated word reads as math rather than prose: once
 * brace contents and `\commands` are set aside, no run of two letters is left.
 * `^{-1}`, `=`, `\frac{1}{ad-bc}` and `x` are math; "Solve" and "now" are not.
 */
function isMathyWord(word: string): boolean {
  let s = word;
  for (let i = 0; i < 8 && /\{[^{}]*\}/.test(s); i++) s = s.replace(/\{[^{}]*\}/g, "");
  s = s.replace(/\\[a-zA-Z]+/g, "");
  return !/[a-zA-Z]{2}/.test(s) && !s.includes("$");
}

/**
 * `\begin{cases}…\end{cases}` outside any `$`, as a display block — together
 * with the math around it on its line, so `\begin{pmatrix}…\end{pmatrix}^{-1}
 * = \frac{1}{ad-bc}\begin{pmatrix}…\end{pmatrix}` becomes one equation, not two
 * matrices with raw LaTeX stranded between them. Prose either side stays prose.
 */
function liftBareEnvironments(text: string): string {
  if (!text.includes("\\begin{")) return text;
  // Only the gaps between inline `$…$` spans are rewritten.
  return text
    .split(/((?<!\\)\$[^$]+?(?<!\\)\$)/g)
    .map((piece, i) => (i % 2 === 1 ? piece : liftIn(piece)))
    .join("");
}

function liftIn(text: string): string {
  let out = "";
  let pos = 0;
  BARE_ENV.lastIndex = 0;
  for (let m = BARE_ENV.exec(text); m; m = BARE_ENV.exec(text)) {
    // Leftwards over mathy words on the same line.
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    let start = m.index;
    const before = [...text.slice(Math.max(lineStart, pos), m.index).matchAll(/\S+/g)];
    for (let w = before.length - 1; w >= 0 && isMathyWord(before[w][0]); w--) {
      start = Math.max(lineStart, pos) + before[w].index!;
    }
    // Rightwards over mathy words and further environments.
    let end = m.index + m[0].length;
    for (;;) {
      const at = end + /^[ \t]*/.exec(text.slice(end))![0].length;
      if (text.startsWith("\\begin{", at)) {
        BARE_ENV_AT.lastIndex = at;
        const env = BARE_ENV_AT.exec(text);
        if (!env) break;
        end = at + env[0].length;
        continue;
      }
      const word = /^\S+/.exec(text.slice(at))?.[0];
      if (!word) break;
      const cut = word.indexOf("\\begin{");
      const head = cut > 0 ? word.slice(0, cut) : word;
      if (!isMathyWord(head)) break;
      end = at + head.length;
    }
    // A full stop after the equation goes inside it, as it would in LaTeX,
    // rather than alone on a line under it.
    out += text.slice(pos, start).replace(/[ \t]+$/, "") + blockMath(text.slice(start, end));
    pos = end + /^[ \t]*/.exec(text.slice(end))![0].length;
    BARE_ENV.lastIndex = end;
  }
  return out + text.slice(pos);
}

/**
 * Escape every single `$` that cannot pair (see the module comment), and leave
 * the pairs alone. Never pairs across a blank line: an unclosed `$` in one
 * paragraph does not swallow the next.
 */
export function escapeLoneDollars(text: string): string {
  if (!text.includes("$")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c !== "$") {
      out += c;
      i++;
      continue;
    }
    // `$$` here is a display delimiter still streaming in — not ours to judge.
    if (text[i + 1] === "$") {
      out += "$$";
      i += 2;
      continue;
    }
    const close = closerFor(text, i);
    if (close < 0) {
      out += "\\$";
      i++;
    } else {
      out += text.slice(i, close + 1);
      i = close + 1;
    }
  }
  return out;
}

function closerFor(text: string, open: number): number {
  const next = text[open + 1];
  if (next === undefined) return -1;
  const money = /\d/.test(next);
  for (let j = open + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "\n" && /^\n[ \t]*\n/.test(text.slice(j, j + 64))) return -1;
    if (c !== "$") continue;
    if (j === open + 1) return -1;
    if (/\d/.test(text[j + 1] ?? "")) return -1;
    if (money && /\s/.test(text[j - 1])) return -1;
    return j;
  }
  return -1;
}

function blockMath(inner: string): string {
  return "\n\n$$\n" + inner.trim() + "\n$$\n\n";
}
