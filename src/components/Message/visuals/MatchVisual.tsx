import { Search, FileText } from "lucide-react";

/**
 * Family 4 — search hits, grouped by the file they are in (0.13.1).
 *
 * `search_file_text` returns a flat array of {file, line, text}; a hundred of
 * those as JSON is unreadable, and the thing a reader wants — which files, how
 * many each — is exactly what the flat form hides. Knowledge-base hits carry a
 * similarity score and the source document, which is the same shape and the
 * same grouping.
 */

const MAX_FILES = 12;
const MAX_HITS_PER_FILE = 8;

export function MatchVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  const query = str(args?.query) || str(result.query);

  if (name === "search_local_files") {
    const results = Array.isArray(result.results) ? (result.results as any[]) : [];
    return (
      <Frame query={query} count={`${results.length} passage${results.length === 1 ? "" : "s"}`} note={str(result.note)}>
        {results.map((hit, i) => (
          <div key={i} className="border-b border-[var(--color-border)]/40 px-2 py-1.5 last:border-0">
            <div className="flex items-center gap-2 text-[11px]">
              <FileText size={11} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="min-w-0 truncate text-[var(--color-text)]" title={str(hit.source)}>
                {str(hit.title) || str(hit.source)}
              </span>
              {typeof hit.score === "number" && (
                <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-text-muted)]">
                  {hit.score.toFixed(3)}
                </span>
              )}
            </div>
            <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {str(hit.text)}
            </div>
          </div>
        ))}
      </Frame>
    );
  }

  // search_file_text
  const matches = Array.isArray(result.matches) ? (result.matches as any[]) : [];
  const groups = new Map<string, any[]>();
  for (const m of matches) {
    const file = str(m.file) || "(unknown)";
    const list = groups.get(file);
    if (list) list.push(m);
    else groups.set(file, [m]);
  }
  const shownFiles = [...groups].slice(0, MAX_FILES);
  const hiddenFiles = groups.size - shownFiles.length;
  const searched =
    typeof result.files_searched === "number" ? `${result.files_searched} searched` : null;

  return (
    <Frame
      query={query}
      count={[
        `${matches.length} hit${matches.length === 1 ? "" : "s"}`,
        `${groups.size} file${groups.size === 1 ? "" : "s"}`,
        searched,
      ]
        .filter(Boolean)
        .join(" · ")}
      note={result.truncated === true ? "Truncated — more matched than are listed here." : ""}
    >
      {matches.length === 0 && (
        <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">No matches.</div>
      )}
      {shownFiles.map(([file, hits]) => (
        <div key={file} className="border-b border-[var(--color-border)]/40 last:border-0">
          <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
            <FileText size={11} className="shrink-0 text-[var(--color-text-muted)]" />
            <span className="min-w-0 truncate font-mono text-[var(--color-text)]" title={file}>
              {file}
            </span>
            <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">
              {hits.length}
            </span>
          </div>
          {hits.slice(0, MAX_HITS_PER_FILE).map((hit, i) => (
            <div key={i} className="flex gap-2 px-2 py-0.5 font-mono text-[11px]">
              <span className="w-10 shrink-0 select-none text-right tabular-nums text-[var(--color-text-muted)]/70">
                {hit.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">
                <Highlighted text={str(hit.text)} query={query} />
              </span>
            </div>
          ))}
          {hits.length > MAX_HITS_PER_FILE && (
            <div className="px-2 pb-1 pl-14 text-[10px] text-[var(--color-text-muted)]">
              + {hits.length - MAX_HITS_PER_FILE} more in this file
            </div>
          )}
        </div>
      ))}
      {hiddenFiles > 0 && (
        <div className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          + {hiddenFiles} more file{hiddenFiles === 1 ? "" : "s"} — full list on the Output tab
        </div>
      )}
    </Frame>
  );
}

function Frame({
  query,
  count,
  note,
  children,
}: {
  query: string;
  count: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-[11px]">
        <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 truncate font-mono text-[var(--color-text)]" title={query}>
          {query || "search"}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">{count}</span>
      </div>
      <div className="max-h-[320px] overflow-auto">{children}</div>
      {note && (
        <div className="border-t border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          {note}
        </div>
      )}
    </div>
  );
}

/**
 * The query is a regex by default, so it is used as a literal here rather than
 * compiled — a highlight that throws on the user's own pattern would take the
 * whole card down with it.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const idx = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (idx < 0 || !query) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-[var(--color-accent)]/25 text-[var(--color-text)]">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
