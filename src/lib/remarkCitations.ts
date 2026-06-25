// Remark plugin (0.4.1): rewrites inline `[n]` citation markers in the model's
// answer into clickable citation links (web sources) or styled markers (file
// sources), based on the turn's collected `Citation` list. Operates only on text
// nodes, so `[0]` inside code/inline-code is left untouched (code is its own
// mdast node type and is never visited here).

import { visit, SKIP } from "unist-util-visit";
import type { Citation } from "./citations";

const MARKER = /\[(\d+)\]/g;

/**
 * Returns a configured remark plugin. When `citations` is empty the plugin is a
 * no-op, so callers can include it unconditionally.
 */
export function citationPlugin(citations: Citation[]) {
  const byIndex = new Map(citations.map((c) => [c.index, c]));

  return function () {
    return function transform(tree: any) {
      if (byIndex.size === 0) return;

      visit(tree, "text", (node: any, index: number | undefined, parent: any) => {
        if (!parent || index === undefined) return;
        const value: string = node.value ?? "";
        MARKER.lastIndex = 0;

        const children: any[] = [];
        let last = 0;
        let matched = false;
        let m: RegExpExecArray | null;
        while ((m = MARKER.exec(value)) !== null) {
          const n = Number(m[1]);
          const cite = byIndex.get(n);
          if (!cite) continue; // leave unrecognised [k] as plain text
          matched = true;
          if (m.index > last) children.push({ type: "text", value: value.slice(last, m.index) });

          const label = { type: "text", value: `[${n}]` };
          if (cite.url) {
            children.push({
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
            });
          } else {
            children.push({
              type: "emphasis",
              data: {
                hName: "span",
                hProperties: { className: "citation-ref citation-file", title: cite.title },
              },
              children: [label],
            });
          }
          last = m.index + m[0].length;
        }

        if (!matched) return;
        if (last < value.length) children.push({ type: "text", value: value.slice(last) });

        parent.children.splice(index, 1, ...children);
        // Skip the freshly inserted nodes (their `[n]` text would otherwise be
        // re-matched into an infinite loop) and resume after them.
        return [SKIP, index + children.length];
      });
    };
  };
}
