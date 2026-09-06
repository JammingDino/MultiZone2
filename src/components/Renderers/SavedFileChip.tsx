import { ExternalLink, FileText } from "lucide-react";
import * as api from "@/lib/tauri";
import { RevealButton, type SavedOutput } from "@/components/Renderers/HtmlReportBlock";
import { CHROME_OUTLINED } from "@/lib/chrome";

/** Compact card for a non-HTML artifact presented via `present_file`
 * (markdown, CSV, JSON, txt). Names the file and opens it in its default app,
 * or shows it where it actually lives — a file you can only open is a file you
 * can't move, rename or attach to an email. */
export function SavedFileChip({ output }: { output: SavedOutput }) {
  return (
    <div className="my-1 flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <FileText size={13} className="flex-shrink-0 text-[var(--color-accent)]" />
        <span className="truncate text-[var(--color-text)]">
          {output.filename || output.path}
        </span>
        {output.format && (
          <span className="flex-shrink-0 rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            {output.format}
          </span>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          onClick={() => api.openPath(output.path).catch((e) => console.error(e))}
          className={`flex items-center gap-1 rounded px-2 py-0.5 ${CHROME_OUTLINED}`}
          title="Open file"
        >
          <ExternalLink size={11} /> Open
        </button>
        <RevealButton path={output.path} />
      </div>
    </div>
  );
}

