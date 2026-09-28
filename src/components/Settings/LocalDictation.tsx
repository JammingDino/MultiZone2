import { useEffect, useState } from "react";
import { Cpu, Loader2, Trash2 } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { reportError } from "@/lib/reportError";
import { formatBytes } from "@/lib/format";
import type { LocalSttProgress, LocalSttStatus } from "@/lib/types";

/** The `sttProviderId` that means "the whisper server this app runs". */
export const LOCAL_STT_PROVIDER = "__local__";

/**
 * Dictation on this computer (0.18): pick a speech model, download it, and
 * dictation uses it — no account, no server to set up, nothing leaving the
 * machine. The backend fetches whisper.cpp's server and the model (both
 * checksum-verified) and starts the server only while dictation is in use.
 */
export function LocalDictation() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const [status, setStatus] = useState<LocalSttStatus | null>(null);
  const [progress, setProgress] = useState<LocalSttProgress | null>(null);
  const active = appSettings.sttProviderId === LOCAL_STT_PROVIDER ? appSettings.sttModel : null;
  const [picked, setPicked] = useState<string>(active || "base.en");

  const refresh = () => api.localSttStatus().then(setStatus).catch(reportError("Couldn't read local dictation"));

  useEffect(() => {
    refresh();
    const un = api.onLocalSttProgress((p) => setProgress(p.stage === "done" ? null : p));
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);

  if (!status) return null;
  const model = status.models.find((m) => m.id === picked);
  const installing = status.installing || progress !== null;

  async function select(id: string) {
    await setAppSettings({ sttProviderId: LOCAL_STT_PROVIDER, sttModel: id });
  }

  async function install() {
    if (!model) return;
    setStatus((s) => (s ? { ...s, installing: true } : s));
    try {
      await api.installLocalStt(model.id);
      await select(model.id);
    } catch (e) {
      if (!String(e).includes("cancelled")) reportError("Couldn't set up local dictation")(e);
    } finally {
      setProgress(null);
      refresh();
    }
  }

  async function remove(id: string) {
    try {
      await api.removeLocalSttModel(id);
      if (active === id) await setAppSettings({ sttProviderId: null, sttModel: "" });
    } catch (e) {
      reportError("Couldn't remove the model")(e);
    }
    refresh();
  }

  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Cpu size={14} /> Dictation on this computer
      </h3>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        Run a speech model on this machine — no account, and your recordings never leave it. Pick a
        model and it is downloaded once, then started whenever you dictate and stopped when you
        have not for ten minutes. Powered by whisper.cpp.
      </p>
      {!status.supported ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          There is no ready-made whisper.cpp for this platform. Install one so{" "}
          <span className="font-mono">whisper-server</span> is on your PATH (on macOS:{" "}
          <span className="font-mono">brew install whisper-cpp</span>), then reopen this tab.
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-col gap-1.5">
            {status.models.map((m) => (
              <label
                key={m.id}
                className={`flex cursor-pointer items-start gap-2 rounded border px-2.5 py-2 ${
                  picked === m.id ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
                }`}
              >
                <input
                  type="radio"
                  name="local-stt-model"
                  checked={picked === m.id}
                  onChange={() => setPicked(m.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    {m.label}
                    <span className="text-[11px] text-[var(--color-text-muted)]">{formatBytes(m.sizeBytes)}</span>
                    {active === m.id && <span className="text-[11px] text-[var(--color-accent)]">in use</span>}
                    {m.installed && active !== m.id && (
                      <span className="text-[11px] text-[var(--color-text-muted)]">downloaded</span>
                    )}
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">{m.note}</div>
                </div>
                {m.installed && (
                  <button
                    onClick={(e) => { e.preventDefault(); remove(m.id); }}
                    title="Delete this model from disk"
                    className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </label>
            ))}
          </div>

          {installing ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <Loader2 size={12} className="animate-spin" />
                {progress?.stage === "engine" ? "Downloading whisper.cpp…" : `Downloading ${model?.label ?? "the model"}…`}
                {progress && progress.total > 0 && ` ${formatBytes(progress.received)} of ${formatBytes(progress.total)}`}
                <button onClick={() => api.cancelLocalSttInstall()} className="ml-auto underline hover:text-[var(--color-text)]">
                  Cancel
                </button>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-[var(--color-panel-hover)]">
                <div
                  className="h-full bg-[var(--color-accent)] transition-[width]"
                  style={{ width: `${progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0}%` }}
                />
              </div>
            </div>
          ) : model?.installed ? (
            <button
              onClick={() => select(model.id).catch(reportError("Couldn't switch dictation"))}
              disabled={active === model.id}
              className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {active === model.id ? "In use for dictation" : "Use for dictation"}
            </button>
          ) : (
            <button onClick={install} className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white">
              Download and use{model ? ` (${formatBytes(model.sizeBytes + (status.engineInstalled ? 0 : 9_000_000))})` : ""}
            </button>
          )}
        </>
      )}
    </section>
  );
}
