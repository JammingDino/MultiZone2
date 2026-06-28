// Remark plugin (0.4.1, reworked 0.4.3): renders inline citation markers in the
// model's answer. Two sources of markers, in priority order:
//   1. Explicit `[n]` the model wrote — relabelled to the source's display index.
//   2. Auto-inserted markers — for each matched source with an `anchor` (a
//      filename, or a distinctive word), a `[n]` link is inserted right after the
//      anchor's first occurrence. This needs nothing from the model: placement is
//      derived by matching source content against the answer (see citations.ts).
// Operates only on text nodes, so markers inside code/inline-code are untouched.

import { visit, SKIP } from "unist-util-visit";
import type { Citation } from "./citations";

const MARKER = /\[(\d+)\]/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First index of a needle in `lower`; word-boundary for plain word tokens,
 *  literal substring for filenames (which contain dots/slashes). */
function findAnchor(lower: string, needle: string): number {
  if (/^[a-z0-9]+$/.test(needle)) {
    const m = new RegExp(`\\b${escapeRegExp(needle)}\\b`).exec(lower);
    return m ? m.index : -1;
  }
  return lower.indexOf(needle);
}

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
  return {
    type: "emphasis",
    data: {
      hName: "span",
      hProperties: { className: "citation-ref citation-file", title: cite.title },
    },
    children: [label],
  };
}

/**
 * Returns a configured remark plugin. When `citations` is empty the plugin is a
 * no-op, so callers can include it unconditionally.
 */
export function citationPlugin(citations: Citation[]) {
  // Explicit markers map by `refIndex` (what the model wrote); auto-anchored
  // sources by their search needle. Each source is placed at most once.
  const byRef = new Map(citations.map((c) => [c.refIndex, c]));
  const anchored = citations
    .filter((c) => c.anchor)
    .map((c) => ({ cite: c, needle: c.anchor as string }));

  // File/knowledge anchors (filenames/paths) are often rendered as inline code,
  // so they need separate handling from plain word anchors.
  const isFileNeedle = (needle: string) => /[./\\]/.test(needle);

  return function () {
    return function transform(tree: any) {
      if (citations.length === 0) return;
      // Fresh per parse — each source is placed at most once per run (but on
      // every run), so re-renders don't lose markers.
      const placed = new Set<number>();

      visit(tree, (node: any, index: number | undefined, parent: any) => {
        if (!parent || index === undefined) return;

        // Filenames usually render as inline code (`player.gd`); the marker goes
        // right after the code span rather than inside it.
        if (node.type === "inlineCode") {
          const v = (node.value ?? "").toLowerCase();
          const hits = anchored.filter(
            (a) => !placed.has(a.cite.index) && isFileNeedle(a.needle) && v.includes(a.needle.toLowerCase()),
          );
          if (hits.length === 0) return;
          const links = hits.map((h) => {
            placed.add(h.cite.index);
            return linkNode(h.cite);
          });
          parent.children.splice(index + 1, 0, ...links);
          return [SKIP, index + 1 + links.length];
        }

        if (node.type !== "text") return;
        const value: string = node.value ?? "";
        const lower = value.toLowerCase();

        type Op = { pos: number; endPos: number; cite: Citation; replace: boolean };
        const ops: Op[] = [];

        // 1. Explicit `[k]` markers the model emitted → replace with a link.
        MARKER.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = MARKER.exec(value)) !== null) {
          const cite = byRef.get(Number(m[1]));
          if (!cite) continue;
          ops.push({ pos: m.index, endPos: m.index + m[0].length, cite, replace: true });
          placed.add(cite.index);
        }

        // 2. Auto-insert a marker after each unplaced source's anchor.
        for (const a of anchored) {
          if (placed.has(a.cite.index)) continue;
          const at = findAnchor(lower, a.needle.toLowerCase());
          if (at < 0) continue;
          const insertPos = at + a.needle.length;
          ops.push({ pos: insertPos, endPos: insertPos, cite: a.cite, replace: false });
          placed.add(a.cite.index);
        }

        if (ops.length === 0) return;
        // Replace-ops sort before insert-ops at the same position.
        ops.sort((x, y) => x.pos - y.pos || Number(y.replace) - Number(x.replace));

        const children: any[] = [];
        let last = 0;
        for (const op of ops) {
          if (op.pos < last) continue; // overlapping op — skip to keep slicing sane
          if (op.pos > last) children.push({ type: "text", value: value.slice(last, op.pos) });
          children.push(linkNode(op.cite));
          last = op.replace ? op.endPos : op.pos;
        }
        if (children.length === 0) return;
        if (last < value.length) children.push({ type: "text", value: value.slice(last) });

        parent.children.splice(index, 1, ...children);
        // Skip the freshly inserted nodes so their `[n]` label text isn't
        // re-scanned, and resume after them.
        return [SKIP, index + children.length];
      });
    };
  };
}
