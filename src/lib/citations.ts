// Inline citations (0.4.1). Collects the sources a bot turn drew on — web_search
// results and referenced file attachments — into one ordered, de-duplicated list.
// The list drives both the inline `[n]` markers (see remarkCitations) and the
// collapsible source list at the bottom of the message.

import type { ContentPart } from "./types";
import type { TurnBlock } from "./grouping";

export interface Citation {
  /** 1-based position in the deduped list — what `[n]` markers refer to. */
  index: number;
  kind: "web" | "file";
  title: string;
  /** Web source URL (absent for file citations). */
  url?: string;
  fileName?: string;
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

  for (const b of blocks) {
    if (
      b.kind !== "step" ||
      b.step.kind !== "tool" ||
      b.step.toolCall.function.name !== "web_search" ||
      !b.step.toolResult
    ) {
      continue;
    }
    try {
      const data = JSON.parse(toolResultText(b.step.toolResult.content));
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const r of results) {
        const url = typeof r?.url === "string" ? r.url : "";
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push({
          index: out.length + 1,
          kind: "web",
          url,
          title: (typeof r?.title === "string" && r.title.trim()) || hostname(url),
        });
      }
    } catch {}
  }

  for (const f of fileSources) {
    const key = `file:${f.fileName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      index: out.length + 1,
      kind: "file",
      title: f.fileName,
      fileName: f.fileName,
      pages: f.pages,
    });
  }

  return out;
}
