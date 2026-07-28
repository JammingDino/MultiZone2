// Inline citations (0.4.1). Collects the sources a bot turn drew on — web_search
// results and referenced file attachments — into one ordered, de-duplicated list.
// The list drives both the inline `[n]` markers (see remarkCitations) and the
// collapsible source list at the bottom of the message.

import type { ContentPart, Message, ToolCall } from "./types";
import type { TurnBlock } from "./grouping";

export interface Citation {
  /** 1-based position shown in the Sources list and inline marker after filtering. */
  index: number;
  /**
   * Every number the model may have written for this source — the `ref` field
   * the citing tool put on each result, which is what its `citation_instructions`
   * told the model to write. Usually one, but a source can carry several: local
   * search returns one result per *chunk* and several chunks of the same file
   * collapse into one citation, so `[1]` and `[2]` can both mean this file.
   * Falls back to collect order for a tool result that reports no `ref`.
   */
  refs: number[];
  kind: "web" | "file" | "knowledge";
  title: string;
  /** Web source URL (absent for file/knowledge citations). */
  url?: string;
  fileName?: string;
  /** Path as shown — project-relative for knowledge hits, absolute for reads. */
  path?: string;
  /**
   * The same file as an absolute path, when one is known. `path` is what reads
   * well in the Sources list; this is what the OS needs to reveal the file.
   * Absent when the project directory has moved or been unset since indexing,
   * in which case the source is listed but not clickable.
   */
  absPath?: string;
  /** Page count for PDF file sources, when known. */
  pages?: number;
  /** Web result snippet — carried for the Sources list only. */
  snippet?: string;
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
  const sink = new CitationSink();

  for (const b of blocks) {
    if (b.kind !== "step" || b.step.kind !== "tool" || !b.step.toolResult) continue;
    sink.absorbToolResult(b.step.toolCall.function.name, b.step.toolResult.content);
  }
  for (const f of fileSources) sink.pushFile(f);

  return sink.list;
}

/**
 * Citations from *earlier* turns of the same chat (0.9.4). A follow-up answer
 * routinely leans on a search the model ran a turn or two ago — the tool result
 * lives in that earlier turn's blocks, so a turn-scoped collector sees nothing
 * and the answer renders with no sources at all. Scanning the messages that
 * precede this turn keeps those sources referenceable for the rest of the chat.
 *
 * These are *candidates only*: unlike the current turn's sources they are never
 * listed as "retrieved" — a carried source surfaces only if the answer actually
 * cites it (see `matchedCitations`), so a chat with a big search behind it
 * doesn't drag thirty stale URLs through every later turn.
 *
 * Only the **most recent** citing tool result is carried (0.9.10). Every search
 * numbers its own results from 1, so folding several earlier searches into one
 * list makes `[1]` mean two different sources at once — and a marker that
 * resolves to two sources is not provenance, it's a coin toss. The last search
 * is the one still shaping the model's answer, so it is the one whose numbering
 * a bare `[n]` refers to.
 */
export function collectCarriedCitations(
  messages: Message[],
  firstTurnMsgId: string | undefined,
): Citation[] {
  // Tool results carry only a `toolCallId`, so the tool's *name* has to come
  // from the assistant message that requested it.
  const nameByCallId = new Map<string, string>();
  let latest: Citation[] = [];

  for (const m of messages) {
    if (firstTurnMsgId && m.id === firstTurnMsgId) break;
    if (m.role === "assistant") {
      for (const tc of parseToolCalls(m.toolCalls)) nameByCallId.set(tc.id, tc.function.name);
    } else if (m.role === "tool" && m.toolCallId) {
      const name = nameByCallId.get(m.toolCallId);
      if (!name) continue;
      const sink = new CitationSink();
      sink.absorbToolResult(name, m.content);
      // A non-citing tool (or an empty/failed result) leaves the sink empty and
      // must not wipe the last real search.
      if (sink.list.length > 0) latest = sink.list;
    }
  }

  return latest;
}

function parseToolCalls(json: string | null): ToolCall[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr;
  } catch {}
  return [];
}

/** A tool result's own `ref` for a row, when it reports one. */
function refOf(row: any): number | undefined {
  const n = typeof row?.ref === "number" ? row.ref : Number(row?.ref);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Accumulates de-duplicated, contiguously numbered citations from tool results. */
class CitationSink {
  readonly list: Citation[] = [];
  private readonly byKey = new Map<string, Citation>();

  /** Add a source, or — if it was already collected — record that this `ref`
   *  also points at it (several local-search chunks of one file, or the same URL
   *  returned by two searches in the turn). */
  private push(key: string, ref: number | undefined, c: Omit<Citation, "index" | "refs">) {
    const existing = this.byKey.get(key);
    const n = this.list.length + 1;
    if (existing) {
      const r = ref ?? n;
      if (!existing.refs.includes(r)) existing.refs.push(r);
      return;
    }
    const created: Citation = { index: n, refs: [ref ?? n], ...c };
    this.byKey.set(key, created);
    this.list.push(created);
  }

  /** A knowledge/file citation for a local path (local-search hits and
   *  `read_file` reads), de-duplicated by path. */
  private pushPath(
    path: string,
    title: string | undefined,
    ref: number | undefined,
    absPath?: string,
  ) {
    if (!path) return;
    this.push(`kb:${path}`, ref, {
      kind: "knowledge",
      title: title || basename(path),
      path,
      absPath,
      fileName: basename(path),
    });
  }

  pushFile(f: FileSource) {
    this.push(`file:${f.fileName}`, undefined, {
      kind: "file",
      title: f.fileName,
      fileName: f.fileName,
      pages: f.pages,
    });
  }

  absorbToolResult(name: string, rawContent: string) {
    // `search_knowledge` is the pre-0.9.0 name for `search_local_files`; stored
    // history from before the rename still carries it.
    const isLocalSearch = name === "search_local_files" || name === "search_knowledge";
    // `smart_search` returns the same `{ results: [{ ref, url, title, snippet }] }`
    // shape as `web_search`, so it feeds the citation list identically.
    const isWebSearch = name === "web_search" || name === "smart_search";
    if (!isWebSearch && !isLocalSearch && name !== "read_file") return;

    let data: any;
    try {
      data = JSON.parse(toolResultText(rawContent));
    } catch {
      return;
    }

    if (isWebSearch) {
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const r of results) {
        const url = typeof r?.url === "string" ? r.url : "";
        if (!url) continue;
        this.push(url, refOf(r), {
          kind: "web",
          url,
          title: (typeof r?.title === "string" && r.title.trim()) || hostname(url),
          snippet: typeof r?.snippet === "string" ? r.snippet : undefined,
        });
      }
    } else if (isLocalSearch) {
      // One citation per source file (chunks of the same file collapse, each
      // contributing its own `ref` so any of them resolves to the file).
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const r of results) {
        this.pushPath(
          typeof r?.source === "string" ? r.source : "",
          typeof r?.title === "string" ? r.title.trim() : undefined,
          refOf(r),
          typeof r?.abs_path === "string" ? r.abs_path : undefined,
        );
      }
    } else {
      // read_file — the file the model read. Carries its own `ref` (renumbered
      // per turn on the backend), so a read is citable exactly like a search
      // hit. Image and error results have no source path and are skipped.
      // read_file's `source` is already absolute, so it is both.
      const source = typeof data?.source === "string" ? data.source : "";
      this.pushPath(source, undefined, refOf(data), source || undefined);
    }
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Stable identity for a source, to reconcile the "Used" subset against the
 *  full "All retrieved" candidate list (which use different `index` numbering). */
export function citationKey(c: Citation): string {
  return c.url ?? (c.path ? `kb:${c.path}` : `file:${c.fileName ?? c.title}`);
}


/** Joined plain text of a turn's answer (text blocks only). */
function answerText(blocks: TurnBlock[]): string {
  return blocks
    .filter((b): b is Extract<TurnBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Every distinct `[n]` marker number the model wrote in the answer. */
function usedMarkers(answer: string): Set<number> {
  const used = new Set<number>();
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) used.add(Number(m[1]));
  return used;
}

/**
 * The cited subset of the candidate list — the sources the model actually
 * referenced with an inline `[n]` marker. Drives both the marker rendering and
 * the "Used" section of the Sources list; the full candidate list is shown
 * separately as "All retrieved".
 *
 * Citation placement is entirely the model's call (0.9.10). Every search tool
 * numbers its results with a `ref` and tells the model to write `[ref]` after
 * the claim it supports (see `citation_instructions` in smart_search/web_search),
 * so a marker means the model asserted that source backs that sentence.
 *
 * The previous releases layered a heuristic on top: when the model emitted no
 * markers, a source earned one wherever a distinctive word from its title or
 * snippet appeared in the answer. That guess had no idea what a sentence was
 * *claiming* — a preamble like "gathering more detailed information" would
 * collect a marker because "information" happened to be unique to one result,
 * attributing a sentence to a source that had nothing to do with it, sometimes
 * before the search had even run. A wrong citation is worse than no citation:
 * it launders a guess as provenance. So the heuristic is gone. No markers from
 * the model means no inline markers — the Sources list still lists everything
 * retrieved, which is the honest claim we can make.
 *
 * `carried` holds sources retrieved in *earlier* turns of the chat (0.9.4) — a
 * follow-up answer routinely leans on a search the model ran a turn or two ago.
 * They are only consulted when this turn ran no citing tool of its own: then the
 * most recent search's numbering is the only one in play, so `[1]` is
 * unambiguous. If this turn *did* search, its own results own the numbering and
 * a carried source can't be what `[1]` meant, so carried are ignored rather than
 * guessed at.
 */
export function matchedCitations(
  candidates: Citation[],
  blocks: TurnBlock[],
  carried: Citation[] = [],
): Citation[] {
  const pool = candidates.length > 0 ? candidates : carried;
  if (pool.length === 0) return [];

  const markers = usedMarkers(answerText(blocks));
  if (markers.size === 0) return [];

  return pool
    .filter((c) => c.refs.some((r) => markers.has(r)))
    .map((c, i) => ({ ...c, index: i + 1 }));
}
