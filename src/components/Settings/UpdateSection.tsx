import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Download, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { useUpdater } from "@/lib/useUpdater";
import { Markdown } from "@/components/Renderers/Markdown";

/**
 * Update control for Settings → Data.
 *
 * Checks once on mount (silently — see `useUpdater`), so opening the section is
 * enough to learn an update exists without pressing anything.
 */
export function UpdateSection() {
  const u = useUpdater();
  const [currentVersion, setCurrentVersion] = useState("");

  useEffect(() => {
    void u.checkForUpdate(true);
    // Read from the running binary rather than package.json, so a dev build and
    // a shipped one can't disagree about what is installed.
    getVersion().then(setCurrentVersion).catch(() => setCurrentVersion(""));
    // Mount-only: a re-check on every render would hammer GitHub.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = u.stage === "checking" || u.stage === "downloading";

  return (
    <section>
      <h3 className="mb-3 text-sm font-medium">
        Updates
        {currentVersion && (
          <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">
            {currentVersion}
          </span>
        )}
      </h3>

      <div className="flex flex-col gap-3 rounded border border-[var(--color-border)] px-3 py-3">
        {u.stage === "available" && (
          <div className="flex items-start gap-2 text-xs">
            <Download size={14} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
            <div className="min-w-0">
              <div className="font-medium text-[var(--color-text)]">
                Version {u.version} is available
              </div>
              {/* Release bodies are written in Markdown on GitHub, so they are
                  rendered as Markdown here — headings and lists, not a wall of
                  literal `##` and `-`. */}
              {u.notes && (
                <div className="mt-1.5 max-h-40 overflow-auto rounded border border-[var(--color-border)] px-2.5 py-2">
                  <Markdown source={u.notes} fontSize="12px" />
                </div>
              )}
            </div>
          </div>
        )}

        {u.stage === "downloading" && (
          <div className="text-xs text-[var(--color-text-muted)]">
            Downloading {u.version}
            {u.progress != null ? ` — ${u.progress}%` : "…"}
            {u.progress != null && (
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-[var(--color-border)]">
                <div
                  className="h-full bg-[var(--color-accent)] transition-[width] duration-200"
                  style={{ width: `${u.progress}%` }}
                />
              </div>
            )}
          </div>
        )}

        {u.stage === "ready" && (
          <div className="flex items-start gap-2 text-xs">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-500" />
            <span className="text-[var(--color-text)]">
              Version {u.version} is installed. Restart to finish — any unsent message or running
              turn is lost on restart, so finish what you are doing first.
            </span>
          </div>
        )}

        {u.stage === "none" && (
          <div className="text-xs text-[var(--color-text-muted)]">
            You are on the latest version.
          </div>
        )}

        {u.stage === "error" && (
          <div className="flex items-start gap-2 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
            <span className="text-[var(--color-text-muted)]">
              Could not check for updates: {u.error}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2">
          {u.stage === "ready" ? (
            <button
              onClick={() => void u.restart()}
              className="rounded border border-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/10"
            >
              Restart now
            </button>
          ) : u.stage === "available" ? (
            <button
              onClick={() => void u.downloadAndInstall()}
              disabled={busy}
              className="rounded border border-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/10 disabled:opacity-50"
            >
              Download &amp; install
            </button>
          ) : null}

          <button
            onClick={() => void u.checkForUpdate(false)}
            disabled={busy}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1 text-xs transition-colors hover:border-[var(--color-accent)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={u.stage === "checking" ? "animate-spin" : ""} />
            {u.stage === "checking" ? "Checking…" : "Check for updates"}
          </button>
        </div>
      </div>
    </section>
  );
}
