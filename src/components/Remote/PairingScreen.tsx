/**
 * The phone's first screen (0.17.2): find the desktop, enter the code, done.
 *
 * This is the whole of the mobile app that is not the desktop app. Everything
 * past it is the same React the desktop runs, over a different transport.
 *
 * Two ways in, and the order matters. Pasting the link the desktop's QR encodes
 * fills in the address *and* the code, which is the path where nobody types
 * anything they could get wrong. Typing an address and a six-digit code is the
 * fallback that always works — on a network that blocks multicast, from a
 * device with no camera, or when the QR will not focus.
 */

import { useState } from "react";
import { AlertTriangle, ArrowRight, Link2, Loader2, Smartphone } from "lucide-react";
import { pair, parsePairingLink } from "@/lib/remote/transport";

/** What the desktop should call this device. Editable, because "Pixel 8" is a
 *  better answer than a model number and "my phone" is a better one still. */
function defaultDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  const android = /Android[^;]*;\s*([^)]+?)\s*(?:Build|\))/i.exec(ua);
  if (android?.[1]) return android[1].split(";").pop()!.trim();
  if (/Android/i.test(ua)) return "Android phone";
  return "This device";
}

function platform(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  return "web";
}

export function PairingScreen({ onPaired }: { onPaired: () => void }) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = address.trim().length > 0 && code.trim().length >= 6;

  /**
   * Accept a pasted `multizone://pair?…` link anywhere.
   *
   * Watched on both fields rather than hidden behind a "paste link" button: a
   * person with the link in their clipboard will paste it into whichever box
   * they are looking at, and being right about that is free.
   */
  function absorb(text: string, fallback: (v: string) => void) {
    const link = parsePairingLink(text);
    if (link) {
      setAddress(link.baseUrl);
      setCode(link.code);
      setError(null);
      return;
    }
    fallback(text);
  }

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await pair({
        baseUrl: address,
        code: code.trim(),
        name: name.trim() || defaultDeviceName(),
        platform: platform(),
      });
      onPaired();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <Smartphone size={22} className="text-[var(--color-accent)]" />
          <h1 className="text-lg font-medium">Connect to your computer</h1>
        </div>

        <p className="mb-6 text-sm leading-relaxed text-[var(--color-text-muted)]">
          MultiZone runs on your computer, and this is a window onto it. On the
          computer, open <span className="text-[var(--color-text)]">Settings → API → Pair a
          device</span> and it will show you a code.
        </p>

        <label className="mb-1.5 block text-xs text-[var(--color-text-muted)]">
          Computer address
        </label>
        <input
          value={address}
          onChange={(e) => absorb(e.target.value, setAddress)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (parsePairingLink(text)) {
              e.preventDefault();
              absorb(text, setAddress);
            }
          }}
          placeholder="192.168.1.5:8765"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="mb-4 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3.5 py-3 text-base outline-none focus:border-[var(--color-accent)]"
        />

        <label className="mb-1.5 block text-xs text-[var(--color-text-muted)]">Pairing code</label>
        <input
          value={code}
          onChange={(e) => absorb(e.target.value, (v) => setCode(v.replace(/\D/g, "").slice(0, 6)))}
          placeholder="000000"
          // A numeric keypad and a six-character field: the code is six digits,
          // and a full keyboard here is a keyboard nothing valid can be typed on.
          inputMode="numeric"
          maxLength={6}
          className="mb-4 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3.5 py-3 text-center font-mono text-2xl tracking-[0.35em] outline-none focus:border-[var(--color-accent)]"
        />

        <label className="mb-1.5 block text-xs text-[var(--color-text-muted)]">
          Name this device
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          className="mb-5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3.5 py-3 text-base outline-none focus:border-[var(--color-accent)]"
        />

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/5 px-3 py-2.5 text-sm">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
            <span>{error}</span>
          </div>
        )}

        <button
          onClick={submit}
          disabled={!ready || busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-3.5 text-base font-medium text-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={17} className="animate-spin" /> : <ArrowRight size={17} />}
          {busy ? "Connecting…" : "Connect"}
        </button>

        <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
          <Link2 size={13} className="mt-0.5 shrink-0" />
          You can also paste the link from the computer's QR code into either box above — it
          fills in both.
        </p>
      </div>
    </div>
  );
}
