import { create } from "zustand";
import type { Chat } from "@/lib/types";

/**
 * Chat locks, window side (0.20). Rust holds the passwords and decides; this is
 * only what the window needs to draw the right thing: which chat's lock covers
 * a chat, and which locks this session has opened.
 */

type LockFields = Pick<Chat, "id" | "parentChatId" | "lockKind">;

/**
 * The chat whose lock covers `id` — itself, or its nearest locked ancestor (a
 * branch or sub-agent is under its parent's lock). Same walk as Rust's
 * `chat_lock::lock_root`, bounded the same way.
 */
export function lockRoot(chats: readonly LockFields[], id: string): string | null {
  const byId = new Map(chats.map((c) => [c.id, c]));
  let cur = byId.get(id);
  for (let i = 0; cur && i < 64; i++) {
    if (cur.lockKind) return cur.id;
    cur = cur.parentChatId ? byId.get(cur.parentChatId) : undefined;
  }
  return null;
}

interface ChatLocks {
  /** Lock roots opened this session. Rust forgets them on restart; so do we. */
  unlocked: string[];
  appPasswordSet: boolean;
}

export const useChatLocks = create<ChatLocks>(() => ({ unlocked: [], appPasswordSet: false }));

export function setUnlocked(root: string, open: boolean) {
  useChatLocks.setState((s) => ({
    unlocked: open ? [...new Set([...s.unlocked, root])] : s.unlocked.filter((r) => r !== root),
  }));
}

/**
 * Idle relock (0.21): minutes without the person's own keyboard, pointer or
 * touch before every open lock closes again; 0 is never. Read the same way as
 * Rust's `chat_lock::idle_minutes` — anything else is the default.
 */
export const DEFAULT_IDLE_MINUTES = 15;
export const IDLE_CHOICES = [0, 5, 15, 30, 60] as const;

export function idleMinutes(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1440 ? v : DEFAULT_IDLE_MINUTES;
}

export function idleExpired(lastActive: number, now: number, minutes: number): boolean {
  return minutes > 0 && now - lastActive >= minutes * 60_000;
}

/** Locked and not opened this session: draw the unlock screen, read nothing. */
export function isLockedNow(chats: readonly LockFields[], id: string, unlocked: readonly string[]): boolean {
  const root = lockRoot(chats, id);
  return root !== null && !unlocked.includes(root);
}
