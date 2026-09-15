import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, File, Folder, FolderOpen, RefreshCw } from "lucide-react";
import * as api from "@/lib/tauri";
import { formatBytes } from "@/lib/format";
import type { DirEntry } from "@/lib/types";

/**
 * The chat's working directory as a tree (0.17.9).
 *
 * The directory the file tools are scoped to — the project's, or the app's
 * default — has been a path in a settings field and a scope error when a
 * model got it wrong. This is a look at it: folders open on demand (a
 * `node_modules` is never read until asked), files open in the system's
 * editor with a click on the arrow. Read-only on purpose; writing is the
 * agent's job and goes through review.
 */
export function FilesPanel({ chatId }: { chatId: string }) {
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let live = true;
    api.chatWorkingDir(chatId)
      .then((d) => { if (live) setRoot(d); })
      .catch(() => { if (live) setRoot(null); });
    return () => { live = false; };
  }, [chatId]);

  if (root === undefined) return null;
  if (!root) {
    return (
      <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        No working directory. Give this chat a project with a directory, or set a default
        directory in Settings, and the file tools — and this tree — will be scoped to it.
      </p>
    );
  }

  return (
    <div className="text-xs">
      <div className="mb-1 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={root}>
          {root}
        </span>
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          title="Re-read the tree"
          className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <RefreshCw size={11} />
        </button>
        <button
          onClick={() => api.openPath(root).catch(console.warn)}
          title="Open in the file manager"
          className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <ExternalLink size={11} />
        </button>
      </div>
      <div className="max-h-[40vh] overflow-auto">
        <Dir key={refreshKey} path={root} depth={0} open />
      </div>
    </div>
  );
}

function Dir({ path, depth, open }: { path: string; depth: number; open: boolean }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listDir(path)
      .then(setEntries)
      .catch((e) => setError(String(e)));
  }, [path]);

  useEffect(() => {
    if (open && entries === null) load();
  }, [open, entries, load]);

  if (!open) return null;
  if (error) return <div className="pl-4 text-[10px] text-[var(--color-danger)]">{error}</div>;
  if (entries === null) return <div className="pl-4 text-[10px] text-[var(--color-text-muted)]">…</div>;
  if (entries.length === 0) return <div className="pl-4 text-[10px] italic text-[var(--color-text-muted)]">empty</div>;

  return (
    <ul>
      {entries.map((e) => (
        <Row key={e.path} entry={e} depth={depth} />
      ))}
    </ul>
  );
}

function Row({ entry, depth }: { entry: DirEntry; depth: number }) {
  const [open, setOpen] = useState(false);
  const indent = { paddingLeft: `${depth * 12 + 2}px` };

  if (entry.isDir) {
    return (
      <li>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded py-[1px] pr-1 text-left hover:bg-[var(--color-panel-hover)]"
          style={indent}
        >
          {open ? <ChevronDown size={10} className="shrink-0 text-[var(--color-text-muted)]" /> : <ChevronRight size={10} className="shrink-0 text-[var(--color-text-muted)]" />}
          {open ? <FolderOpen size={12} className="shrink-0 text-[var(--viz-4)]" /> : <Folder size={12} className="shrink-0 text-[var(--viz-4)]" />}
          <span className="truncate">{entry.name}</span>
        </button>
        <Dir path={entry.path} depth={depth + 1} open={open} />
      </li>
    );
  }
  return (
    <li>
      <div
        className="group flex items-center gap-1 rounded py-[1px] pr-1 hover:bg-[var(--color-panel-hover)]"
        style={indent}
        title={entry.path}
      >
        <span className="w-[10px] shrink-0" />
        <File size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.size !== null && (
          <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{formatBytes(entry.size)}</span>
        )}
        <button
          onClick={() => api.openPath(entry.path).catch(console.warn)}
          title="Open"
          className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 hover:text-[var(--color-text)] group-hover:opacity-100"
        >
          <ExternalLink size={10} />
        </button>
      </div>
    </li>
  );
}
