import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { ContentPart, Message, StreamEvent } from "@/lib/types";

/**
 * Telling the user a run has stopped and is waiting for them (0.14.3).
 *
 * Two kinds of moment, each with its own setting: the run needs an answer (a
 * tool approval, an `ask_user`), or the run has ended (0.18.1). With the window
 * closed to the tray, an ended run is as blocked on the user as an approval is
 * — nothing more happens until they read it and reply.
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
export async function notifyWaiting(title: string, body: string, flash = true): Promise<void> {
  if (await windowIsFocused()) return;

  if (flash) {
    try {
      await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
    } catch { /* not in a Tauri window */ }
  }

  if (!(await ensurePermission())) return;
  try {
    sendNotification(body ? { title, body } : { title });
  } catch { /* a failed notification must never break the turn */ }
}

/**
 * Post one now, focused or not — the Settings button that answers "will I
 * actually see these?". False when the system has notifications blocked.
 * Permission is asked afresh: it may have been allowed since it was cached.
 */
export async function sendTestNotification(): Promise<boolean> {
  granted = null;
  if (!(await ensurePermission())) return false;
  try {
    sendNotification({ title: "MultiZone", body: "Notifications are on." });
    return true;
  } catch {
    return false;
  }
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

/** Why the current turn of each chat is ending, learned from the events before
 *  its `done`. `null` means the turn already said what it was waiting for. */
const endings = new Map<string, { title: string; body: string } | null>();

/**
 * What to say when a turn ends, or null when this event is not the end of one
 * (or its end was already announced). Fed every primary event of a chat in
 * order; `messages` is the chat as the store holds it, answer included.
 */
export function finishedNotice(
  chatId: string,
  event: StreamEvent,
  messages: Message[],
): { title: string; body: string } | null {
  switch (event.type) {
    case "user_message_saved":
    case "cancelled":
      endings.delete(chatId);
      return null;
    case "tool_call_result":
      // A question or a plan ends the turn to wait on the user; the waiting
      // notice covers it, so the `done` after it stays quiet.
      if (event.name === "ask_user" || event.name === "exit_plan_mode") endings.set(chatId, null);
      return null;
    case "runaway":
      endings.set(chatId, { title: "Stopped", body: event.label });
      return null;
    case "spend_limit":
      endings.set(chatId, { title: "Spend limit reached", body: `${event.spent.toLocaleString()} of ${event.cap.toLocaleString()} tokens` });
      return null;
    case "error":
      endings.set(chatId, null);
      return { title: "Run failed", body: event.message.slice(0, 160) };
    case "done": {
      const known = endings.get(chatId);
      endings.delete(chatId);
      if (known === null) return null;
      return known ?? { title: "Finished", body: lastAnswerLine(messages) };
    }
    default:
      return null;
  }
}

/** The first line of the chat's latest answer, stripped of Markdown marks. */
export function lastAnswerLine(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || m.zoneId) continue;
    let parts: ContentPart[] = [];
    try { parts = JSON.parse(m.content); } catch { /* not parts */ }
    const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    const line = text.split("\n").map((l) => l.replace(/[#>*_`|-]+/g, " ").trim()).find(Boolean);
    if (line) return line.length > 140 ? `${line.slice(0, 139)}…` : line;
  }
  return "The answer is ready.";
}
