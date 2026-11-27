import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2, Lock } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { idleExpired, idleMinutes, lockRoot, setUnlocked, useChatLocks } from "@/lib/chatLock";
import { isLocalBrowser, isRemote } from "@/lib/remote/transport";
import { Modal, ModalTitle } from "@/components/common/Modal";
import { PRIMARY_ACTION } from "@/lib/chrome";
import { errorText } from "@/lib/errors";

/**
 * Chat locks in the window (0.20). Passwords go to Rust and a yes or no comes
 * back; nothing here can open a chat on its own — the transcript read is
 * refused by Rust until `unlock_chat` has said yes this session.
 */

/** Said wherever a lock is set, because "locked" reads like "encrypted". */
const NOT_ENCRYPTION =
  "This is a lock, not encryption: the chat stays unencrypted in the app's database on disk.";

const INPUT =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";
const SECONDARY =
  "rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50";

/**
 * Sync with Rust's session state — on start, after a reload, and whenever
 * chats change (a lock closed elsewhere: "Lock now" on another device, the
 * window going to the tray). What Rust no longer has open is closed here too.
 */
export function refreshLockStatus() {
  api
    .chatLockStatus()
    .then((s) => {
      const gone = useChatLocks.getState().unlocked.filter((r) => !s.unlocked.includes(r));
      useChatLocks.setState(s);
      for (const root of gone) dropTranscripts(root);
    })
    .catch(console.error);
}

/** The transcripts in memory for a lock and its branches, so nothing on screen keeps showing them. */
function dropTranscripts(root: string) {
  setUnlocked(root, false);
  useApp.setState((s) => {
    const messagesByChat = { ...s.messagesByChat };
    for (const c of s.chats) if (lockRoot(s.chats, c.id) === root) delete messagesByChat[c.id];
    return { messagesByChat };
  });
}

/** Close a lock ("Lock now", or just after locking) — everywhere it is open. */
export async function closeLock(root: string) {
  await api.relockChat(root);
  dropTranscripts(root);
}

/**
 * Idle relock (0.21). The person's own keyboard, pointer and touch keep this
 * screen's unlocks open; past the idle time they close, here and in Rust, for
 * this screen only. Rust closes them a minute later on its own, for a page
 * that is frozen or gone. A phone whose screen goes off or that leaves the app
 * locks at once — that is its screen lock. Started once, by the chat panel.
 */
let watching = false;
let lastActive = Date.now();
let lastReport = 0;
/** Rust's backstop is a minute behind ours, so this lands well inside it. */
const REPORT_EVERY_MS = 30_000;

export function watchIdle() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const anyOpen = () => useChatLocks.getState().unlocked.length > 0;
  const minutes = () => idleMinutes(useApp.getState().appSettings.chatLockIdleMinutes);
  const active = (e: Event) => {
    // A layout shift under a still mouse fires moves with no movement in them.
    if (e instanceof PointerEvent && e.type === "pointermove" && !e.movementX && !e.movementY) return;
    lastActive = Date.now();
    if (anyOpen() && lastActive - lastReport > REPORT_EVERY_MS) {
      lastReport = lastActive;
      api.chatLockActivity(false).catch(() => {});
    }
  };
  for (const type of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"]) {
    window.addEventListener(type, active, { capture: true, passive: true });
  }
  const relock = () => {
    if (!anyOpen()) return;
    for (const root of useChatLocks.getState().unlocked) dropTranscripts(root);
    api.chatLockActivity(true).catch(console.error);
  };
  const check = () => {
    if (idleExpired(lastActive, Date.now(), minutes())) relock();
  };
  setInterval(check, 15_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
    else if (isRemote() && !isLocalBrowser() && minutes() > 0) relock();
  });
}

/** The pane: the chat itself, or its unlock screen while it is locked. */
export function LockGate({ chatId, children }: { chatId: string; children: ReactNode }) {
  const chats = useApp((s) => s.chats);
  const unlocked = useChatLocks((s) => s.unlocked);
  const root = lockRoot(chats, chatId);
  if (!root || unlocked.includes(root)) return <>{children}</>;
  return <UnlockScreen root={root} chatId={chatId} />;
}

function UnlockScreen({ root, chatId }: { root: string; chatId: string }) {
  const rootChat = useApp((s) => s.chats.find((c) => c.id === root));
  const appPasswordSet = useChatLocks((s) => s.appPasswordSet);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const perChat = rootChat?.lockKind === "chat";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await api.unlockChat(root, password)) setUnlocked(root, true);
      else setError("Wrong password.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="mz-view-in flex min-h-0 flex-1 flex-col items-center justify-center p-6">
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col items-center gap-3 text-center">
        <Lock size={28} className="text-[var(--color-text-muted)]" />
        <div className="text-sm font-medium">
          {root === chatId ? "This chat is locked" : `Locked with “${rootChat?.title ?? "its parent chat"}”`}
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={perChat ? "This chat's password" : "App password"}
          aria-label="Password"
          className={INPUT}
        />
        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
        <button type="submit" disabled={!password || busy} className={`flex items-center gap-1.5 rounded px-4 py-1.5 text-xs ${PRIMARY_ACTION}`}>
          {busy && <Loader2 size={13} className="animate-spin" />}
          Unlock
        </button>
        <p className="text-xs text-[var(--color-text-muted)]">
          {perChat && appPasswordSet
            ? "Forgot it? The app password opens this chat too."
            : "A forgotten password can't be recovered here; the chat can still be deleted."}
          {" "}It locks again when you lock it, after a while without use, or when the app restarts.
        </p>
      </form>
    </div>
  );
}

/** "Lock chat…": the app password (creating it the first time) or its own. */
export function LockDialog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const appPasswordSet = useChatLocks((s) => s.appPasswordSet);
  const refreshChats = useApp((s) => s.refreshChats);
  const [mode, setMode] = useState<"app" | "chat">("app");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Typing a password is only needed when one is being made.
  const making = mode === "chat" || !appPasswordSet;
  const ready = !making || (password.length > 0 && password === confirm);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "app" && !appPasswordSet) {
        await api.setAppLockPassword(null, password);
        useChatLocks.setState({ appPasswordSet: true });
      }
      await api.lockChat(chatId, mode === "chat" ? password : undefined);
      await closeLock(chatId);
      await refreshChats();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const choice = (value: "app" | "chat", label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="radio" name="lock-mode" checked={mode === value} onChange={() => setMode(value)} />
      {label}
    </label>
  );

  return (
    <Modal onClose={onClose} header={<ModalTitle>Lock chat</ModalTitle>} size="dialog" className="w-[420px]">
      <form onSubmit={submit}>
        <div className="flex flex-col gap-3 px-5 py-4">
          {choice("app", appPasswordSet ? "Use the app password" : "Create an app password for all locked chats")}
          {choice("chat", "Give this chat its own password")}
          {making && (
            <>
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "app" ? "New app password" : "Password for this chat"} aria-label="Password" className={INPUT} />
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                placeholder="Type it again" aria-label="Confirm password" className={INPUT} />
              {confirm.length > 0 && confirm !== password && (
                <div className="text-xs text-[var(--color-danger)]">The two don't match.</div>
              )}
            </>
          )}
          <p className="text-xs text-[var(--color-text-muted)]">
            {NOT_ENCRYPTION} Its title stays visible in the sidebar, so rename it if that says too much.
            {mode === "chat"
              ? " Forget this password and only the app password, if you set one, can open it."
              : " Forget the app password and it can't be recovered; the chats can still be deleted."}
          </p>
          {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
          <button type="button" onClick={onClose} className={SECONDARY}>Cancel</button>
          <button type="submit" disabled={!ready || busy} className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />}
            Lock
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** "Remove lock…": the password again, not just an open session. */
export function RemoveLockDialog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const refreshChats = useApp((s) => s.refreshChats);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await api.removeChatLock(chatId, password)) {
        setUnlocked(chatId, false);
        await refreshChats();
        onClose();
      } else setError("Wrong password.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} header={<ModalTitle>Remove lock</ModalTitle>} size="dialog" className="w-[380px]">
      <form onSubmit={submit}>
        <div className="flex flex-col gap-3 px-5 py-4">
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Its password, or the app password" aria-label="Password" className={INPUT} />
          {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
          <button type="button" onClick={onClose} className={SECONDARY}>Cancel</button>
          <button type="submit" disabled={!password || busy} className={`rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}>
            Remove lock
          </button>
        </div>
      </form>
    </Modal>
  );
}
