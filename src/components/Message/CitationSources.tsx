import { useState } from "react";
import { ChevronDown, ChevronRight, Link2, FileType, Database } from "lucide-react";
import { citationKey, type Citation } from "@/lib/citations";
import { openPath } from "@/lib/tauri";

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Collapsible "Sources" list at the bottom of an assistant turn that drew on web
 * search or files. Split into two groups (0.6.2):
 *  - "Used" — the sources actually cited inline (`[n]` markers); numbered to
 *    match the markers in the answer.
 *  - "All retrieved" — every candidate the search/lookup surfaced, shown behind
 *    a secondary toggle so provenance stays available without cluttering.
 */
export function CitationSources({ used, all }: { used: Citation[]; all: Citation[] }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  if (all.length === 0) return null;

  const usedKeys = new Set(used.map(citationKey));
  const extras = all.filter((c) => !usedKeys.has(citationKey(c)));

  const headerLabel =
    used.length > 0
      ? `${used.length} source${used.length === 1 ? "" : "s"} cited`
      : `${all.length} source${all.length === 1 ? "" : "s"} retrieved`;

  return (
    <div className="mt-2 border-t border-[var(--color-border)] pt-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {headerLabel}
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-2">
          {used.length > 0 && (
            <ol className="flex flex-col gap-1">
              {used.map((c) => (
                <SourceRow key={citationKey(c)} c={c} numbered />
              ))}
            </ol>
          )}

          {/* Sources retrieved but not cited inline. Shown directly when nothing
              was cited, else behind a secondary toggle. */}
          {extras.length > 0 &&
            (used.length === 0 ? (
              <ul className="flex flex-col gap-1">
                {extras.map((c) => (
                  <SourceRow key={citationKey(c)} c={c} />
                ))}
              </ul>
            ) : (
              <div>
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]/80 hover:text-[var(--color-text)]"
                >
                  {showAll ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  {showAll ? "Hide" : "Show"} {extras.length} more retrieved
                </button>
                {showAll && (
                  <ul className="mt-1 flex flex-col gap-1">
                    {extras.map((c) => (
                      <SourceRow key={citationKey(c)} c={c} />
                    ))}
                  </ul>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** One source row. `numbered` prefixes the `[n]` marker for cited sources. */
function SourceRow({ c, numbered = false }: { c: Citation; numbered?: boolean }) {
  return (
    <li className="flex items-baseline gap-1.5 text-xs">
      {numbered && (
        <span className="font-mono text-[var(--color-text-muted)]">[{c.index}]</span>
      )}
      {c.kind === "web" && c.url ? (
        <a
          href={c.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            openPath(c.url!).catch((err) => console.error("openPath failed", err));
          }}
          className="flex min-w-0 items-baseline gap-1 text-[var(--color-accent)] hover:underline"
          title={c.url}
        >
          <Link2 size={11} className="shrink-0 translate-y-0.5" />
          <span className="truncate">{c.title}</span>
          <span className="shrink-0 text-[var(--color-text-muted)]">— {hostname(c.url)}</span>
        </a>
      ) : c.kind === "knowledge" ? (
        <span className="flex min-w-0 items-baseline gap-1 text-[var(--color-text)]" title={c.path}>
          <Database size={11} className="shrink-0 translate-y-0.5 text-[var(--color-text-muted)]" />
          <span className="truncate">{c.fileName ?? c.title}</span>
          {c.path && c.path !== c.fileName ? (
            <span className="min-w-0 shrink truncate text-[var(--color-text-muted)]">— {c.path}</span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 items-baseline gap-1 text-[var(--color-text)]">
          <FileType size={11} className="shrink-0 translate-y-0.5 text-[var(--color-text-muted)]" />
          <span className="truncate">{c.fileName ?? c.title}</span>
          {c.pages ? (
            <span className="shrink-0 text-[var(--color-text-muted)]">
              — {c.pages} page{c.pages === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
      )}
    </li>
  );
}
