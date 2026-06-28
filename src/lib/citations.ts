// Inline citations (0.4.1). Collects the sources a bot turn drew on — web_search
// results and referenced file attachments — into one ordered, de-duplicated list.
// The list drives both the inline `[n]` markers (see remarkCitations) and the
// collapsible source list at the bottom of the message.

import type { ContentPart } from "./types";
import type { TurnBlock } from "./grouping";

export interface Citation {
  /** 1-based position shown in the Sources list and inline marker after filtering. */
  index: number;
  /**
   * The number as the model actually wrote it in the answer (`[refIndex]`) — i.e.
   * the tool's `ref`. Before filtering this equals `index`; after filtering to the
   * cited subset the list is renumbered but `refIndex` is preserved so the inline
   * markers in the text can still be matched and relabelled.
   */
  refIndex: number;
  kind: "web" | "file" | "knowledge";
  title: string;
  /** Web source URL (absent for file/knowledge citations). */
  url?: string;
  fileName?: string;
  /** Relative path within the knowledge base (knowledge citations). */
  path?: string;
  /** Page count for PDF file sources, when known. */
  pages?: number;
}

/** A file attachment referenced by the turn (from the preceding user message). */
export interface FileSource {
  fileName: string;
  pages?: number;
}

/** Extract the joined text of a tool-result message's stored ContentParts. */
function toolResultText(content: string): string {
  try {
    const parts = JSON.parse(content) as ContentPart[];
    if (Array.isArray(parts)) {
      return parts
        .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  } catch {}
  return content;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Build the ordered citation list for a turn: web_search result URLs first (in
 * the order the model encountered them), then file attachments. De-duplicated by
 * URL / filename so a source cited from two searches appears once.
 */
export function collectCitations(blocks: TurnBlock[], fileSources: FileSource[] = []): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const push = (c: Omit<Citation, "index" | "refIndex">) => {
    const n = out.length + 1;
    out.push({ index: n, refIndex: n, ...c });
  };

  for (const b of blocks) {
    if (b.kind !== "step" || b.step.kind !== "tool" || !b.step.toolResult) continue;
    const name = b.step.toolCall.function.name;
    if (name !== "web_search" && name !== "search_knowledge") continue;

    let data: any;
    try {
      data = JSON.parse(toolResultText(b.step.toolResult.content));
    } catch {
      continue;
    }
    const results = Array.isArray(data?.results) ? data.results : [];

    if (name === "web_search") {
      for (const r of results) {
        const url = typeof r?.url === "string" ? r.url : "";
        if (!url || seen.has(url)) continue;
        seen.add(url);
        push({
          kind: "web",
          url,
          title: (typeof r?.title === "string" && r.title.trim()) || hostname(url),
        });
      }
    } else {
      // search_knowledge — one citation per source file (chunks of the same file
      // collapse into a single source).
      for (const r of results) {
        const path = typeof r?.source === "string" ? r.source : "";
        if (!path) continue;
        const key = `kb:${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const title = (typeof r?.title === "string" && r.title.trim()) || basename(path);
        push({ kind: "knowledge", title, path, fileName: basename(path) });
      }
    }
  }

  for (const f of fileSources) {
    const key = `file:${f.fileName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    push({ kind: "file", title: f.fileName, fileName: f.fileName, pages: f.pages });
  }

  return out;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** All distinct `[n]` marker numbers that appear in a turn's answer text. */
function usedMarkers(blocks: TurnBlock[]): Set<number> {
  const used = new Set<number>();
  const re = /\[(\d+)\]/g;
  for (const b of blocks) {
    if (b.kind !== "text") continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(b.text)) !== null) used.add(Number(m[1]));
  }
  return used;
}

/**
 * Keep only the citations the model actually cited (a `[refIndex]` marker present
 * in the answer text), then renumber them contiguously for display. The original
 * `refIndex` is preserved so the inline markers can still be matched. When the
 * model cited nothing, returns an empty list — sources aren't shown for tool
 * results the answer didn't draw on.
 */
export function citedCitations(candidates: Citation[], blocks: TurnBlock[]): Citation[] {
  const used = usedMarkers(blocks);
  if (used.size === 0) return [];
  return candidates
    .filter((c) => used.has(c.refIndex))
    .map((c, i) => ({ ...c, index: i + 1 }));
}
