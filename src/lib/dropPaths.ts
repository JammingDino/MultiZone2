import { listen } from "@tauri-apps/api/event";
import { isRemote } from "@/lib/remote/transport";

/**
 * The real filesystem paths behind a drop (0.19.3) — the page half of
 * `src-tauri/src/dropbridge.rs`, which explains why this is not simply Tauri's
 * native drag-drop event.
 *
 * A DOM drop carries contents but not paths. WebView2 lets the page hand the
 * dropped objects to the host (`postMessageWithAdditionalObjects`), and the host
 * reads their paths and answers with an `mz-drop-paths` event carrying the same
 * token. Both kinds of object are posted: the `File`s, and — for each entry —
 * the `FileSystemHandle` from `getAsFileSystemHandle()`, since a directory's
 * `File` is not guaranteed to carry a path and its handle is the documented
 * second route. The host de-duplicates.
 *
 * Every failure resolves to fewer paths, never to a hang or a throw: on a remote,
 * off Windows, on a runtime without the API, or past the timeout, the drop
 * simply reports what it got. `folderCount` is how many dropped entries the DOM
 * thought were folders, so a caller can tell "no folders" from "folders whose
 * location we couldn't read" and point at the picker instead.
 */
export interface DroppedPath {
  path: string;
  isDir: boolean;
}

export interface DropPathResult {
  paths: DroppedPath[];
  folderCount: number;
}

/** A drop's contents, split the way the DOM sees them. */
export interface DropSplit {
  /** The dropped files, without the zero-byte stand-ins folders arrive as —
   *  what attaching should see. */
  files: File[];
  /** Resolves to the paths, once the desktop has read them. */
  paths: Promise<DropPathResult>;
}

const TIMEOUT_MS = 1500;

interface WebViewBridge {
  postMessageWithAdditionalObjects?: (message: string, objects: ArrayLike<unknown>) => void;
}

function bridge(): WebViewBridge | null {
  const w = window as unknown as { chrome?: { webview?: WebViewBridge } };
  const wv = w.chrome?.webview;
  return wv && typeof wv.postMessageWithAdditionalObjects === "function" ? wv : null;
}

/** Whether a drop could carry folders at all — for the overlay's wording. */
export function canReadDropPaths(): boolean {
  return !isRemote() && bridge() !== null;
}

/**
 * Start reading a drop's paths. Must be called *synchronously* inside the drop
 * handler: `dataTransfer` is emptied the moment the handler returns, so
 * everything is copied out before the first `await`.
 */
export function splitDrop(dt: DataTransfer): DropSplit {
  const items = Array.from(dt.items ?? []).filter((it) => it.kind === "file");
  const all = Array.from(dt.files ?? []);
  // Fall back to every file when the DOM won't describe entries at all, so a
  // runtime without `webkitGetAsEntry` attaches exactly what it always did.
  let described = items.length > 0;
  const plain: File[] = [];
  let folderCount = 0;
  for (const it of items) {
    try {
      const entry = it.webkitGetAsEntry?.();
      if (!entry) { described = false; continue; }
      if (entry.isDirectory) folderCount += 1;
      else {
        const f = it.getAsFile();
        if (f) plain.push(f);
      }
    } catch {
      described = false;
    }
  }
  return {
    files: described ? plain : all,
    paths: readPaths(items, all, folderCount),
  };
}

/** Just the paths. See `splitDrop`, which most callers want. */
export function collectDropPaths(dt: DataTransfer): Promise<DropPathResult> {
  return splitDrop(dt).paths;
}

function readPaths(
  items: DataTransferItem[],
  files: File[],
  folderCount: number,
): Promise<DropPathResult> {
  const wv = isRemote() ? null : bridge();
  if (!wv || (files.length === 0 && items.length === 0)) {
    return Promise.resolve({ paths: [], folderCount });
  }
  // Started now, resolved later: the handle request has to begin while the
  // drop is still live.
  const handles = items.map((it) => {
    const get = (it as unknown as { getAsFileSystemHandle?: () => Promise<unknown> })
      .getAsFileSystemHandle;
    if (typeof get !== "function") return Promise.resolve(null);
    try {
      return get.call(it).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  });
  const token = crypto.randomUUID();

  return new Promise<DropPathResult>((resolve) => {
    let done = false;
    let unlisten: (() => void) | null = null;
    const finish = (paths: DroppedPath[]) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      unlisten?.();
      resolve({ paths, folderCount });
    };
    const timer = window.setTimeout(() => finish([]), TIMEOUT_MS);

    void listen<{ token: string; paths: DroppedPath[] }>("mz-drop-paths", (e) => {
      if (e.payload?.token === token) finish(e.payload.paths ?? []);
    })
      .then(async (u) => {
        unlisten = u;
        if (done) { u(); return; }
        const resolved = (await Promise.all(handles)).filter((h) => h != null);
        try {
          // Wry also receives this message and logs it as an invalid IPC call;
          // that one console line is expected (see dropbridge.rs).
          wv.postMessageWithAdditionalObjects!(`mz-drop:${token}`, [...files, ...resolved]);
        } catch {
          // An object the runtime refuses to marshal fails the whole post.
          // Retry with the files alone before giving up.
          try {
            wv.postMessageWithAdditionalObjects!(`mz-drop:${token}`, files);
          } catch {
            finish([]);
          }
        }
      })
      .catch(() => finish([]));
  });
}
