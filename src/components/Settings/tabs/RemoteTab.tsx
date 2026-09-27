import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { RemoteAccess } from "@/components/Settings/RemoteAccess";
import { ErrorNote } from "@/components/common/ErrorNote";

/**
 * Its own tab as of 0.17.3.
 *
 * It shipped as a section inside the API panel because that is where it was
 * built — same socket, same `apply`. That is not where anyone looks for it.
 * Somebody connecting a phone is not thinking about REST endpoints, and burying
 * the feature under a developer heading made it findable only by people who did
 * not need it.
 *
 * It still drives the same `apply`, because the LAN bind and the API server are
 * one restart. The tab is a place to stand, not a second mechanism.
 */
export function RemoteTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: {
    apiEnabled?: boolean;
    apiLan?: boolean;
    apiBindAddress?: string;
    apiDiscovery?: boolean;
  }) {
    const merged = { ...appSettings, ...next };
    setBusy(true);
    setError(null);
    try {
      // Turning on remote access turns on the server it needs. The alternative
      // is an error telling somebody to go and flip a switch on another tab,
      // which is the app refusing to do the obvious thing.
      if (merged.apiLan) merged.apiEnabled = true;
      if (merged.apiEnabled && !merged.apiToken) {
        merged.apiToken = await api.generateApiToken();
      }
      await api.applyApiSettings(
        merged.apiEnabled,
        merged.apiPort,
        merged.apiToken,
        merged.apiLan,
        merged.apiBindAddress,
        merged.apiDiscovery,
      );
      await setAppSettings({
        apiEnabled: merged.apiEnabled,
        apiPort: merged.apiPort,
        apiToken: merged.apiToken,
        apiLan: merged.apiLan,
        apiBindAddress: merged.apiBindAddress,
        apiDiscovery: merged.apiDiscovery,
      });
    } catch (e: any) {
      setError(e?.message || String(e));
      // A refused bind must not leave the switch reading "on the network".
      if (next.apiLan) await setAppSettings({ apiLan: false });
      if (next.apiEnabled) await setAppSettings({ apiEnabled: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="flex items-start gap-2 rounded border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/5 px-2.5 py-2 text-xs">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <ErrorNote error={error} className="min-w-0" />
        </div>
      )}
      <RemoteAccess apply={apply} busy={busy} />
    </div>
  );
}

// ─── Data ─────────────────────────────────────────────────────────────────────
