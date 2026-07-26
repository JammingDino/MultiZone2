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
 */
export function normalizeMath(src: string): string {
  if (
    !src ||
    (!src.includes("\\[") && !src.includes("\\(") && !src.includes("$$") && !src.includes("\\begin{"))
  ) {
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
  // Collapse the runs of blank lines the insertions may have produced.
  return out.replace(/\n{3,}/g, "\n\n");
}

function blockMath(inner: string): string {
  return "\n\n$$\n" + inner.trim() + "\n$$\n\n";
}
