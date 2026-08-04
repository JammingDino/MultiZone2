// Auto-update against GitHub Releases (1.0).
//
// The release workflow publishes MSI + NSIS bundles and, with
// `createUpdaterArtifacts` on, a signed `latest.json` manifest beside them. The
// updater plugin reads that manifest from the repo's *latest* release, compares
// its version to the running one, and verifies the bundle's signature against
// the public key baked into `tauri.conf.json` before anything is written to
// disk. An unsigned or tampered artifact fails the check rather than installing.
//
// Kept as a hook (not a store slice) because update state is entirely local to
// whatever is displaying it and never needs to survive a remount.

import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "none"
  | "downloading"
  | "ready"
  | "error";

export interface UpdaterState {
  stage: UpdateStage;
  /** Version offered by the manifest, once known. */
  version: string | null;
  /** Release notes from the manifest, if the release body carried any. */
  notes: string | null;
  /** 0–100 while downloading, null when the server sends no content-length. */
  progress: number | null;
  error: string | null;
}

const INITIAL: UpdaterState = {
  stage: "idle",
  version: null,
  notes: null,
  progress: null,
  error: null,
};

export function useUpdater() {
  const [state, setState] = useState<UpdaterState>(INITIAL);
  // The resolved `Update` handle has to survive between the check and the
  // install; it is not serializable, so it lives in a ref rather than state.
  const updateRef = useRef<Update | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = useCallback((patch: Partial<UpdaterState>) => {
    if (mounted.current) setState((s) => ({ ...s, ...patch }));
  }, []);

  /**
   * Ask the manifest whether a newer version exists.
   *
   * `silent` suppresses the error state: a startup check that fails because the
   * machine is offline, or behind a proxy that blocks GitHub, is not something
   * to interrupt the user about — they never asked. A check they clicked does
   * report its failure, because silence there reads as a broken button.
   */
  const checkForUpdate = useCallback(
    async (silent = false) => {
      if (!silent) set({ stage: "checking", error: null });
      try {
        const update = await check();
        updateRef.current = update;
        if (update) {
          set({
            stage: "available",
            version: update.version,
            notes: update.body ?? null,
            error: null,
          });
        } else if (!silent) {
          set({ stage: "none", version: null, notes: null, error: null });
        }
      } catch (e) {
        if (silent) return;
        set({ stage: "error", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [set],
  );

  /** Download the offered bundle and install it, reporting progress as it goes. */
  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    set({ stage: "downloading", progress: null, error: null });
    try {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            received = 0;
            set({ progress: total > 0 ? 0 : null });
            break;
          case "Progress":
            received += event.data.chunkLength;
            if (total > 0) {
              set({ progress: Math.min(100, Math.round((received / total) * 100)) });
            }
            break;
          case "Finished":
            set({ progress: 100 });
            break;
        }
      });
      set({ stage: "ready" });
    } catch (e) {
      set({ stage: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, [set]);

  /**
   * Restart into the installed version. Deliberately never automatic — the app
   * holds unsent composer text and in-flight turns, and pulling the process out
   * from under a running agent to save the user one click is a bad trade.
   */
  const restart = useCallback(async () => {
    try {
      await relaunch();
    } catch (e) {
      set({ stage: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, [set]);

  return { ...state, checkForUpdate, downloadAndInstall, restart };
}
