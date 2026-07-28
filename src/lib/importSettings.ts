/**
 * Ways to get a settings bundle in front of the user (1.0).
 *
 * A settings export is only useful if applying it is easier than redoing the
 * setup by hand, so there are three routes to the same confirmation dialog:
 * pick a file, drop a file on the window, or paste the JSON. All of them end at
 * `stageImport`, which raises `ImportSettingsDialog`.
 *
 * A link-based route (`multizone://…`) was considered and dropped: a real bundle
 * is tens of kilobytes, well past what a URL can carry, and putting API keys in
 * something clickable and pasteable is a bad trade for the convenience.
 */
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./tauri";
import { parseSettingsBundle, type SettingsBundle } from "./settingsBundle";

/** Extensions we'll treat as a candidate settings export when dropped. */
export const SETTINGS_FILE_EXTENSIONS = ["json", "mzsettings"];

export function isSettingsFileName(path: string): boolean {
  const lower = path.toLowerCase();
  return SETTINGS_FILE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

/** Last path segment, for naming the file in the dialog. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Read and parse a bundle from a path on disk. Throws with a readable message —
 * callers surface it rather than failing quietly.
 */
export async function readBundleFile(
  path: string,
): Promise<{ bundle: SettingsBundle; source: string }> {
  const raw = await api.readTextFile(path);
  return { bundle: parseSettingsBundle(raw), source: baseName(path) };
}

/**
 * Show the native file picker and parse the chosen bundle. Resolves to null when
 * the user cancels, so callers can tell "nothing happened" from "that failed".
 */
export async function pickBundleFile(): Promise<{ bundle: SettingsBundle; source: string } | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "MultiZone settings", extensions: SETTINGS_FILE_EXTENSIONS }],
  });
  if (typeof selected !== "string") return null;
  return readBundleFile(selected);
}

/**
 * Offer a set of dropped files to the settings importer, for the drop targets
 * the app already has (the chat composer, the home screen).
 *
 * Claiming is decided by *content*, not by extension: a settings export is the
 * only JSON that parses as a bundle, so an ordinary `.json` the user meant to
 * attach to a chat still gets attached. Returns true when a bundle was found and
 * staged, and the caller should skip its own handling.
 *
 * Native OS drag-drop stays disabled for the window (`dragDropEnabled: false`)
 * because the composer and zone library need the webview's own drop events —
 * so this works off the DOM `FileList`, which carries content directly and
 * needs no filesystem path.
 */
export async function claimSettingsDrop(
  files: File[],
  stage: (pending: { bundle: SettingsBundle; source: string }) => void,
): Promise<boolean> {
  for (const file of files) {
    if (!isSettingsFileName(file.name)) continue;
    try {
      const bundle = parseSettingsBundle(await file.text());
      stage({ bundle, source: file.name });
      return true;
    } catch {
      // Not a settings export — fall through so the caller handles it normally.
    }
  }
  return false;
}
