import { useState } from "react";
import { ChevronDown, ChevronRight, Link2, FileType } from "lucide-react";
import type { Citation } from "@/lib/citations";

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Collapsible "Sources" list shown at the bottom of an assistant message that
 * drew on web search results or file attachments (0.4.1). Each row is numbered to
 * match the inline `[n]` markers in the answer.
 */
export function CitationSources({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  if (citations.length === 0) return null;

  return (
    <div className="mt-2 border-t border-[var(--color-border)] pt-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {citations.length} source{citations.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ol className="mt-1.5 flex flex-col gap-1">
          {citations.map((c) => (
            <li key={c.index} className="flex items-baseline gap-1.5 text-xs">
              <span className="font-mono text-[var(--color-text-muted)]">[{c.index}]</span>
              {c.kind === "web" && c.url ? (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 items-baseline gap-1 text-[var(--color-accent)] hover:underline"
                  title={c.url}
                >
                  <Link2 size={11} className="shrink-0 translate-y-0.5" />
                  <span className="truncate">{c.title}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">— {hostname(c.url)}</span>
                </a>
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
          ))}
        </ol>
      )}
    </div>
  );
}
