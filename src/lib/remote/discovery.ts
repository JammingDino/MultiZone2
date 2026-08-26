/**
 * Finding a computer, from the phone's side (0.17.4).
 *
 * The desktop advertises itself over mDNS, and this does not listen for it —
 * see `src-tauri/src/mobile.rs` for the argument, which is short: receiving
 * multicast on Android needs a `MulticastLock`, and consumer Wi-Fi blocks
 * client-to-client multicast often enough that it is the least dependable
 * mechanism on exactly the networks people want to use. The shell sweeps the
 * phone's own /24 for the unauthenticated health check instead, which works
 * wherever plain TCP does — the same condition the app itself needs.
 *
 * The one Tauri command the mobile build registers, so this is also the only
 * place in the frontend that calls `invoke` without going through the remote
 * transport. It has to: the question is about *this* device's network position,
 * and there is no desktop yet to ask.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export interface FoundDesktop {
  /** `http://192.168.1.5:8765` — handed to the transport verbatim. */
  baseUrl: string;
  address: string;
  port: number;
  version: string | null;
  /** The desktop is armed and waiting for a device right now. Almost certainly
   *  the machine the person is standing in front of, so it sorts first. */
  waiting: boolean;
}

/**
 * Look for MultiZone desktops on this network.
 *
 * Resolves to an empty list rather than throwing when discovery is not
 * available — in a desktop browser, or on any build with no shell behind it.
 * Every caller has a manual address field next to it, and a thrown error there
 * would be an error message about a feature the user did not ask for.
 */
export async function discoverDesktops(port?: number): Promise<FoundDesktop[]> {
  try {
    return await tauriInvoke<FoundDesktop[]>("discover_desktops", { port: port ?? null });
  } catch (e) {
    console.warn("discovery unavailable", e);
    return [];
  }
}
