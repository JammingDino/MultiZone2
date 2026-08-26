import { useState } from "react";
import { AlertTriangle, FileUp, Server, X } from "lucide-react";
import { useApp } from "@/store/app";
import { pickBundleFile } from "@/lib/importSettings";
import { CHROME_QUIET, PRIMARY_ACTION } from "@/lib/chrome";
import { FREE_TIER_PRESETS } from "@/lib/providerPresets";

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
          {error ??
            "Messages won't send until you connect a provider or import settings from another install."}
        </div>
        {/* Named here too, because the banner is what someone who skipped setup
            actually reads — and "connect a provider" is only actionable if you
            already know one you can use for nothing. */}
        {!error && (
          <div className="mt-0.5 text-[var(--color-text-muted)]">
            {FREE_TIER_PRESETS.length > 0 && (
              <>
                No key? {FREE_TIER_PRESETS.slice(0, 3).map((p) => p.name).join(", ")} and{" "}
                {FREE_TIER_PRESETS.length - 3} more are free to start, and setup lists them.
              </>
            )}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            onClick={() => {
              // Clearing the flag brings the full setup screen back.
              void setAppSettings({ onboardingSkipped: false });
            }}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 ${PRIMARY_ACTION}`}
          >
            <Server size={12} />
            Connect a provider
          </button>
          <button
            onClick={onImport}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <FileUp size={12} />
            Import settings…
          </button>
          <button
            onClick={openSettings}
            className="rounded border border-[var(--color-border)] px-2.5 py-1 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Open settings
          </button>
        </div>
      </div>
      <button
        onClick={() => setHidden(true)}
        aria-label="Dismiss"
        className={`shrink-0 rounded p-1 ${CHROME_QUIET}`}
      >
        <X size={13} />
      </button>
    </div>
  );
}
