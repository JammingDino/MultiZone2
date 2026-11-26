import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  File as FileIcon,
  Folder,
  FolderOpen,
  Globe,
  RefreshCw,
  Table2,
} from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { formatBytes } from "@/lib/format";
import type { DirEntry } from "@/lib/types";
import { ErrorNote } from "@/components/common/ErrorNote";
import { isShowing } from "@/lib/tabLayout";
import { useChatPaths } from "@/components/Chat/GrantChip";
import { reportError } from "@/lib/reportError";
import { Lock, X } from "lucide-react";

/**
 * The chat's working directory as a tree (0.17.9, reworked 0.18).
 *
 * The directory the file tools are scoped to — the project's, or the app's
 * default — has been a path in a settings field and a scope error when a
 * model got it wrong. This is a look at it: folders open on demand, so a
 * `node_modules` is never read until asked.
 *
 * The viewer used to sit above the tree in this same section, which left the
 * tree a quarter of a 360px column the moment a file was open. A file is now
 * a document tab in the main column (`openWorkspaceFile`), and this is a
 * navigator: the whole tab, all tree.
 */
/**
 * Folders to re-read, by normalised path, or every one in the tree. A module
 * bus rather than a remount, so a refresh keeps which folders are open.
 */
type Refresh = Set<string> | "all";
const refreshBus = new EventTarget();
const refresh = (dirs: Refresh) => refreshBus.dispatchEvent(new CustomEvent("refresh", { detail: dirs }));
// Separators and case vary between the root as stored and what the watcher
// reports; a loose match only costs an extra listing.
const norm = (p: string) => p.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();

export function FilesPanel({ chatId }: { chatId: string }) {
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  // The directory follows the chat's project, so moving the chat to another
  // project re-resolves it, as does changing the default directory.
  const projectId = useApp((s) => s.chats.find((c) => c.id === chatId)?.projectId ?? null);
  const defaultDir = useApp((s) => s.appSettings.defaultDirectory);
  // Paths handed to the chat (0.19.3). A chat with no project works in its
  // first granted folder, so a grant can move the root too.
  const { paths: granted } = useChatPaths(chatId);
  const grantKey = granted.map((g) => g.path).join("|");
  // A granted folder clicked below re-roots the tree on it, until the chat
  // changes or the grant goes.
  const [viewing, setViewing] = useState<string | null>(null);
  useEffect(() => { setViewing(null); }, [chatId]);
  useEffect(() => {
    if (viewing && !granted.some((g) => g.path === viewing)) setViewing(null);
  }, [grantKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    api.chatWorkingDir(chatId)
      .then((d) => { if (live) setRoot(d); })
      .catch(() => { if (live) setRoot(null); });
    return () => { live = false; };
  }, [chatId, projectId, defaultDir, grantKey]);

  const treeRoot = viewing ?? root;

  // The tree follows the disk: the watcher names the folders that changed, and
  // coming back to the window re-reads every open one, for the drives (network
  // shares, some WSL mounts) where the watcher hears nothing.
  useEffect(() => {
    if (!treeRoot) return;
    // Refused over the remote transport; the focus re-read still covers it.
    api.watchDir(treeRoot).catch(() => {});
    const off = api.onFilesChanged((dirs) => refresh(new Set(dirs.map(norm))));
    const onFocus = () => refresh("all");
    window.addEventListener("focus", onFocus);
    return () => {
      api.watchDir(null).catch(() => {});
      off.then((f) => f());
      window.removeEventListener("focus", onFocus);
    };
  }, [treeRoot]);

  if (root === undefined) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      {granted.length > 0 && (
        <div className="shrink-0 border-b border-[var(--color-border)] py-1">
          <div className="px-2.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            Granted
          </div>
          <ul>
            {granted.map((g) => (
              <li key={g.path} className="flex h-[22px] items-center gap-1 px-2.5 hover:bg-[var(--color-panel-hover)]">
                <button
                  className={`flex min-w-0 flex-1 items-center gap-1 text-left ${g.exists ? "" : "opacity-50"}`}
                  title={`${g.path}${g.inherited ? "\nGranted on the chat this one belongs to" : ""}`}
                  disabled={!g.isDir || !g.exists}
                  onClick={() => setViewing((v) => (v === g.path ? null : g.path))}
                >
                  {g.isDir ? (
                    <Folder size={12} className={`shrink-0 ${viewing === g.path ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"}`} />
                  ) : (
                    <FileIcon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                    <RootLabel path={g.path} />
                  </span>
                  {!g.exists && <span className="shrink-0 text-[9px] uppercase text-[var(--color-danger)]">stale</span>}
                </button>
                {g.exists && (
                  <IconButton title="Show in the file manager" onClick={() => api.revealPath(g.path).catch(reportError("Couldn't show it"))}>
                    <ExternalLink size={11} />
                  </IconButton>
                )}
                {g.inherited ? (
                  <span className="shrink-0 p-0.5 text-[var(--color-text-muted)]" title="Granted on the chat this one belongs to — take it back there">
                    <Lock size={10} />
                  </span>
                ) : (
                  <IconButton title="Take access back" onClick={() => api.revokeChatPath(chatId, g.path).catch(reportError("Couldn't take the access back"))}>
                    <X size={11} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {treeRoot ? (
        <>
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2.5 py-1.5">
            <Folder size={12} className="shrink-0 text-[var(--color-text-muted)]" />
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={treeRoot}>
              <RootLabel path={treeRoot} />
            </span>
            <IconButton title="Re-read the tree" onClick={() => refresh("all")}>
              <RefreshCw size={11} />
            </IconButton>
            <IconButton title="Open in the file manager" onClick={() => api.openPath(treeRoot).catch(console.warn)}>
              <ExternalLink size={11} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain py-1">
            {/* Keyed by chat and root too: a `Dir` reads its folder once, so without
                a remount switching chats kept showing the last chat's tree. */}
            <Dir key={`${chatId}:${treeRoot}`} path={treeRoot} depth={0} open />
          </div>
        </>
      ) : (
        <p className="px-2.5 py-2.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          No working directory. Give this chat a project with a directory, drop a folder on
          it, or set a default directory in Settings, and the file tools — and this tree —
          will be scoped to it.
        </p>
      )}
    </div>
  );
}

/** The last segment bright, the rest dim — a path reads from its end. */
function RootLabel({ path }: { path: string }) {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx < 0) return <>{path}</>;
  return (
    <>
      <span className="opacity-60">{path.slice(0, idx + 1)}</span>
      <span className="text-[var(--color-text)]">{path.slice(idx + 1)}</span>
    </>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  );
}

function Dir({ path, depth, open }: { path: string; depth: number; open: boolean }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listDir(path)
      .then((e) => { setEntries(e); setError(null); })
      .catch((e) => setError(String(e)));
  }, [path]);

  useEffect(() => {
    if (open && entries === null) load();
  }, [open, entries, load]);

  useEffect(() => {
    const on = (ev: Event) => {
      const dirs = (ev as CustomEvent<Refresh>).detail;
      if (dirs !== "all" && !dirs.has(norm(path))) return;
      // A closed folder forgets its listing, so opening it reads it fresh.
      if (open) load();
      else setEntries(null);
    };
    refreshBus.addEventListener("refresh", on);
    return () => refreshBus.removeEventListener("refresh", on);
  }, [path, open, load]);

  if (!open) return null;
  const pad = { paddingLeft: `${depth * 14 + 26}px` };
  if (error) return <div style={pad}><ErrorNote error={error} className="py-0.5 text-[10px] text-[var(--color-danger)]" /></div>;
  if (entries === null) return <div style={pad} className="py-0.5 text-[10px] text-[var(--color-text-muted)]">…</div>;
  if (entries.length === 0) return <div style={pad} className="py-0.5 text-[10px] italic text-[var(--color-text-muted)]">empty</div>;

  return (
    <ul>
      {entries.map((e) => (
        <Row key={e.path} entry={e} depth={depth} />
      ))}
    </ul>
  );
}

/** Thin guide lines, one per level, so a deep tree still reads as one. */
function Guides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          className="pointer-events-none absolute inset-y-0 w-px bg-[var(--color-border)]"
          style={{ left: `${i * 14 + 13}px` }}
        />
      ))}
    </>
  );
}

function Row({ entry, depth }: { entry: DirEntry; depth: number }) {
  const [open, setOpen] = useState(false);
  const selected = useApp((s) => isShowing(s.tabLayout, entry.path));
  const openFile = useApp((s) => s.openWorkspaceFile);
  const indent = { paddingLeft: `${depth * 14 + 6}px` };
  const hidden = entry.name.startsWith(".");

  if (entry.isDir) {
    return (
      <li>
        <button
          onClick={() => setOpen((v) => !v)}
          className={`relative flex h-[22px] w-full items-center gap-1 pr-2 text-left hover:bg-[var(--color-panel-hover)] ${hidden ? "opacity-60" : ""}`}
          style={indent}
        >
          <Guides depth={depth} />
          <span className="flex w-3.5 shrink-0 justify-center text-[var(--color-text-muted)]">
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
          {open ? (
            <FolderOpen size={13} className="shrink-0 text-[var(--viz-4)]" />
          ) : (
            <Folder size={13} className="shrink-0 text-[var(--viz-4)]" />
          )}
          <span className="truncate">{entry.name}</span>
        </button>
        <Dir path={entry.path} depth={depth + 1} open={open} />
      </li>
    );
  }
  const { Icon, color } = iconFor(entry.name);
  return (
    <li>
      <button
        onClick={() => openFile(entry.path)}
        // Middle-click opens the file without leaving the tab you are on, the
        // way it does in a browser. `onMouseDown` only to stop Windows from
        // dropping into autoscroll; the open itself is on `onAuxClick`, which
        // is the event a non-primary button actually completes on.
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
        onAuxClick={(e) => { if (e.button === 1) openFile(entry.path, true); }}
        title={`${entry.path}
Middle-click to open in a background tab`}
        className={`group relative flex h-[22px] w-full items-center gap-1 pr-2 text-left ${
          selected
            ? "bg-[var(--color-accent)]/15 text-[var(--color-text)]"
            : "hover:bg-[var(--color-panel-hover)]"
        } ${hidden && !selected ? "opacity-60" : ""}`}
        style={indent}
      >
        <Guides depth={depth} />
        {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-[var(--color-accent)]" />}
        <span className="w-3.5 shrink-0" />
        <Icon size={13} className="shrink-0" style={{ color }} />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.size !== null && (
          <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100">
            {formatBytes(entry.size)}
          </span>
        )}
      </button>
    </li>
  );
}

const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp",
  "cs", "rb", "php", "sh", "ps1", "bat", "sql", "css", "scss", "less", "vue", "svelte", "lua", "zig",
]);
const DATA = new Set(["json", "yaml", "yml", "toml", "xml", "ini", "env", "lock"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
const TABLE = new Set(["csv", "tsv", "xlsx", "xls", "parquet"]);
const DOC = new Set(["md", "mdx", "txt", "rst", "adoc", "pdf", "docx", "rtf", "log"]);

/** An icon and a colour by what the extension says the file is. */
export function iconFor(name: string): { Icon: typeof FileIcon; color: string } {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "html" || ext === "htm") return { Icon: Globe, color: "var(--viz-2)" };
  if (CODE.has(ext)) return { Icon: FileCode2, color: "var(--viz-1)" };
  if (DATA.has(ext)) return { Icon: FileJson2, color: "var(--viz-4)" };
  if (IMAGE.has(ext)) return { Icon: FileImage, color: "var(--viz-3)" };
  if (TABLE.has(ext)) return { Icon: Table2, color: "var(--viz-3)" };
  if (DOC.has(ext)) return { Icon: FileText, color: "var(--color-text-muted)" };
  return { Icon: FileIcon, color: "var(--color-text-muted)" };
}
