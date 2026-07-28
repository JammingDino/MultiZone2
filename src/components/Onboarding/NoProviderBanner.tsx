import { useState } from "react";
import { AlertTriangle, FileUp, Server, X } from "lucide-react";
import { useApp } from "@/store/app";
import { pickBundleFile } from "@/lib/importSettings";

/**
 * Standing notice for an install with no provider configured (1.0).
 *
 * Skipping first-run setup is allowed, but the resulting state — an app that
 * looks fine and silently can't answer anything — needs to explain itself.
 * This offers the two ways out, and is dismissible per session so it doesn't
 * nag someone who is deliberately just looking around.
 */
export function NoProviderBanner() {
  const setAppSettings = useApp((s) => s.setAppSettings);
  const stageImport = useApp((s) => s.stageImport);
  const openSettings = useApp((s) => s.openSettings);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (hidden) return null;

  async function onImport() {
    setError(null);
    try {
      const picked = await pickBundleFile();
      if (picked) stageImport(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex items-start gap-2.5 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs">
      <AlertTriangle size={15} className="mt-px shrink-0 text-amber-500" />
      <div className="flex-1">
        <div className="font-medium">No model connected</div>
        <div className="mt-0.5 text-[var(--color-text-muted)]">
          {error ?? "Messages won't send until you connect a provider or import settings from another install."}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            onClick={() => {
              // Clearing the flag brings the full setup screen back.
              void setAppSettings({ onboardingSkipped: false });
            }}
            className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-2.5 py-1 text-white hover:opacity-90"
          >
            <Server size={12} />
            Connect a provider
          </button>
          <button
            onClick={onImport}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1 hover:border-[var(--color-accent)]"
          >
            <FileUp size={12} />
            Import settings…
          </button>
          <button
            onClick={openSettings}
            className="rounded border border-[var(--color-border)] px-2.5 py-1 hover:border-[var(--color-accent)]"
          >
            Open settings
          </button>
        </div>
      </div>
      <button
        onClick={() => setHidden(true)}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
      >
        <X size={13} />
      </button>
    </div>
  );
}
