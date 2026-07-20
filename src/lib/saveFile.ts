import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

/**
 * Save text to a user-chosen location.
 *
 * Every export used to go straight to the browser download dir via an anchor
 * click, giving the user no say in where the file landed. In the Tauri shell we
 * show a native save dialog instead; the anchor path stays as the fallback for
 * a plain browser (dev server) where the dialog plugin is unavailable.
 *
 * Returns false when the user cancelled the dialog, true when a file was written.
 */
export async function saveTextFile(
  defaultName: string,
  contents: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<boolean> {
  let path: string | null;
  try {
    path = await save({ defaultPath: defaultName, filters });
  } catch {
    // Not running in the Tauri shell (e.g. plain browser dev server).
    downloadFallback(defaultName, contents);
    return true;
  }
  if (!path) return false; // user cancelled
  // Backend write: the fs plugin's scope rejects arbitrary dialog-chosen paths.
  // Errors propagate so a failed export surfaces instead of silently becoming
  // a download to some other directory.
  await invoke("write_export_file", { path, contents });
  return true;
}

function downloadFallback(name: string, contents: string) {
  const blob = new Blob([contents], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
