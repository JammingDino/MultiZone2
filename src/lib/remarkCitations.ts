// Remark plugin (0.4.1, reworked 0.9.10): renders the inline citation markers
// the model wrote. A `[n]` in the answer is replaced by a link to source `n`,
// numbered as it appears in the Sources list.
//
// Markers come from the model only. The plugin used to also *insert* markers by
// matching source titles/snippets against the answer text; that guessed at what
// a sentence was claiming and regularly attached a source to unrelated prose
// (see the note on `matchedCitations` in citations.ts). Nothing is inserted now.
//
// Operates only on text nodes, so `[1]` inside code or inline-code is untouched.

import { visit, SKIP } from "unist-util-visit";
import { type Citation } from "./citations";

const MARKER = /\[(\d+)\]/g;

function linkNode(cite: Citation) {
  const label = { type: "text", value: `[${cite.index}]` };
  if (cite.url) {
    return {
      type: "link",
      url: cite.url,
      title: cite.title,
      data: {
        hProperties: {
          className: "citation-ref",
          title: cite.title,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      },
      children: [label],
    };
  }
  // A file source. `data-reveal-path` is picked up by a delegated click handler
  // in Markdown.tsx, which shows the file in the OS file manager rather than
  // opening it — the file equivalent of a web marker linking to its page.
  // Sources with no resolvable path on disk (an attachment on the user's own
  // message, or an index whose directory has moved) stay inert.
  const reveal = cite.absPath;
  return {
    type: "emphasis",
    data: {
      hName: "span",
      hProperties: {
        className: `citation-ref citation-file${reveal ? " citation-revealable" : ""}`,
        title: reveal ? `Show in file manager — ${reveal}` : cite.title,
        ...(reveal ? { "data-reveal-path": reveal } : {}),
      },
    },
    children: [label],
  };
}

/**
 * Returns a configured remark plugin. When `citations` is empty the plugin is a
 * no-op, so callers can include it unconditionally.
 */
export function citationPlugin(citations: Citation[]) {
  // Markers map by the numbers the model wrote (each source's tool-reported
  // `ref`s); the rendered label uses the display `index` instead.
  const byRef = new Map<number, Citation>();
  for (const c of citations) {
    for (const r of c.refs) if (!byRef.has(r)) byRef.set(r, c);
  }

  return function () {
    return function transform(tree: any) {
      if (citations.length === 0) return;

      visit(tree, (node: any, index: number | undefined, parent: any) => {
        if (!parent || index === undefined || node.type !== "text") return;

        const value: string = node.value ?? "";
        const ops: { pos: number; endPos: number; cite: Citation }[] = [];

        // Every occurrence is replaced, so repeating `[2]` across the answer
        // repeats the reference rather than dropping all but the first. An
        // unknown number is left as literal text.
        MARKER.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = MARKER.exec(value)) !== null) {
          const cite = byRef.get(Number(m[1]));
          if (!cite) continue;
          ops.push({ pos: m.index, endPos: m.index + m[0].length, cite });
        }
        if (ops.length === 0) return;

        const children: any[] = [];
        let last = 0;
        for (const op of ops) {
          if (op.pos > last) children.push({ type: "text", value: value.slice(last, op.pos) });
          children.push(linkNode(op.cite));
          last = op.endPos;
        }
        if (last < value.length) children.push({ type: "text", value: value.slice(last) });

        parent.children.splice(index, 1, ...children);
        // Skip the freshly inserted nodes so their `[n]` label text isn't
        // re-scanned, and resume after them.
        return [SKIP, index + children.length];
      });
    };
  };
}
