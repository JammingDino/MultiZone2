import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { File as FileIcon, Folder, FolderPlus, Lock, X } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { reportError } from "@/lib/reportError";
import { isLocalBrowser, isRemote } from "@/lib/remote/transport";
import { findPaths } from "@/lib/pathText";
import type { DropPathResult } from "@/lib/dropPaths";
import type { ChatPath, ChatPathSource, PathContext } from "@/lib/types";
import { CHROME_QUIET } from "@/lib/chrome";

/**
 * Folders and files handed to a chat (0.19.3) — see `src-tauri/src/grants.rs`
 * for what a grant is and how far it reaches.
 *
 * Three ways in, all ending at `grantChatPath`: a folder dropped on the chat
 * (granted at once — a dropped folder means exactly one thing), a path pasted
 * into the composer (offered, not granted — pasted text is usually just text),
 * and "Add folder…" (the native picker, which works whatever the drop bridge
 * manages on this machine). Everything granted shows above the composer, so a
 * grant that lasts as long as the chat is never out of sight.
 */

const EMPTY: ChatPath[] = [];

/** The chat's grants, kept current by `chat-paths-changed`. */
export function useChatPaths(chatId: string | null): { paths: ChatPath[]; refresh: () => void } {
  const [paths, setPaths] = useState<ChatPath[]>(EMPTY);
  const refresh = useCallback(() => {
    if (!chatId) { setPaths(EMPTY); return; }
    api.listChatPaths(chatId).then(setPaths).catch(() => setPaths(EMPTY));
  }, [chatId]);
  useEffect(() => {
    refresh();
    // Any chat's change refreshes: a sub-agent shows its parent's grants, and
    // the event names the parent.
    const un = api.onChatPathsChanged(() => refresh());
    return () => { void un.then((u) => u()); };
  }, [refresh]);
  return { paths, refresh };
}

export function baseName(path: string): string {
  const t = path.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  return i < 0 ? t : t.slice(i + 1) || t;
}

const CHIP =
  "flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs";
const CHIP_NEUTRAL = `${CHIP} border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text-muted)]`;
const CHIP_ACCENT = `${CHIP} border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]`;

/**
 * What this chat can reach beyond its working directory. Clicking a chip opens
 * the Files panel; ✕ takes the grant back (not offered for an inherited one,
 * which is revoked on the chat that made it).
 */
export function GrantedStrip({ chatId, notice, onDismissNotice }: {
  chatId: string;
  notice?: string | null;
  onDismissNotice?: () => void;
}) {
  const { paths } = useChatPaths(chatId);
  const focusWorkspace = useApp((s) => s.focusWorkspace);
  if (paths.length === 0 && !notice) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {paths.length > 0 && (
        <span className="text-[11px] text-[var(--color-text-muted)]" title="The agents in this chat can read and edit these, from your next message.">
          Access:
        </span>
      )}
      {paths.map((p) => (
        <span key={p.path} className={`${CHIP_NEUTRAL} ${p.exists ? "" : "line-through opacity-60"}`} title={`${p.path}${p.exists ? "" : " — no longer there"}${p.inherited ? "\nGranted on the chat this one belongs to" : ""}`}>
          <button
            className="flex min-w-0 items-center gap-1 hover:text-[var(--color-text)]"
            onClick={() => focusWorkspace("files")}
          >
            {p.isDir ? <Folder size={11} className="shrink-0" /> : <FileIcon size={11} className="shrink-0" />}
            <span className="max-w-[220px] truncate">{baseName(p.path)}</span>
          </button>
          {p.inherited ? (
            <Lock size={10} className="shrink-0 opacity-60" />
          ) : (
            <button
              className="shrink-0 hover:text-[var(--color-text)]"
              title="Take access back"
              onClick={() => api.revokeChatPath(chatId, p.path).catch(reportError("Couldn't take the access back"))}
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {notice && (
        <span className={`${CHIP} border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400`}>
          <span>{notice}</span>
          {onDismissNotice && (
            <button onClick={onDismissNotice} className="hover:text-[var(--color-text)]" title="Dismiss">
              <X size={11} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** A path the user might want to hand over, and where it would go. `granted`
 *  marks one already handed over, offered only for what can follow (a move
 *  into its project). */
export type PathOffer = PathContext & { granted?: boolean };

/**
 * Paths found in pasted text, confirmed to exist by the desktop. Pasting does
 * not grant — these are offers, each one click away.
 */
export function usePasteOffers() {
  const [offers, setOffers] = useState<PathOffer[]>([]);
  const fromText = useCallback((text: string) => {
    const found = findPaths(text);
    if (found.length === 0) return;
    void Promise.all(found.map((p) => api.pathContext(p).catch(() => null))).then((ctxs) => {
      const real = ctxs.filter((c): c is PathContext => c !== null);
      if (real.length === 0) return;
      setOffers((cur) => [...cur, ...real.filter((r) => !cur.some((c) => c.path === r.path))]);
    });
  }, []);
  const dismiss = useCallback((path: string) => setOffers((cur) => cur.filter((o) => o.path !== path)), []);
  const clear = useCallback(() => setOffers([]), []);
  return { offers, fromText, dismiss, clear, setOffers };
}

export interface OfferAction {
  label: string;
  title?: string;
  run: (offer: PathOffer) => void | Promise<void>;
  primary?: boolean;
}

/** One chip per offer, with the actions the caller allows for it. */
export function PathOffers({ offers, actions, onDismiss }: {
  offers: PathOffer[];
  actions: (offer: PathOffer) => OfferAction[];
  onDismiss: (path: string) => void;
}) {
  // An offer with nothing to do (a path already inside the chat's project) is
  // not worth a chip.
  const shown = offers.map((o) => ({ o, acts: actions(o) })).filter((x) => x.acts.length > 0);
  if (shown.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {shown.map(({ o, acts }) => (
        <span key={o.path} className={CHIP_ACCENT} title={o.path}>
          {o.isDir ? <Folder size={11} className="shrink-0" /> : <FileIcon size={11} className="shrink-0" />}
          <span className="max-w-[220px] truncate">{baseName(o.path)}</span>
          {acts.map((a) => (
            <button
              key={a.label}
              title={a.title}
              onClick={() => void a.run(o)}
              className={`shrink-0 rounded-full px-1.5 ${a.primary ? "bg-[var(--color-accent)] text-[var(--color-bg)]" : "underline-offset-2 hover:underline"}`}
            >
              {a.label}
            </button>
          ))}
          <button className="shrink-0 hover:text-[var(--color-text)]" title="Leave it as text" onClick={() => onDismiss(o.path)}>
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * A path waiting for the chat the Home screen is about to create. `grant` is
 * handed to the new chat; `project` starts the chat in the project that
 * already has it (smart project detection's default when one does); `newProject`
 * makes the folder a project of its own and starts there.
 */
export interface PendingPath {
  ctx: PathContext;
  mode: "grant" | "project" | "newProject";
}

/** Add contexts as pending, a known project's folder defaulting to its project. */
export function addPending(cur: PendingPath[], ctxs: PathContext[], haveProject: boolean): PendingPath[] {
  const out = [...cur];
  let projectTaken = haveProject || cur.some((p) => p.mode !== "grant");
  for (const ctx of ctxs) {
    if (out.some((p) => p.ctx.path === ctx.path)) continue;
    const mode: PendingPath["mode"] = ctx.project && !projectTaken ? "project" : "grant";
    if (mode === "project") projectTaken = true;
    out.push({ ctx, mode });
  }
  return out;
}

export function PendingPaths({ items, onChange, canChooseProject }: {
  items: PendingPath[];
  onChange: (next: PendingPath[]) => void;
  /** False when a project is already picked, or a new one is being made. */
  canChooseProject: boolean;
}) {
  if (items.length === 0) return null;
  const set = (path: string, mode: PendingPath["mode"]) =>
    onChange(items.map((p) => (p.ctx.path === path ? { ...p, mode } : p)));
  const drop = (path: string) => onChange(items.filter((p) => p.ctx.path !== path));
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {items.map(({ ctx, mode }) => (
        <span key={ctx.path} className={mode === "grant" ? CHIP_NEUTRAL : CHIP_ACCENT} title={ctx.path}>
          {ctx.isDir ? <Folder size={11} className="shrink-0" /> : <FileIcon size={11} className="shrink-0" />}
          <span className="max-w-[200px] truncate">{baseName(ctx.path)}</span>
          {mode === "project" && ctx.project && (
            <>
              <span className="opacity-70">→ in {ctx.project.name}</span>
              <button className="underline-offset-2 hover:underline" onClick={() => set(ctx.path, "grant")}>Just this folder</button>
            </>
          )}
          {mode === "newProject" && (
            <>
              <span className="opacity-70">→ new project</span>
              <button className="underline-offset-2 hover:underline" onClick={() => set(ctx.path, "grant")}>Just this folder</button>
            </>
          )}
          {mode === "grant" && canChooseProject && ctx.project && (
            <button className="underline-offset-2 hover:underline" onClick={() => set(ctx.path, "project")}>Start in {ctx.project.name}</button>
          )}
          {mode === "grant" && canChooseProject && !ctx.project && ctx.looksLikeProject && ctx.isDir && (
            <button className="underline-offset-2 hover:underline" onClick={() => set(ctx.path, "newProject")}>Make it a project</button>
          )}
          <button className="shrink-0 hover:text-[var(--color-text)]" title="Don't hand this over" onClick={() => drop(ctx.path)}>
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Resolve paths to contexts, reporting the ones that can't be handed over. */
export async function contextsFor(paths: string[]): Promise<PathContext[]> {
  const out: PathContext[] = [];
  for (const p of paths) {
    try {
      out.push(await api.pathContext(p));
    } catch (e) {
      reportError(`Couldn't use ${baseName(p)}`)(e);
    }
  }
  return out;
}

/**
 * Something to say in a chat's composer before it has mounted — a chat opened
 * from Explorer is created, then shown, and the composer picks this up on its
 * first render for that chat. Taken once.
 */
const queuedOutcomes = new Map<string, { notice: string | null; offers: PathOffer[] }>();
export function queueOutcome(chatId: string, notice: string | null, offers: PathOffer[]) {
  queuedOutcomes.set(chatId, { notice, offers });
}
export function takeQueuedOutcome(chatId: string) {
  const out = queuedOutcomes.get(chatId) ?? null;
  queuedOutcomes.delete(chatId);
  return out;
}

/** Pick one or more folders with the native dialog. Empty when cancelled. */
export async function pickFolders(): Promise<string[]> {
  const picked = await openDialog({ directory: true, multiple: true, title: "Give this chat a folder" });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/** "Add folder…" — next to the attach button. Hidden on a remote window, which
 *  has no picker on the desktop's disk. */
export function AddFolderButton({ onPick, className = "rounded p-1.5", size = 16 }: {
  onPick: (paths: string[]) => void;
  className?: string;
  size?: number;
}) {
  if (isRemote() && !isLocalBrowser()) return null;
  return (
    <button
      onClick={() => { pickFolders().then((p) => { if (p.length) onPick(p); }).catch(reportError("Couldn't open the folder picker")); }}
      className={`${className} ${CHROME_QUIET}`}
      title="Give this chat a folder — its agents can read and edit it"
    >
      <FolderPlus size={size} />
    </button>
  );
}

/** Grant several paths, reporting failures in the user's terms. */
export async function grantAll(chatId: string, paths: string[], source: ChatPathSource): Promise<ChatPath[]> {
  const out: ChatPath[] = [];
  for (const p of paths) {
    try {
      out.push(await api.grantChatPath(chatId, p, source));
    } catch (e) {
      reportError(`Couldn't give the chat ${baseName(p)}`)(e);
    }
  }
  return out;
}

/** The sentence for folders a drop carried but the bridge couldn't place. */
export function missedFoldersNotice(drop: DropPathResult): string | null {
  const got = drop.paths.filter((p) => p.isDir).length;
  if (drop.folderCount <= got) return null;
  return "Couldn't read that folder's location — paste its path or use Add folder.";
}

/**
 * Folders dropped into an open chat. A folder already inside the chat's own
 * project is not granted again (the project covers it); one that belongs to a
 * different project is granted and the move offered, never made — moving a
 * chat changes its working directory mid-conversation.
 */
export async function grantDroppedFolders(
  chatId: string,
  chatProjectId: string | null,
  folders: string[],
): Promise<{ notice: string | null; moveOffers: PathOffer[] }> {
  let notice: string | null = null;
  const moveOffers: PathOffer[] = [];
  for (const f of folders) {
    const ctx = await api.pathContext(f).catch((e) => { reportError(`Couldn't give the chat ${baseName(f)}`)(e); return null; });
    if (!ctx) continue;
    if (ctx.project && ctx.project.projectId === chatProjectId) {
      notice = `${baseName(f)} is already in this chat's project.`;
      continue;
    }
    const granted = await grantAll(chatId, [ctx.path], "drop");
    if (granted.length && (ctx.project || (ctx.looksLikeProject && !chatProjectId))) {
      moveOffers.push({ ...ctx, granted: true });
    }
  }
  return { notice, moveOffers };
}

/** "Make this a project": a project on the folder, the chat moved into it, and
 *  the grant it no longer needs taken back. */
export async function makeProjectFrom(chatId: string, folder: string): Promise<void> {
  const project = await api.upsertProject({ name: baseName(folder), directory: folder });
  const app = useApp.getState();
  await app.refreshProjects();
  await app.setChatProject(chatId, project.id);
  await api.revokeChatPath(chatId, folder).catch(() => undefined);
}
