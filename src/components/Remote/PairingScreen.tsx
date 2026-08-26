/**
 * The phone's first screen (0.17.4): pick a computer, get a code, name yourself.
 *
 * The first version was one form with three fields, and it read like a
 * configuration dialog because that is what it was. Three problems with it, and
 * they are the reason this is a wizard rather than a tidier form:
 *
 * - **It asked for an address.** Nobody knows their computer's IP. The phone
 *   can find it — it is on the same network — so it does.
 * - **It asked for a code the user had to go and fetch.** They had to walk to
 *   the desktop, press a button, read six digits, and walk back to a screen
 *   that had no idea any of that had happened. Now the phone asks, and the code
 *   appears on the desktop *because* it asked, with this device's name beside
 *   it so the person approving knows what they are approving.
 * - **It had no memory.** Losing the desktop meant doing all of it again. The
 *   saved list is the first thing this screen shows once there is one.
 *
 * The manual path survives every step, because discovery is the thing most
 * likely to be blocked on somebody's network and a wizard with no escape hatch
 * is worse than a form.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Trash2,
} from "lucide-react";
import {
  forgetConnection,
  listConnections,
  normalizeBaseUrl,
  pair,
  parsePairingLink,
  renameThisDevice,
  requestPairingCode,
  useConnection,
  type SavedConnection,
} from "@/lib/remote/transport";
import { discoverDesktops, type FoundDesktop } from "@/lib/remote/discovery";

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

type Step = "computers" | "code" | "name";

export function PairingScreen({ onPaired }: { onPaired: () => void }) {
  const [saved, setSaved] = useState<SavedConnection[]>(() => listConnections());
  const [step, setStep] = useState<Step>("computers");
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);

  // A saved computer is one tap. The wizard is for adding a new one, and
  // starting on it when there is a list would be starting on the rare case.
  const [adding, setAdding] = useState(() => listConnections().length === 0);

  function reset() {
    setStep("computers");
    setBaseUrl("");
    setError(null);
  }

  if (!adding) {
    return (
      <Frame>
        <ComputerList
          saved={saved}
          onConnect={(c) => {
            useConnection(c.id);
            onPaired();
          }}
          onForget={(c) => {
            forgetConnection(c.id);
            const next = listConnections();
            setSaved(next);
            if (next.length === 0) setAdding(true);
          }}
          onAdd={() => {
            reset();
            setAdding(true);
          }}
        />
      </Frame>
    );
  }

  return (
    <Frame>
      <Steps current={step} />
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/5 px-3 py-2.5 text-sm">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <span>{error}</span>
        </div>
      )}

      {step === "computers" && (
        <FindComputer
          baseUrl={baseUrl}
          setBaseUrl={setBaseUrl}
          onError={setError}
          onBack={saved.length > 0 ? () => setAdding(false) : undefined}
          onNext={() => {
            setError(null);
            setStep("code");
          }}
        />
      )}

      {step === "code" && (
        <EnterCode
          baseUrl={baseUrl}
          name={name}
          onError={setError}
          onBack={() => setStep("computers")}
          onPaired={() => {
            setSaved(listConnections());
            setStep("name");
          }}
        />
      )}

      {step === "name" && (
        <NameDevice
          name={name}
          setName={setName}
          onError={setError}
          onDone={onPaired}
        />
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto bg-[var(--color-bg)] px-5 py-10 text-[var(--color-text)]">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

/** Three dots and a label. A wizard with no visible end is a wizard people
 *  abandon halfway. */
function Steps({ current }: { current: Step }) {
  const order: Step[] = ["computers", "code", "name"];
  const labels: Record<Step, string> = {
    computers: "Find your computer",
    code: "Enter the code",
    name: "Name this device",
  };
  const index = order.indexOf(current);
  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-2.5">
        <Smartphone size={20} className="text-[var(--color-accent)]" />
        <h1 className="text-lg font-medium">{labels[current]}</h1>
      </div>
      <div className="flex gap-1.5">
        {order.map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full ${
              i <= index ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── The saved list ──────────────────────────────────────────────────────────

function ComputerList({
  saved,
  onConnect,
  onForget,
  onAdd,
}: {
  saved: SavedConnection[];
  onConnect: (c: SavedConnection) => void;
  onForget: (c: SavedConnection) => void;
  onAdd: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <>
      <div className="mb-5 flex items-center gap-2.5">
        <Monitor size={20} className="text-[var(--color-accent)]" />
        <h1 className="text-lg font-medium">Your computers</h1>
      </div>

      <div className="mb-4 flex flex-col gap-2">
        {saved.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3.5 py-3"
          >
            <button className="min-w-0 flex-1 text-left" onClick={() => onConnect(c)}>
              <div className="truncate text-base">{c.label}</div>
              <div className="truncate text-xs text-[var(--color-text-muted)]">
                paired as {c.deviceName}
              </div>
            </button>
            {confirming === c.id ? (
              <button
                onClick={() => onForget(c)}
                className="shrink-0 rounded border border-[var(--color-danger)] px-2.5 py-2 text-xs text-[var(--color-danger)]"
              >
                Forget
              </button>
            ) : (
              <button
                onClick={() => setConfirming(c.id)}
                aria-label={`Forget ${c.label}`}
                className="mz-tap shrink-0 rounded p-2 text-[var(--color-text-muted)]"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Said plainly, because "removed" that leaves a working token is exactly
          the confusion per-device revocation exists to prevent. */}
      {confirming && (
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Forgetting only affects this phone. The computer still lists it as paired until you
          revoke it there, under Settings → Phone &amp; remote.
        </p>
      )}

      <button
        onClick={onAdd}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm"
      >
        <Plus size={15} /> Add another computer
      </button>
    </>
  );
}

// ─── Step 1 ──────────────────────────────────────────────────────────────────

function FindComputer({
  baseUrl,
  setBaseUrl,
  onError,
  onBack,
  onNext,
}: {
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  onError: (e: string | null) => void;
  onBack?: () => void;
  onNext: () => void;
}) {
  const [found, setFound] = useState<FoundDesktop[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [manual, setManual] = useState("");

  const scan = useCallback(async () => {
    setScanning(true);
    onError(null);
    try {
      const list = await discoverDesktops();
      setFound(list);
      // Nothing to choose between: take the only answer rather than making
      // somebody tap a list of one.
      if (list.length === 1) setBaseUrl(list[0].baseUrl);
    } catch (e: any) {
      // Not an error the user has to act on — the manual field below is right
      // there, and works on every network discovery does not.
      console.warn("discovery failed", e);
    } finally {
      setScanning(false);
      setScanned(true);
    }
  }, [onError, setBaseUrl]);

  // Scanned on arrival, because the answer is almost always "the one computer
  // on this network" and asking someone to press Search first is asking them to
  // do the app's job.
  useEffect(() => {
    void scan();
  }, [scan]);

  function commitManual(value: string) {
    const link = parsePairingLink(value);
    if (link) {
      setManual(link.baseUrl);
      setBaseUrl(link.baseUrl);
      return;
    }
    setManual(value);
    try {
      setBaseUrl(normalizeBaseUrl(value));
    } catch {
      setBaseUrl("");
    }
  }

  return (
    <>
      <p className="mb-5 text-sm leading-relaxed text-[var(--color-text-muted)]">
        MultiZone runs on your computer and this is a window onto it. On the computer, open{" "}
        <span className="text-[var(--color-text)]">Settings → Phone &amp; remote</span> and tap{" "}
        <span className="text-[var(--color-text)]">Pair a device</span>.
      </p>

      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-[var(--color-text-muted)]">On this network</span>
        <button
          onClick={scan}
          disabled={scanning}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] disabled:opacity-50"
        >
          {scanning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {scanning ? "Looking…" : "Search again"}
        </button>
      </div>

      <div className="mb-4 flex flex-col gap-2">
        {scanning && found.length === 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3.5 py-3 text-sm text-[var(--color-text-muted)]">
            <Search size={15} /> Looking for computers…
          </div>
        )}
        {found.map((d) => (
          <button
            key={d.baseUrl}
            onClick={() => setBaseUrl(d.baseUrl)}
            className={`flex items-center gap-3 rounded-lg border px-3.5 py-3 text-left ${
              baseUrl === d.baseUrl
                ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                : "border-[var(--color-border)]"
            }`}
          >
            <Monitor size={16} className="shrink-0 text-[var(--color-text-muted)]" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{d.address}</div>
              <div className="truncate text-xs text-[var(--color-text-muted)]">
                {d.waiting ? "waiting for a device" : `MultiZone ${d.version ?? ""}`}
              </div>
            </div>
            {baseUrl === d.baseUrl && <Check size={16} className="text-[var(--color-accent)]" />}
          </button>
        ))}
        {scanned && !scanning && found.length === 0 && (
          <div className="rounded-lg border border-[var(--color-border)] px-3.5 py-3 text-sm text-[var(--color-text-muted)]">
            No computers found. Check that remote access is switched on there, that both devices
            are on the same Wi-Fi, or type the address below.
          </div>
        )}
      </div>

      <label className="mb-1.5 block text-xs text-[var(--color-text-muted)]">
        Or type the address
      </label>
      <input
        value={manual}
        onChange={(e) => commitManual(e.target.value)}
        placeholder="192.168.1.5:8765"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="mb-5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3.5 py-3 text-base outline-none focus:border-[var(--color-accent)]"
      />

      <div className="flex gap-2">
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-4 py-3.5 text-sm"
          >
            <ArrowLeft size={15} /> Back
          </button>
        )}
        <button
          onClick={onNext}
          disabled={!baseUrl}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-3.5 text-base font-medium text-white disabled:opacity-40"
        >
          Next <ArrowRight size={17} />
        </button>
      </div>
    </>
  );
}

// ─── Step 2 ──────────────────────────────────────────────────────────────────

/**
 * Ask for a code, then take it.
 *
 * The request goes out the moment this step opens, so by the time the user
 * looks up, the desktop is already showing the digits. If the desktop is not
 * waiting, the refusal is the instruction — and Try again is right there,
 * because "go and tap a button on the other machine" is a thing you do and then
 * immediately want to retry.
 */
function EnterCode({
  baseUrl,
  name,
  onError,
  onBack,
  onPaired,
}: {
  baseUrl: string;
  name: string;
  onError: (e: string | null) => void;
  onBack: () => void;
  onPaired: () => void;
}) {
  const [code, setCode] = useState("");
  const [asking, setAsking] = useState(true);
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async () => {
    setAsking(true);
    onError(null);
    try {
      await requestPairingCode({ baseUrl, name, platform: platform() });
      setAsked(true);
    } catch (e: any) {
      setAsked(false);
      onError(e?.message || String(e));
    } finally {
      setAsking(false);
    }
  }, [baseUrl, name, onError]);

  useEffect(() => {
    void ask();
  }, [ask]);

  async function submit() {
    if (code.length < 6 || busy) return;
    setBusy(true);
    onError(null);
    try {
      await pair({ baseUrl, code, name, platform: platform() });
      onPaired();
    } catch (e: any) {
      onError(e?.message || String(e));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="mb-5 text-sm leading-relaxed text-[var(--color-text-muted)]">
        {asking ? (
          <>Asking {baseUrl.replace(/^https?:\/\//, "")} for a code…</>
        ) : asked ? (
          <>
            Your computer is now showing a six-digit code for{" "}
            <span className="text-[var(--color-text)]">{name}</span>. Type it here.
          </>
        ) : (
          <>
            Your computer is not waiting for a device yet. Open{" "}
            <span className="text-[var(--color-text)]">Settings → Phone &amp; remote</span> there,
            tap <span className="text-[var(--color-text)]">Pair a device</span>, then try again.
          </>
        )}
      </p>

      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder="000000"
        // A numeric keypad and a six-character field: the code is six digits,
        // and a full keyboard here is a keyboard nothing valid can be typed on.
        inputMode="numeric"
        maxLength={6}
        autoFocus
        disabled={!asked}
        className="mb-5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3.5 py-3 text-center font-mono text-2xl tracking-[0.35em] outline-none focus:border-[var(--color-accent)] disabled:opacity-40"
      />

      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-4 py-3.5 text-sm"
        >
          <ArrowLeft size={15} /> Back
        </button>
        {asked ? (
          <button
            onClick={submit}
            disabled={code.length < 6 || busy}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-3.5 text-base font-medium text-white disabled:opacity-40"
          >
            {busy ? <Loader2 size={17} className="animate-spin" /> : <ArrowRight size={17} />}
            {busy ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <button
            onClick={ask}
            disabled={asking}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] px-4 py-3.5 text-base disabled:opacity-40"
          >
            {asking ? <Loader2 size={17} className="animate-spin" /> : <RefreshCw size={17} />}
            Try again
          </button>
        )}
      </div>
    </>
  );
}

// ─── Step 3 ──────────────────────────────────────────────────────────────────

/**
 * Named last, on purpose.
 *
 * The device is already paired by the time this shows, so the name is a label
 * being corrected rather than a field standing between somebody and a working
 * app. Skipping it leaves the name the phone guessed, which is a model number —
 * fine, and changeable from the computer later.
 */
function NameDevice({
  name,
  setName,
  onError,
  onDone,
}: {
  name: string;
  setName: (v: string) => void;
  onError: (e: string | null) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function finish() {
    setBusy(true);
    try {
      await renameThisDevice(name.trim() || defaultDeviceName());
    } catch (e: any) {
      // Connected either way — the rename is cosmetic and must not be the
      // reason somebody is left staring at a pairing screen.
      onError(e?.message || String(e));
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <>
      <p className="mb-5 text-sm leading-relaxed text-[var(--color-text-muted)]">
        Connected. This is what your computer will call this device in its list — the name you
        will look for when you want to revoke it.
      </p>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={60}
        autoFocus
        className="mb-5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3.5 py-3 text-base outline-none focus:border-[var(--color-accent)]"
      />

      <button
        onClick={finish}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-3.5 text-base font-medium text-white disabled:opacity-40"
      >
        {busy ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} />} Done
      </button>
    </>
  );
}
