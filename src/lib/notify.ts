import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

/**
 * Telling the user a run has stopped and is waiting for them (0.14.3).
 *
 * Two moments qualify, and only two: a tool approval and an `ask_user`. Both
 * block the turn indefinitely — the approval until its five-minute timeout
 * auto-denies it and the sub-agent stalls with no visible cause — and both are
 * most likely to arrive while the user is somewhere else, because the reason to
 * run an agent for ten minutes is *not* to sit watching it.
 *
 * A finished turn deliberately does not notify. Completion is the expected
 * outcome; a toast for every one of them is how people learn to dismiss toasts
 * without reading them, and then the two that matter get dismissed too.
 */

/** Notifications for something already on screen are noise, not information. */
async function windowIsFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    // Not in a Tauri window (the browser harness): treat the page's own focus
    // as the answer rather than notifying into the void.
    return typeof document !== "undefined" ? document.hasFocus() : true;
  }
}

/**
 * Permission is asked for once, lazily — at the first moment we actually have
 * something to say. Asking on launch trains people to deny it before they know
 * what it is for.
 */
let granted: boolean | null = null;
async function ensurePermission(): Promise<boolean> {
  if (granted !== null) return granted;
  try {
    granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch {
    granted = false;
  }
  return granted;
}

/**
 * Flash the taskbar and, if the window is in the background, post an OS
 * notification.
 *
 * The taskbar flash is the one that always fires: it is quiet, it needs no
 * permission, and on Windows it is what a person actually notices. The
 * notification is the louder half and is reserved for a window that is not
 * being looked at.
 */
export async function notifyWaiting(title: string, body: string): Promise<void> {
  if (await windowIsFocused()) return;

  try {
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
  } catch { /* not in a Tauri window */ }

  if (!(await ensurePermission())) return;
  try {
    sendNotification({ title, body });
  } catch { /* a failed notification must never break the turn */ }
}

/**
 * Clear the taskbar highlight once the thing that raised it has an answer, so a
 * window flashing amber always means something is still waiting.
 */
export async function clearAttention(): Promise<void> {
  try {
    await getCurrentWindow().requestUserAttention(null);
  } catch { /* not in a Tauri window */ }
}
