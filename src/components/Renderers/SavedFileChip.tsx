import { ExternalLink, FolderOpen, PanelRightOpen } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { CHROME_OUTLINED, PRIMARY_ACTION } from "@/lib/chrome";
import { iconFor } from "@/components/Workspace/FilesPanel";

/** Shape of the `present_file` tool result the backend renders. */
export interface SavedOutput {
  path: string;
  filename?: string;
  format?: string;
}

/**
 * The card a `present_file` leaves in the transcript (0.17.9).
 *
 * An HTML report used to render here, in a scripts-off iframe a few hundred
 * pixels tall — which is why pages with animation or a chart library in
 * them arrived frozen or blank. The file now opens as a document tab in the
 * main column (0.18), with its scripts running and the whole column to show
 * them in, and this is the handle back to it: a name, where it is, and the
 * three things to do with it. It opens itself the moment the tool result
 * arrives (see `applyStreamEvent`); the button is for the second time.
 */
export function SavedFileChip({ output }: { output: SavedOutput }) {
  const openInPanel = useApp((s) => s.openWorkspaceFile);
  const showing = useApp((s) => s.activeFileByChat[s.activeChatId ?? ""] === output.path);
  const name = output.filename || output.path;
  const { Icon, color } = iconFor(name);
  return (
    <div className="my-1 flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon size={14} className="flex-shrink-0" style={{ color }} />
        <span className="truncate text-[var(--color-text)]" title={output.path}>{name}</span>
        {output.format && (
          <span className="flex-shrink-0 rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            {output.format}
          </span>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          onClick={() => openInPanel(output.path)}
          className={`flex items-center gap-1 rounded px-2 py-0.5 ${showing ? CHROME_OUTLINED : PRIMARY_ACTION}`}
          title={showing ? "Showing in the workspace panel" : "Open in the workspace panel"}
        >
          <PanelRightOpen size={11} /> {showing ? "Showing" : "View"}
        </button>
        <button
          onClick={() => api.openPath(output.path).catch((e) => console.error(e))}
          className={`flex items-center gap-1 rounded px-2 py-0.5 ${CHROME_OUTLINED}`}
          title={output.format === "html" ? "Open in the browser" : "Open in the default app"}
        >
          <ExternalLink size={11} /> Open
        </button>
        <button
          onClick={() => api.revealPath(output.path).catch((e) => console.error(e))}
          className={`flex items-center gap-1 rounded px-2 py-0.5 ${CHROME_OUTLINED}`}
          title="Show in file explorer"
        >
          <FolderOpen size={11} /> Show
        </button>
      </div>
    </div>
  );
}
