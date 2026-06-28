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
   * The number as the model would have written it (`[refIndex]`) — the tool's
   * `ref` / collect order. Before filtering this equals `index`; after filtering
   * to the matched subset the list is renumbered but `refIndex` is preserved so
   * any inline `[n]` markers a model *does* emit can still be relabelled.
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
  /** Web result snippet — not displayed; used to detect content reuse in the answer. */
  snippet?: string;
  /**
   * Lowercased substring in the answer to anchor this source's inline marker to
   * (a filename for file/knowledge sources, a distinctive word for web). Absent
   * when no confident, specific anchor was found — the source still appears in
   * the Sources list, just without an inline marker. Consumed by remarkCitations.
   */
  anchor?: string;
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

  // Add a knowledge/file citation for a local file path (search_knowledge hits
  // and read_file reads), de-duplicated by path.
  const pushPath = (path: string, title?: string) => {
    if (!path) return;
    const key = `kb:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    push({ kind: "knowledge", title: title || basename(path), path, fileName: basename(path) });
  };

  for (const b of blocks) {
    if (b.kind !== "step" || b.step.kind !== "tool" || !b.step.toolResult) continue;
    const name = b.step.toolCall.function.name;
    if (name !== "web_search" && name !== "search_knowledge" && name !== "read_file") continue;

    let data: any;
    try {
      data = JSON.parse(toolResultText(b.step.toolResult.content));
    } catch {
      continue;
    }

    if (name === "web_search") {
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const r of results) {
        const url = typeof r?.url === "string" ? r.url : "";
        if (!url || seen.has(url)) continue;
        seen.add(url);
        push({
          kind: "web",
          url,
          title: (typeof r?.title === "string" && r.title.trim()) || hostname(url),
          snippet: typeof r?.snippet === "string" ? r.snippet : undefined,
        });
      }
    } else if (name === "search_knowledge") {
      // One citation per source file (chunks of the same file collapse).
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const r of results) {
        pushPath(typeof r?.source === "string" ? r.source : "", typeof r?.title === "string" ? r.title.trim() : undefined);
      }
    } else {
      // read_file — the file the model read (skipped for image/error results,
      // which don't carry a source path).
      pushPath(typeof data?.source === "string" ? data.source : "");
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

/** Joined plain text of a turn's answer (text blocks only). */
function answerText(blocks: TurnBlock[]): string {
  return blocks
    .filter((b): b is Extract<TurnBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}

/** All distinct `[n]` marker numbers a model *did* emit in the answer (a bonus
 *  signal layered on top of content matching — most models emit none). */
function usedMarkers(answer: string): Set<number> {
  const used = new Set<number>();
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) used.add(Number(m[1]));
  return used;
}

const STOPWORDS = new Set(
  ("the and for that with this from your you are was were has have had not but they their them then \
    than out about into over more most some such can will just like also been being which who what when \
    where why how our its his her she him these those there here only very each other into onto upon".split(
    /\s+/,
  ))
);

/** Distinctive lowercased tokens (≥4 chars, non-stopword) — keeps numbers like
 *  "17025" so identifiers survive. */
function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 4 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

/** Whether the answer shows evidence of having used a given source: a verbatim
 *  filename/path/host, the site's brand, or enough shared distinctive words. */
function contentMatches(
  c: Citation,
  lowerAnswer: string,
  normAnswer: string,
  answerTokens: Set<string>,
): boolean {
  if (c.kind === "web") {
    const host = c.url ? hostname(c.url).toLowerCase() : "";
    if (host && lowerAnswer.includes(host)) return true;
    // Brand = first domain label (e.g. "holmessolutions"), matched against the
    // answer with punctuation/spaces stripped so "Holmes Solutions" hits.
    const brand = host.split(".")[0];
    if (brand.length >= 4 && normAnswer.includes(brand)) return true;
    // Otherwise require a few distinctive words shared with the title + snippet.
    const src = distinctiveTokens(`${c.title ?? ""} ${c.snippet ?? ""}`);
    let shared = 0;
    for (const t of src) {
      if (answerTokens.has(t) && ++shared >= 3) return true;
    }
    return false;
  }
  // file / knowledge — the model typically names the file it drew on.
  const fname = (c.fileName ?? "").toLowerCase();
  if (fname && lowerAnswer.includes(fname)) return true;
  if (c.path) {
    const p = c.path.toLowerCase().replace(/\\/g, "/");
    if (p && lowerAnswer.replace(/\\/g, "/").includes(p)) return true;
  }
  return false;
}

/**
 * From the full candidate list, keep only the sources whose content actually
 * surfaces in the answer (a named file/host, a brand, or shared distinctive
 * wording) — plus any a model explicitly tagged with `[n]`. This needs nothing
 * from the model: it compares the answer against the sources rather than asking
 * the model which it used. Kept sources are renumbered contiguously.
 */
export function matchedCitations(candidates: Citation[], blocks: TurnBlock[]): Citation[] {
  if (candidates.length === 0) return [];
  const answer = answerText(blocks);
  const lowerAnswer = answer.toLowerCase();
  const normAnswer = lowerAnswer.replace(/[^a-z0-9]/g, "");
  const answerTokens = distinctiveTokens(answer);
  const markers = usedMarkers(answer);

  const kept = candidates.filter(
    (c) =>
      markers.has(c.refIndex) ||
      contentMatches(c, lowerAnswer, normAnswer, answerTokens),
  );

  // Per-web-source distinctive tokens present in the answer + their document
  // frequency across the kept web sources, so each marker can anchor to its
  // most *specific* word (a token only one source shares).
  const webTokens = new Map<Citation, string[]>();
  const df = new Map<string, number>();
  for (const c of kept) {
    if (c.kind !== "web") continue;
    const toks = [...distinctiveTokens(`${c.title ?? ""} ${c.snippet ?? ""}`)].filter((t) =>
      answerTokens.has(t),
    );
    webTokens.set(c, toks);
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  return kept.map((c, i) => ({
    ...c,
    index: i + 1,
    anchor: pickAnchor(c, lowerAnswer, webTokens.get(c) ?? [], df),
  }));
}

/** Choose the inline-marker anchor for a source: the named file for file/
 *  knowledge sources, or the most specific shared word for web sources. Returns
 *  undefined when nothing specific enough was found (Sources-list only). */
function pickAnchor(
  c: Citation,
  lowerAnswer: string,
  webToks: string[],
  df: Map<string, number>,
): string | undefined {
  if (c.kind === "web") {
    let best: string | undefined;
    let bestDf = Infinity;
    let bestLen = 0;
    for (const t of webToks) {
      const d = df.get(t) ?? 1;
      if (d < bestDf || (d === bestDf && t.length > bestLen)) {
        best = t;
        bestDf = d;
        bestLen = t.length;
      }
    }
    // Too generic (shared by 3+ sources) → don't stack markers on one word.
    return best && bestDf <= 2 ? best : undefined;
  }
  const fname = (c.fileName ?? "").toLowerCase();
  if (fname && lowerAnswer.includes(fname)) return fname;
  return undefined;
}
