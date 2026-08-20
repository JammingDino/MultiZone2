import type { ContentPart, InputPart } from "@/lib/types";

/**
 * Turns the app sends on the user's behalf.
 *
 * Approving a plan starts the run by sending "Approved — carry out the plan."
 * as an ordinary user turn, which then appears in the transcript as a message
 * the user typed. They didn't: they pressed a button, and reading the chat back
 * afterwards shows words in their mouth they never said.
 *
 * The model still needs the sentence, so it is sent as a `hidden_text` part —
 * already the app's mechanism for "context the model gets, the transcript
 * doesn't" — behind a marker the thread recognises and draws as a system line
 * instead of a message bubble.
 */

const PREFIX = "[MultiZone] ";

/** Wrap `text` as a turn the app sent, not one the user typed. */
export function systemTurnParts(text: string): InputPart[] {
  return [{ type: "hidden_text", text: PREFIX + text }];
}

/**
 * The system line this message should render as, or null if it is a real user
 * turn. A message qualifies only when the marker is *all* it carries — anything
 * the user typed or attached alongside it makes it their message again.
 */
export function systemTurnNotice(parts: ContentPart[]): string | null {
  if (parts.length !== 1) return null;
  const only = parts[0];
  if (only.type !== "hidden_text" || !only.text.startsWith(PREFIX)) return null;
  return only.text.slice(PREFIX.length);
}

/** What the plan-approval turn tells the model to do. */
export const PLAN_APPROVED = "Approved — carry out the plan.";
