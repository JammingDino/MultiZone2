import { useEffect, useState } from "react";
import { X, RefreshCw, AlertTriangle, Loader2, Copy, Check } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { Toggle } from "@/components/common/Toggle";
import type { ApiBindState } from "@/lib/types";
import { errorText } from "@/lib/errors";
import { reportError } from "@/lib/reportError";

export function ApiTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);

  const [portInput, setPortInput] = useState(String(appSettings.apiPort ?? 8765));
  const [status, setStatus] = useState<string | null>(null);
  // The last bind outcome, persisted rather than reported once and forgotten
  // (0.11.0). A port already in use used to leave this toggle reading "on" with
  // no server behind it and nothing anywhere that said so.
  const [bind, setBind] = useState<ApiBindState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refreshBind = () => api.apiBindState().then(setBind).catch(reportError("Couldn't read the API server state"));
  useEffect(() => { void refreshBind(); }, []);

  // The address it is *actually* bound to, not the one it used to always be.
  // Falling back to loopback matches what an un-bound server would be if it
  // came up, and never overstates reach.
  const baseUrl = `http://${bind?.address || "127.0.0.1"}:${appSettings.apiPort ?? 8765}`;
  const parsedPort = parseInt(portInput, 10);
  const portInvalid = !Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535;

  // Push the current config to the backend, persist it, and reflect any error.
  //
  // The LAN bind and its address go through here too (0.17.0) rather than
  // through a second command: all of them decide which socket is open, and a
  // panel that could change the bind without restarting the server would be
  // describing a server that does not exist. Settings are persisted only after
  // the restart succeeds, so a refused bind does not leave the panel claiming a
  // configuration the server is not running.
  async function apply(next: {
    apiEnabled?: boolean;
    apiPort?: number;
    apiToken?: string;
    apiLan?: boolean;
    apiBindAddress?: string;
    apiDiscovery?: boolean;
  }) {
    const merged = { ...appSettings, ...next };
    setBusy(true);
    setStatus(null);
    try {
      // Ensure a token exists before enabling. Still generated even in the
      // LAN case: pairing mints per-device tokens, but the static one is what
      // a script on this machine uses and the server refuses to start without.
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
      setStatus(merged.apiEnabled ? "Running." : "Stopped.");
      await refreshBind();
    } catch (e: any) {
      setStatus(errorText(e));
      // Roll the toggle back if start failed. Same for the LAN bind: a refused
      // bind that left the switch reading "on the network" would be the exact
      // dishonesty the persisted bind outcome was added to end.
      if (next.apiEnabled) await setAppSettings({ apiEnabled: false });
      if (next.apiLan) await setAppSettings({ apiLan: false });
      await refreshBind();
    } finally {
      setBusy(false);
    }
  }

  async function regenerateToken() {
    const token = await api.generateApiToken();
    await apply({ apiToken: token });
  }

  function commitPort() {
    const p = parseInt(portInput, 10);
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      setPortInput(String(appSettings.apiPort ?? 8765));
      return;
    }
    if (p !== appSettings.apiPort) apply({ apiPort: p });
  }

  async function copyToken() {
    if (!appSettings.apiToken) return;
    try {
      await navigator.clipboard.writeText(appSettings.apiToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // A copy that silently failed leaves the old clipboard to be pasted.
      reportError("Couldn't copy to the clipboard")(e);
    }
  }

  const curlExample = `curl -N -X POST ${baseUrl}/api/chats/CHAT_ID/messages \\\n  -H "Authorization: Bearer ${appSettings.apiToken || "YOUR_TOKEN"}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text":"Hello"}'`;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Local HTTP API</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          A REST + SSE API with the same capabilities as the app — chats, zones, projects,
          messages. It listens on 127.0.0.1 only, until you switch on remote access below. Every
          request needs a token.
        </p>
        <div
          onClick={() => !busy && apply({ apiEnabled: !appSettings.apiEnabled })}
          className="flex cursor-pointer items-center justify-between rounded border border-[var(--color-border)] px-3 py-2.5 hover:border-[var(--color-accent)]"
        >
          <span className="text-sm">Enable API server</span>
          <Toggle checked={appSettings.apiEnabled} onChange={(v) => apply({ apiEnabled: v })} />
        </div>
        {status && (
          <div className="mt-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            {busy && <Loader2 size={12} className="animate-spin" />}
            {status}
          </div>
        )}
        {/* The bind outcome as it stands, including from a previous launch —
            "enabled" and "actually listening" are different facts and only one
            of them used to be visible. */}
        {appSettings.apiEnabled && bind && !bind.ok && (
          <div className="mt-2 flex items-start gap-2 rounded border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/5 px-2.5 py-2 text-xs">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
            <span>
              The server is switched on but is not listening on {bind.address}:{bind.port}
              {bind.error ? <>: <span className="font-mono">{bind.error}</span></> : "."}
            </span>
          </div>
        )}
        {appSettings.apiEnabled && bind?.ok && (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Listening on <span className="font-mono">{bind.address}:{bind.port}</span>. Ask it
            about itself:{" "}
            <span className="font-mono">GET {baseUrl}/api/health</span> and{" "}
            <span className="font-mono">/api/routes</span> — both answer without a token.
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Port</h3>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">Base URL: <span className="font-mono">{baseUrl}</span></p>
        <input
          value={portInput}
          onChange={(e) => setPortInput(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => { if (e.key === "Enter") commitPort(); }}
          inputMode="numeric"
          className={`w-40 rounded border bg-[var(--color-panel)] px-2.5 py-1.5 text-sm outline-none ${
            portInvalid ? "border-[var(--color-danger)]" : "border-[var(--color-border)] focus:border-[var(--color-accent)]"
          }`}
          placeholder="8765"
        />
        {portInvalid && (
          <p className="mt-1 text-[11px] text-[var(--color-danger)]">Enter a port between 1 and 65535.</p>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Bearer token</h3>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">
          Send as <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>. Keep it secret.
        </p>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={appSettings.apiToken || "— none generated —"}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-xs outline-none"
          />
          <button
            onClick={copyToken}
            disabled={!appSettings.apiToken}
            className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={regenerateToken}
            disabled={busy}
            className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Regenerate
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Example</h3>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">
{curlExample}
        </pre>
        <p className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
          Append <span className="font-mono">?wait=true</span> to get the final message as JSON instead of an SSE stream.
        </p>
      </section>
    </div>
  );
}

// ─── Phone & remote ───────────────────────────────────────────────────────────
