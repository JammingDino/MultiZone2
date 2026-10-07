/**
 * Math in study sets, repaired before it is drawn.
 *
 * Questions, options, cards and sheets reach the app as tool-call arguments,
 * which are JSON — and a model that writes `"$\frac{a}{b}$"` with one
 * backslash has written a form feed followed by `rac{a}{b}`. JSON's escapes
 * eat exactly the commands math leans on: `\f` (`\frac`, `\forall`), `\b`
 * (`\beta`, `\bar`, `\binom`), `\t` (`\theta`, `\times`, `\text`, `\to`),
 * `\r` (`\rho`, `\right`), `\n` (`\nabla`, `\neq`, `\nu`, `\not`). The
 * control characters they leave behind are put back as the commands they were.
 *
 * Short fields also arrive as bare LaTeX — an option that is just
 * `\sqrt{2}`, a card back of `x^{2} + 1` — which Markdown shows as source.
 * Those runs are wrapped in `$…$`.
 *
 * Code (fenced or inline) is never touched.
 */

/** Command tails JSON's `\n` can eat, matched only inside math. */
const N_TAILS =
  "abla|eq|e|u|ot|otin|i|eg|ewline|exists|mid|leq|geq|parallel|subseteq|supseteq|subset|supset|" +
  "less|gtr|cong|sim|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|prec|succ|vdash|ormalsize";
const EATEN_N = new RegExp(`\\n(?=(?:${N_TAILS})(?![a-zA-Z]))`, "g");
const MATH_SPAN = /\$\$[\s\S]+?\$\$|\$[^$]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g;
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

function outsideCode(src: string, fn: (text: string) => string): string {
  return src
    .split(CODE)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join("");
}

/** Put back the LaTeX commands JSON string escapes turned into control characters. */
export function repairLatexEscapes(src: string): string {
  if (!src || !/[\f\b\v\t\r\n]/.test(src)) return src;
  return outsideCode(src, (text) => {
    let out = text
      // Never meant in prose at all.
      .replace(/\f/g, "\\f")
      .replace(/\x08/g, "\\b")
      .replace(/\v/g, "\\v")
      // A real carriage return is followed by \n; a real tab by a space or digit far more often than a letter.
      .replace(/\r(?=[a-zA-Z])/g, "\\r")
      .replace(/\t(?=[a-zA-Z])/g, "\\t");
    // A line break followed by "abla" is \nabla only inside math; outside it,
    // "\nnot" is just a line starting with "not".
    if (out.includes("\n")) out = out.replace(MATH_SPAN, (m) => m.replace(EATEN_N, "\\n"));
    return out;
  });
}

/** Commands that mark a run of text as math when no delimiter says so. */
const MATH_COMMANDS =
  "frac|dfrac|tfrac|sqrt|binom|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|" +
  "lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|" +
  "Phi|Psi|Omega|sum|prod|int|iint|oint|lim|infty|partial|nabla|cdot|cdots|ldots|times|div|pm|mp|leq|geq|le|ge|" +
  "neq|ne|approx|equiv|sim|propto|in|notin|subset|subseteq|cup|cap|emptyset|forall|exists|to|rightarrow|" +
  "Rightarrow|leftarrow|leftrightarrow|Leftrightarrow|mapsto|log|ln|exp|sin|cos|tan|sec|csc|cot|arcsin|" +
  "arccos|arctan|sinh|cosh|tanh|max|min|det|vec|hat|bar|dot|ddot|tilde|overline|underline|mathbf|mathrm|" +
  "mathbb|mathcal|boldsymbol|text|left|right|langle|rangle|circ|angle|perp|parallel|degree|ce|pu";
// A command, `^{`/`_{`, `x^2`, or a one-letter base with a subscript (`v_0`,
// but not `file_name`, which is an identifier).
const STRONG = new RegExp(
  `\\\\(?:${MATH_COMMANDS})(?![a-zA-Z])|[\\^_]\\{|[a-zA-Z0-9)]\\^[-a-zA-Z0-9(]|(?<![a-zA-Z0-9])[a-zA-Z]_[a-zA-Z0-9](?![a-zA-Z0-9])`,
);
/**
 * Tokens that carry a math run along between strong ones: operators, numbers,
 * one-letter variables. Not "a", "A" or "I", which are words.
 */
const WEAK = /^(?:[-+*/=<>≤≥≠±×÷(),.]+|\d+(?:\.\d+)?[,.]?|\(?(?![aAI]\b)[a-zA-Z]\)?[,.]?)$/;

/** Split on whitespace outside braces, keeping the whitespace. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur);
      out.push(ch);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Wrap bare LaTeX in `$…$`. A field that already has any math delimiter is
 * left as written: the model was using delimiters, and a stray `^` in its
 * prose is not ours to reinterpret. So is one with a bare `\begin{…}`, which
 * `normalizeMath` lifts whole, with the math around it, into a display block.
 */
export function wrapBareLatex(src: string): string {
  if (!src || /\$|\\\(|\\\[|\\begin\{/.test(src) || !STRONG.test(src)) return src;
  return outsideCode(src, (text) => {
    if (!STRONG.test(text)) return text;
    const toks = tokens(text);
    const kind = toks.map((t) => (/^\s$/.test(t) ? "space" : STRONG.test(t) ? "strong" : WEAK.test(t) ? "weak" : "prose"));
    // A run is strong tokens plus the weak ones and spaces between them,
    // grown outwards over adjacent weak tokens (`x = \frac{1}{2}`).
    const inRun = kind.map((k) => k === "strong");
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < toks.length; i++) {
        if (inRun[i] || kind[i] === "prose" || kind[i] === "space") continue;
        const left = nearest(inRun, kind, i, -1);
        const right = nearest(inRun, kind, i, 1);
        if (left || right) inRun[i] = true;
      }
    }
    let out = "";
    let i = 0;
    while (i < toks.length) {
      if (!inRun[i]) {
        out += toks[i++];
        continue;
      }
      let j = i;
      let end = i;
      while (j < toks.length && (inRun[j] || kind[j] === "space")) {
        if (inRun[j]) end = j;
        j++;
      }
      const run = toks.slice(i, end + 1).join("");
      // Sentence punctuation stays outside the math.
      const m = /^(.*?)([.,;:!?]?)$/s.exec(run)!;
      out += `$${m[1]}$${m[2]}`;
      i = end + 1;
    }
    return out;
  });
}

/** Whether the nearest non-space token in direction `dir` is in a run. */
function nearest(inRun: boolean[], kind: string[], i: number, dir: 1 | -1): boolean {
  for (let j = i + dir; j >= 0 && j < kind.length; j += dir) {
    if (kind[j] === "space") continue;
    return inRun[j];
  }
  return false;
}

/** Everything above, for one field of a study set. */
export function studyMath(src: string | null | undefined): string {
  if (!src) return "";
  return wrapBareLatex(repairLatexEscapes(src));
}
