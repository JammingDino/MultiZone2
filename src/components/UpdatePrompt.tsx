import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { AlertTriangle, CheckCircle2, Download, Sparkles } from "lucide-react";
import { Modal, ModalTitle } from "@/components/common/Modal";
import { Markdown } from "@/components/Renderers/Markdown";
import { useUpdater } from "@/lib/useUpdater";

/**
 * Version the user pressed "Skip this version" on. Machine-local UI state — it
 * says nothing about the install and shouldn't travel in a settings export —
 * so it lives in localStorage next to the sidebar's open state rather than in
 * the persisted app settings.
 */
const SKIPPED_KEY = "mz.updateSkippedVersion";

function readSkipped(): string | null {
  try {
    return localStorage.getItem(SKIPPED_KEY);
  } catch {
    return null;
  }
}

function writeSkipped(version: string) {
  try {
    localStorage.setItem(SKIPPED_KEY, version);
  } catch {
    /* private mode / storage disabled — the prompt just returns next launch */
  }
}

/**
 * Launch-time update prompt.
 *
 * The check runs once, shortly after the window settles, and stays silent
 * unless it finds something: a machine that is offline, or behind a proxy that
 * blocks GitHub, gets no dialog and no error — the user never asked for one
 * (see `useUpdater`'s `silent` flag). When an update *is* found, this is the
 * one interruption the app makes, so it carries the release notes rather than a
 * bare version number, and offers a way to say "not this one" that sticks.
 *
 * Settings → Data keeps its own control for checking on demand; the two are
 * independent instances of the hook and don't coordinate. That's deliberate —
 * downloading from one place and then opening the other mid-download is not a
 * flow worth the shared state it would cost.
 */
export function UpdatePrompt() {
  const u = useUpdater();
  const [currentVersion, setCurrentVersion] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    getVersion().then(setCurrentVersion).catch(() => setCurrentVersion(""));
    // Let the first frames land before reaching for the network: the boot
    // splash is still covering the window at mount, and an update found half a
    // second earlier changes nothing for anybody.
    const t = window.setTimeout(() => void u.checkForUpdate(true), 2500);
    return () => window.clearTimeout(t);
    // Mount-only — this is the launch check, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing found, or the user has already waved this exact version away.
  const offered = u.version;
  if (dismissed) return null;
  if (u.stage === "idle" || u.stage === "checking" || u.stage === "none") return null;
  if (u.stage === "available" && offered && readSkipped() === offered) return null;
  // A failure here was never asked for, so it is not worth a modal. The only
  // errors that reach this point are ones from a download the user did start.
  if (u.stage === "error" && !u.error) return null;

  const downloading = u.stage === "downloading";
  // Pulling the modal out from under a running download would leave the install
  // finishing with nothing on screen to say so.
  const close = downloading ? () => {} : () => setDismissed(true);

  return (
    <Modal
      onClose={close}
      size="dialog"
      className="w-[560px]"
      header={
        <>
          <Sparkles size={16} className="shrink-0 text-[var(--color-accent)]" />
          <ModalTitle>
            {u.stage === "ready" ? "Update installed" : "Update available"}
          </ModalTitle>
        </>
      }
    >
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
        <div className="text-sm">
          {u.stage === "ready" ? (
            <span className="flex items-start gap-2">
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-500" />
              <span>
                MultiZone {u.version} is installed. Restart to finish — any unsent message or
                running turn is lost on restart, so finish what you are doing first.
              </span>
            </span>
          ) : u.stage === "error" ? (
            <span className="flex items-start gap-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <span className="text-[var(--color-text-muted)]">{u.error}</span>
            </span>
          ) : (
            <span>
              <span className="font-medium">MultiZone {u.version}</span> is available
              {currentVersion && (
                <span className="text-[var(--color-text-muted)]"> — you have {currentVersion}</span>
              )}
              .
            </span>
          )}
        </div>

        {u.notes && u.stage !== "error" && (
          <div className="min-h-0 max-h-[46vh] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-4 py-3">
            <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              What's new
            </div>
            <Markdown source={u.notes} fontSize="13px" />
          </div>
        )}

        {downloading && (
          <div className="text-xs text-[var(--color-text-muted)]">
            Downloading {u.version}
            {u.progress != null ? ` — ${u.progress}%` : "…"}
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-[var(--color-border)]">
              {u.progress != null ? (
                <div
                  className="h-full bg-[var(--color-accent)] transition-[width] duration-200"
                  style={{ width: `${u.progress}%` }}
                />
              ) : (
                // No content-length from the server — there is no percentage to
                // show, so the bar says "moving" rather than inventing one.
                <div className="mz-indeterminate h-full w-1/3 rounded bg-[var(--color-accent)]" />
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
        {u.stage === "available" && (
          <>
            <button
              onClick={() => {
                if (offered) writeSkipped(offered);
                setDismissed(true);
              }}
              className="rounded-lg px-3 py-1.5 text-[12.5px] text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            >
              Skip this version
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] font-medium transition hover:bg-[var(--color-panel-hover)]"
            >
              Later
            </button>
            <button
              onClick={() => void u.downloadAndInstall()}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition hover:brightness-110"
            >
              <Download size={14} /> Download &amp; install
            </button>
          </>
        )}

        {downloading && (
          <span className="text-[12.5px] text-[var(--color-text-muted)]">
            Installing — this window closes on restart.
          </span>
        )}

        {u.stage === "ready" && (
          <>
            <button
              onClick={() => setDismissed(true)}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] font-medium transition hover:bg-[var(--color-panel-hover)]"
            >
              Restart later
            </button>
            <button
              onClick={() => void u.restart()}
              className="rounded-lg bg-[var(--color-accent)] px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition hover:brightness-110"
            >
              Restart now
            </button>
          </>
        )}

        {u.stage === "error" && (
          <button
            onClick={() => setDismissed(true)}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] font-medium transition hover:bg-[var(--color-panel-hover)]"
          >
            Close
          </button>
        )}
      </div>
    </Modal>
  );
}
