/**
 * Whether this window is the app or a remote for it (0.17.2).
 *
 * Three states, and keeping them apart is what stops the UI lying:
 *
 * - **The desktop.** No session, and a local backend behind `invoke`. Nothing
 *   below applies.
 * - **A remote with a session.** Everything works, until the machine at home
 *   goes to sleep — and then it must say so rather than spin.
 * - **A remote with no session**, which is a phone that has not been paired
 *   and can do exactly one thing.
 */

import { useEffect, useState } from "react";
import {
  connection,
  currentSession,
  isRemote,
  onConnectionChange,
  type ConnectionState,
  type RemoteSession,
} from "./transport";

/**
 * True when this build can *only* be a remote — a phone or tablet, where there
 * is no local backend to fall back to.
 *
 * User-agent sniffing, rather than a platform plugin, because the question is
 * not really "what OS is this" — it is "is there a desktop behind this window",
 * and on every current build those coincide. The `?remote=1` escape hatch is
 * how this gets developed: a desktop browser pointed at a real instance is the
 * design's own suggested way to test the transport, and it needs to see the
 * pairing screen to get one.
 */
export function isRemoteShell(): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("remote")) {
    return true;
  }
  try {
    if (localStorage.getItem("multizone.forceRemote") === "1") return true;
  } catch {}
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export interface RemoteState {
  /** The desktop this window is a remote for, or null. */
  session: RemoteSession | null;
  /** True when there is no local backend behind this window. */
  shell: boolean;
  /** A phone that has not been paired: the pairing screen, and nothing else. */
  needsPairing: boolean;
  connection: ConnectionState;
}

export function useRemote(): RemoteState {
  const [session, setSessionState] = useState<RemoteSession | null>(() => currentSession());
  const [state, setState] = useState<ConnectionState>(() => connection());
  const shell = isRemoteShell();

  useEffect(() => {
    // The connection callback also fires when the session is replaced, which is
    // the moment the pairing screen needs to go away.
    return onConnectionChange((next) => {
      setState(next);
      setSessionState(currentSession());
    });
  }, []);

  return {
    session,
    shell,
    needsPairing: shell && !isRemote() && session === null,
    connection: state,
  };
}
