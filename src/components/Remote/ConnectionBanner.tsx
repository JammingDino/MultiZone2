/**
 * "The desktop is asleep", said out loud (0.17.2).
 *
 * This is the honest failure mode of a remote client and it belongs in the UI
 * as a stated reason rather than a spinner. A phone whose desktop has gone to
 * sleep looks exactly like a phone whose app has hung — same empty list, same
 * unresponsive send button — and the difference is entirely in whether anyone
 * says which it is.
 *
 * Deliberately not offering to work offline: there is no local copy to serve
 * from, by design. What it offers instead is the truth and a retry.
 */

import { CloudOff, Loader2, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { currentSession, signOut } from "@/lib/remote/transport";
import type { ConnectionState } from "@/lib/remote/transport";

export function ConnectionBanner({ state }: { state: ConnectionState }) {
  const session = currentSession();

  // A moment's grace before crying wolf. The stream drops on every Wi-Fi
  // handover and reconnects in under a second, and a banner that flashes on
  // each one trains people to ignore it.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (state === "live") {
      setSettled(false);
      return;
    }
    const id = setTimeout(() => setSettled(true), 2500);
    return () => clearTimeout(id);
  }, [state]);

  if (state === "live" || !settled || !session) return null;

  const asleep = state === "offline";

  return (
    <div
      className={`flex items-center gap-2.5 px-3.5 py-2.5 text-sm ${
        asleep
          ? "bg-[var(--color-danger)]/10 text-[var(--color-text)]"
          : "bg-[var(--color-accent)]/10 text-[var(--color-text)]"
      }`}
    >
      {asleep ? (
        <CloudOff size={15} className="shrink-0 text-[var(--color-danger)]" />
      ) : (
        <Loader2 size={15} className="shrink-0 animate-spin text-[var(--color-accent)]" />
      )}
      <div className="min-w-0 flex-1">
        {asleep ? (
          <>
            <div>Can't reach your computer.</div>
            <div className="text-xs text-[var(--color-text-muted)]">
              It may be asleep or on a different network. Nothing is stored on this device, so
              there is nothing to show until it is back.
            </div>
          </>
        ) : (
          <div>Reconnecting…</div>
        )}
      </div>
      {asleep && (
        <button
          onClick={() => signOut()}
          className="shrink-0 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs"
        >
          Use another computer
        </button>
      )}
    </div>
  );
}

/** The "connected to <machine>" line, for a settings screen on the phone. */
export function ConnectedTo() {
  const session = currentSession();
  if (!session) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
      <Wifi size={12} /> Connected to <span className="font-mono">{session.baseUrl}</span> as{" "}
      {session.deviceName}
    </div>
  );
}
