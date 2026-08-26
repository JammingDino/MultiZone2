/**
 * Settings → API → Remote access (0.17.0).
 *
 * Three sections, in the order somebody actually does them: put the app on the
 * network, pair a device, then manage the devices that are paired.
 *
 * The tone of this panel is the point. A LAN bind is a genuinely different
 * security posture from a socket only this machine can open, so the switch says
 * so in words rather than implying it with an icon — and the address it is
 * bound to is always on screen, because "which network am I on" is the question
 * the honest version of this feature has to keep answering.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Radio,
  RefreshCw,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { Toggle, ToggleRow } from "@/components/common/Toggle";
import type { PairedDevice, PairingView, RemoteStatus } from "@/lib/types";

/** How the applying half of the API tab hands control down. */
export interface RemoteAccessProps {
  /** Restart the server with these settings merged in. Owned by the API tab,
   *  because the LAN bind and the port are the same restart. */
  apply: (next: {
    apiEnabled?: boolean;
    apiLan?: boolean;
    apiBindAddress?: string;
    apiDiscovery?: boolean;
  }) => Promise<void>;
  busy: boolean;
}

export function RemoteAccess({ apply, busy }: RemoteAccessProps) {
  const appSettings = useApp((s) => s.appSettings);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pairing, setPairing] = useState<PairingView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, d, p] = await Promise.all([
        api.remoteStatus(),
        api.listPairedDevices(),
        api.pairingStatus(),
      ]);
      setStatus(s);
      setDevices(d);
      setPairing(p);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A device pairing is the one event this panel cannot poll its way to
  // gracefully: the user is looking at a code, and the moment it is used is the
  // moment the dialog should stop showing it.
  useEffect(() => {
    const un = api.onDevicesChanged(() => void refresh());
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  const lanOn = appSettings.apiLan;
  const canGoLan = status?.lanAvailable ?? false;

  return (
    <>
      <section>
        <h3 className="mb-1 text-sm font-medium">Remote access</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Let a phone, tablet or second computer on this network drive this app. Everything still
          runs here — its models, its files, its tools. Nothing runs on the other device and nothing
          is stored there.
        </p>

        <ToggleRow
          label="Reachable from this network"
          description={
            canGoLan
              ? "The app listens on a network address instead of only this machine."
              : "This machine has no network address right now, so nothing could reach it."
          }
          checked={lanOn}
          onChange={(v) => {
            if (!canGoLan && v) return;
            setError(null);
            void apply({ apiLan: v, apiEnabled: v ? true : undefined }).then(refresh);
          }}
        />

        {/* Said plainly rather than implied. Someone switching this on has
            changed who can knock on the door, and that deserves a sentence. */}
        {lanOn && (
          <div className="mt-2 flex items-start gap-2 rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 px-2.5 py-2 text-xs">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
            <span>
              MultiZone is on your network. Anything that can reach{" "}
              <span className="font-mono">{status?.baseUrl ?? "this machine"}</span> and holds a
              paired token can read your chats and run your tools. Pair only devices you own, and
              revoke ones you no longer carry.
            </span>
          </div>
        )}

        {lanOn && status && !status.bound && (
          <div className="mt-2 flex items-start gap-2 rounded border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/5 px-2.5 py-2 text-xs">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
            <span>
              Switched on, but not listening
              {status.bindError ? (
                <>
                  : <span className="font-mono">{status.bindError}</span>
                </>
              ) : (
                "."
              )}
            </span>
          </div>
        )}

        {lanOn && status && status.interfaces.length > 1 && (
          <div className="mt-3">
            <label className="mb-1 block text-xs text-[var(--color-text-muted)]">
              Which network
            </label>
            <select
              value={appSettings.apiBindAddress || ""}
              onChange={(e) => {
                setError(null);
                void apply({ apiBindAddress: e.target.value }).then(refresh);
              }}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Pick automatically</option>
              {status.interfaces
                .filter((i) => !i.loopback)
                .map((i) => (
                  <option key={i.address} value={i.address}>
                    {i.name} — {i.address}
                    {i.private ? "" : " (public — reachable from the internet)"}
                  </option>
                ))}
            </select>
          </div>
        )}

        {lanOn && (
          <div className="mt-3">
            <ToggleRow
              label="Announce on the network"
              description="mDNS, so a device can find this machine without being told its address."
              checked={appSettings.apiDiscovery}
              onChange={(v) => {
                setError(null);
                void apply({ apiDiscovery: v }).then(refresh);
              }}
            />
            {appSettings.apiDiscovery && status?.discoveryError && (
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                Not being announced ({status.discoveryError}). Devices can still connect using the
                address below — some networks block this.
              </p>
            )}
            {appSettings.apiDiscovery && status?.discovering && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                <Radio size={11} className="text-[var(--color-accent)]" /> Announcing as{" "}
                <span className="font-mono">_multizone._tcp</span>
              </p>
            )}
          </div>
        )}

        {status?.baseUrl && status.bound && (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            Reachable at <span className="font-mono">{status.baseUrl}</span>
          </p>
        )}
      </section>

      {error && (
        <div className="flex items-start gap-2 rounded border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/5 px-2.5 py-2 text-xs">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <span>{error}</span>
        </div>
      )}

      <PairingSection
        pairing={pairing}
        canPair={Boolean(status?.bound && status?.lan)}
        busy={busy}
        onChanged={refresh}
        onError={setError}
      />

      <DeviceList devices={devices} onChanged={refresh} onError={setError} />
    </>
  );
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

/**
 * The code, its QR, and who has tried.
 *
 * The countdown is not decoration. A code that has quietly expired while the
 * user walks to the phone is the most likely way this fails, and a number
 * ticking down is the difference between "try again" and "this is broken".
 */
function PairingSection({
  pairing,
  canPair,
  busy,
  onChanged,
  onError,
}: {
  pairing: PairingView | null;
  canPair: boolean;
  busy: boolean;
  onChanged: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const offer = pairing?.offer ?? null;
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!offer) return;
    const tick = () => setRemaining(Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(() => {
      tick();
      // The desktop is the authority on whether the window is still open, so
      // when the countdown reaches zero the panel asks rather than assuming.
      if (offer.expiresAt - Date.now() <= 0) void onChanged();
    }, 1000);
    return () => clearInterval(id);
  }, [offer, onChanged]);

  async function open() {
    onError(null);
    try {
      await api.openPairing();
      await onChanged();
    } catch (e: any) {
      onError(e?.message || String(e));
    }
  }

  async function close() {
    try {
      await api.closePairing();
      await onChanged();
    } catch (e: any) {
      onError(e?.message || String(e));
    }
  }

  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">Pair a device</h3>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        Show a code, then enter it on the device — or scan the square. The code works once and
        expires in a few minutes. The device gets its own token, so you can revoke it on its own
        later.
      </p>

      {!canPair && (
        <p className="rounded border border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-muted)]">
          Turn on remote access above first — a code no device can reach is a minute of typing for
          nothing.
        </p>
      )}

      {canPair && !offer && (
        <button
          onClick={open}
          disabled={busy}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-2 text-sm hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
        >
          <Smartphone size={14} /> Show a pairing code
        </button>
      )}

      {canPair && offer && (
        <div className="rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 p-4">
          <div className="flex flex-wrap items-start gap-5">
            <div>
              <div className="font-mono text-3xl tracking-[0.4em] text-[var(--color-accent)]">
                {offer.code}
              </div>
              <div className="mt-2 text-xs text-[var(--color-text-muted)]">
                {remaining > 0 ? (
                  <>
                    Expires in {Math.floor(remaining / 60)}:
                    {String(remaining % 60).padStart(2, "0")} · {offer.attemptsRemaining} attempt
                    {offer.attemptsRemaining === 1 ? "" : "s"} left
                  </>
                ) : (
                  <>Expired — show a new one.</>
                )}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={open}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
                >
                  <RefreshCw size={12} /> New code
                </button>
                <button
                  onClick={close}
                  className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
                >
                  <X size={12} /> Done
                </button>
              </div>
            </div>
            {pairing?.link && <PairingQr link={pairing.link} />}
          </div>
        </div>
      )}

      {pairing && pairing.attempts.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">Recent attempts</div>
          <div className="flex flex-col gap-1">
            {pairing.attempts.slice(0, 5).map((a) => (
              <div
                key={a.id}
                className="flex items-baseline justify-between gap-3 text-[11px] text-[var(--color-text-muted)]"
              >
                <span className="truncate">
                  <span className="font-mono">{a.address}</span>
                  {a.deviceName ? ` · ${a.deviceName}` : ""}
                  {a.ok ? " · paired" : a.reason ? ` · ${a.reason}` : " · refused"}
                </span>
                <span className="shrink-0">{new Date(a.createdAt).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The pairing link as a QR.
 *
 * Rendered to a canvas rather than shelling out to an image service, for the
 * reason the whole product exists: a pairing code is a credential and does not
 * leave this machine.
 */
function PairingQr({ link }: { link: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, link, { width: 148, margin: 1 }).catch(() => setFailed(true));
  }, [link]);

  if (failed) return null;
  return (
    <div className="flex flex-col items-center gap-1">
      <canvas ref={ref} className="rounded bg-white p-1" />
      <span className="text-[10px] text-[var(--color-text-muted)]">Scan to pair</span>
    </div>
  );
}

// ─── The registry ────────────────────────────────────────────────────────────

function DeviceList({
  devices,
  onChanged,
  onError,
}: {
  devices: PairedDevice[];
  onChanged: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function act(id: string, fn: () => Promise<unknown>) {
    setPendingId(id);
    onError(null);
    try {
      await fn();
      await onChanged();
    } catch (e: any) {
      onError(e?.message || String(e));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">Paired devices</h3>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        Each holds its own token. Revoking one signs out that device and nothing else.
      </p>

      {devices.length === 0 ? (
        <p className="rounded border border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-muted)]">
          No devices paired yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {devices.map((d) => {
            const revoked = d.revokedAt !== null;
            return (
              <div
                key={d.id}
                className={`flex items-center justify-between gap-3 rounded border border-[var(--color-border)] px-3 py-2 ${
                  revoked ? "opacity-55" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm">
                    <Smartphone size={13} className="shrink-0 text-[var(--color-text-muted)]" />
                    <span className="truncate">{d.name}</span>
                    {revoked && (
                      <span className="shrink-0 rounded bg-[var(--color-border)] px-1.5 py-0.5 text-[10px]">
                        revoked
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                    {d.platform}
                    {d.lastSeenAt
                      ? ` · last seen ${new Date(d.lastSeenAt).toLocaleString()}`
                      : " · never used"}
                    {d.lastSeenIp ? ` · ${d.lastSeenIp}` : ""}
                  </div>
                </div>
                <button
                  onClick={() =>
                    act(d.id, () =>
                      revoked ? api.forgetPairedDevice(d.id) : api.revokePairedDevice(d.id),
                    )
                  }
                  disabled={pendingId === d.id}
                  className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50"
                >
                  {pendingId === d.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  {revoked ? "Remove" : "Revoke"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The address a device should be given, with a copy button. Exported because
 *  the API tab shows it next to the loopback example rather than duplicating
 *  the formatting. */
export function CopyableAddress({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
      className="flex items-center gap-1.5 font-mono text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
    >
      {value} {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

/** Re-exported so the API tab keeps one import for this whole area. */
export { Toggle };
