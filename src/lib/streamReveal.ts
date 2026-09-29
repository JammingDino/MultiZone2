/**
 * How streamed text arrives on screen (0.18.3).
 *
 * A model's tokens do not come evenly: a burst of forty characters, a pause, a
 * burst of three. Shown as they land, an answer lurches. Two things smooth it:
 *
 * - **Pacing** (`step`): the view reveals characters at a rate proportional to
 *   how far it is behind, so bursts are spread out and pauses are bridged. It
 *   trails the model by about `smoothMs`, and keeps going after the stream
 *   ends until it has caught up.
 * - **A reveal animation** (`rehypeReveal`): each newly shown character or
 *   word is its own span with a CSS animation that plays when it mounts.
 *   React keys spans by position, so text already on screen never replays.
 */

export type RevealUnit = "char" | "word" | "adaptive";

/** Slowest the reveal ever goes, chars/ms, so the last few characters come. */
const MIN_RATE = 0.03;
/** Above this (chars/ms), "adaptive" reveals whole words — fast text reads better in words. */
const WORD_RATE = 0.06;

/**
 * One tick of the reveal. `pos` is the fractional position reached so far,
 * `shown` how many characters are on screen; returns the new position and how
 * far to show. Pure, so the pacing is testable without a clock.
 */
export function step(
  src: string,
  pos: number,
  shown: number,
  dt: number,
  smoothMs: number,
  unit: RevealUnit,
): { pos: number; end: number } {
  const len = src.length;
  if (smoothMs <= 0 || pos >= len) return { pos: len, end: len };
  const rate = Math.max((len - pos) / smoothMs, MIN_RATE);
  const next = Math.min(len, pos + rate * dt);
  let end = Math.floor(next);
  // By word: stop before a word still being revealed, so words land whole.
  if (end < len && (unit === "word" || (unit === "adaptive" && rate > WORD_RATE))) {
    while (end > shown && !/\s/.test(src[end - 1])) end--;
  }
  return { pos: next, end: Math.max(end, shown) };
}

type HNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] };

/** Left whole: their contents are read as text (code, tables) or already laid out (math). */
function skip(n: HNode): boolean {
  if (n.tagName && ["pre", "code", "table", "svg", "math"].includes(n.tagName)) return true;
  const cls = n.properties?.className;
  return Array.isArray(cls) && cls.some((c) => String(c).startsWith("katex"));
}

const span = (className: string[], children: HNode[]): HNode => ({
  type: "element",
  tagName: "span",
  properties: { className },
  children,
});

/**
 * Rehype plugin: split text into word spans (`mz-w`), and — unless revealing
 * by word — each word into character spans. The animated span is `mz-tok`:
 * the word itself by word, each character otherwise. Whitespace stays plain
 * text, so lines wrap exactly as they would without it.
 */
export function rehypeReveal({ unit }: { unit: RevealUnit }) {
  const byWord = unit === "word";
  const walk = (node: HNode) => {
    if (!node.children) return;
    const out: HNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && child.value) {
        for (const piece of child.value.match(/\s+|\S+/g) ?? []) {
          if (/^\s/.test(piece)) out.push({ type: "text", value: piece });
          else if (byWord) out.push(span(["mz-w", "mz-tok"], [{ type: "text", value: piece }]));
          else out.push(span(["mz-w"], [...piece].map((ch) => span(["mz-tok"], [{ type: "text", value: ch }]))));
        }
      } else {
        if (child.type === "element" && !skip(child)) walk(child);
        out.push(child);
      }
    }
    node.children = out;
  };
  return (tree: HNode) => walk(tree);
}
