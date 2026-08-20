import { useRef, useState } from "react";
import { Layers, Loader2, Server, Sparkles, ArrowRight, Check, FileUp, Upload } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { PrivacyStatementModal } from "@/components/common/PrivacyStatement";
import { seedDefaultZones } from "@/lib/defaultZones";
import { claimSettingsDrop, pickBundleFile } from "@/lib/importSettings";
import { PROVIDER_PRESETS, presetForBaseUrl } from "@/lib/providerPresets";
import { PRIMARY_ACTION } from "@/lib/chrome";

/**
 * First-run setup: connect a provider and pick a default model, the minimum
 * needed to start a Quick chat. Power-user features (zones, tools, projects)
 * come later.
 *
 * It is deliberately *not* a gate (1.0). Two ways past it besides filling the
 * form in: import a settings export — someone moving from another install
 * already has all of this and shouldn't retype it — or skip, and get a standing
 * banner instead of a locked screen. The old behaviour made connecting to an
 * OpenAI-compatible endpoint the only way to see the app at all, which is a
 * poor first impression for anyone still deciding.
 */
export function Onboarding() {
  const refreshProviders = useApp((s) => s.refreshProviders);
  const existingZones = useApp((s) => s.zones);
  const refreshZones = useApp((s) => s.refreshZones);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const stageImport = useApp((s) => s.stageImport);

  const [step, setStep] = useState<"provider" | "model">("provider");
  const [name, setName] = useState("Local (Ollama)");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);

  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepth = useRef(0);

  async function onConnect() {
    if (!name.trim() || !baseUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Save the provider first so we can query its model list.
      const saved = await api.upsertProvider({
        id: providerId ?? undefined,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || null,
        defaultModel: null,
      });
      setProviderId(saved.id);
      // Best-effort model fetch — if it fails (offline / wrong URL) the user can
      // still type a model name by hand rather than being stuck.
      try {
        const list = await api.fetchModels(saved.id);
        setModels(list);
        if (list.length > 0 && !model) setModel(list[0]);
      } catch (e: any) {
        setError(`Couldn't reach the provider to list models (${e?.message || e}). You can type a model name manually.`);
      }
      setStep("model");
    } catch (e: any) {
      setError(`Failed to save provider: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onFinish() {
    if (!providerId || !model.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.upsertProvider({
        id: providerId,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || null,
        defaultModel: model.trim(),
      });
      // Curated zones are no longer auto-created; they're seeded into the Zone
      // Library (by the app-level one-time seeder) for the user to install. The
      // home screen starts on Quick chat, so the user is productive immediately.

      await refreshProviders();
      // The gate condition (provider with default model) is now satisfied, so
      // this overlay unmounts on the next render.
    } catch (e: any) {
      setError(`Failed to finish setup: ${e?.message || String(e)}`);
      setBusy(false);
    }
  }

  /**
   * Bring a whole setup over from another install instead of rebuilding it. The
   * shared confirmation dialog takes it from here; once it writes a provider the
   * gate clears on its own, so there's nothing to do afterwards.
   */
  async function onImport() {
    setBusy(true);
    setError(null);
    try {
      const picked = await pickBundleFile();
      if (picked) stageImport(picked);
    } catch (e: any) {
      setError(`Couldn't read that file: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Same import, by drop. This overlay covers the whole content area, so the
   * drop targets underneath it (home screen, composer) never see the event —
   * without these handlers dropping a bundle on first run does nothing, which
   * is exactly when someone migrating an install is most likely to try it.
   */
  function hasFiles(e: React.DragEvent) {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }
  function onDragEnter(e: React.DragEvent) {
    if (busy || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragOver(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (busy || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  }
  function onDrop(e: React.DragEvent) {
    if (busy || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    // Copied out before awaiting — `dataTransfer` is cleared on return.
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    setError(null);
    void claimSettingsDrop(files, stageImport).then((claimed) => {
      // Nothing else on this screen can use a dropped file, so unlike the chat
      // drop targets an unclaimed drop is a dead end — say so.
      if (!claimed) setError("That file isn't a MultiZone settings export.");
    });
  }

  const [showPrivacy, setShowPrivacy] = useState(false);

  /** Dismiss setup without a provider. The banner in App.tsx takes over. */
  async function onSkip() {
    await setAppSettings({ onboardingSkipped: true });
  }

  return (
    <div
      className="absolute inset-0 z-[100] flex items-center justify-center bg-[var(--color-bg)]/95 backdrop-blur-sm"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-bg)]/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-panel)]/80 px-10 py-8 text-sm text-[var(--color-text)]">
            <Upload size={28} className="text-[var(--color-accent)]" />
            <div>Drop a settings export to import it</div>
          </div>
        </div>
      )}
      <div className="w-[460px] rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-accent)]">
            <Layers size={18} color="white" />
          </span>
          <div>
            <div className="text-base font-semibold">Welcome to MultiZone</div>
            <div className="text-xs text-[var(--color-text-muted)]">Let's connect a model so you can start chatting.</div>
          </div>
        </div>

        {/* Step indicator */}
        <div className="mb-5 flex items-center gap-2 text-xs">
          <StepDot active={step === "provider"} done={step === "model"} icon={<Server size={12} />} label="Provider" />
          <div className="h-px flex-1 bg-[var(--color-border)]" />
          <StepDot active={step === "model"} done={false} icon={<Sparkles size={12} />} label="Model" />
        </div>

        {step === "provider" ? (
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-1.5 text-[11px] text-[var(--color-text-muted)]">
                Pick your service and we'll fill in the address
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PROVIDER_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    title={`${p.blurb} — ${p.baseUrl}`}
                    onClick={() => { setName(p.name); setBaseUrl(p.baseUrl); }}
                    className={`rounded-full border px-2.5 py-1 text-xs ${
                      presetForBaseUrl(baseUrl)?.id === p.id
                        ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]"
                        : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            <FieldRow label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className="ob-input" placeholder="Local (Ollama)" />
            </FieldRow>
            <FieldRow label="Base URL">
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="ob-input" placeholder="http://localhost:11434/v1" />
            </FieldRow>
            <FieldRow label="API key (optional)">
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" className="ob-input" placeholder="sk-… (leave blank for local)" />
            </FieldRow>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Running Ollama locally? The defaults above usually just work. Using OpenAI, OpenRouter, or
              another service? Paste its OpenAI-compatible base URL and key.
            </p>
            {error && <div className="rounded bg-[var(--color-danger)]/10 p-2 text-xs text-[var(--color-danger)]">{error}</div>}
            <button
              onClick={onConnect}
              disabled={busy || !name.trim() || !baseUrl.trim()}
              className={`mt-1 flex items-center justify-center gap-1.5 rounded px-4 py-2 text-sm ${PRIMARY_ACTION}`}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              Connect
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <FieldRow label="Default model">
              <ModelCombobox
                value={model}
                onChange={setModel}
                options={models}
                className="ob-input"
                placeholder="e.g. llama3.1 or gpt-4o-mini"
              />
            </FieldRow>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              {models.length > 0
                ? `Found ${models.length} model${models.length === 1 ? "" : "s"}. Pick the one Quick chats should use — you can change it later in Settings.`
                : "Type the model name your provider exposes. You can change it later in Settings."}
            </p>
            {error && <div className="rounded bg-[var(--color-danger)]/10 p-2 text-xs text-[var(--color-danger)]">{error}</div>}
            <div className="mt-1 flex gap-2">
              <button
                onClick={() => { setStep("provider"); setError(null); }}
                disabled={busy}
                className="rounded border border-[var(--color-border)] px-3 py-2 text-sm hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
              >
                Back
              </button>
              <button
                onClick={onFinish}
                disabled={busy || !model.trim()}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded px-4 py-2 text-sm ${PRIMARY_ACTION}`}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Start chatting
              </button>
            </div>
          </div>
        )}

        {/* Neither route needs the form above, so they sit outside the steps. */}
        <div className="mt-5 flex items-center justify-between border-t border-[var(--color-border)] pt-3">
          <button
            onClick={onImport}
            disabled={busy}
            className="flex items-center gap-1.5 text-xs text-[var(--color-accent)] hover:underline disabled:opacity-50"
          >
            <FileUp size={13} />
            Import settings from another install
          </button>
          <button
            onClick={onSkip}
            disabled={busy}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Skip for now
          </button>
        </div>

        {/* First run is where someone decides whether to trust this with a key,
            so the answer to "what does it do with my data" belongs here rather
            than only in a settings tab they may never open. */}
        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-[var(--color-text-muted)]">
          <span>Everything stays on this machine. No account, no telemetry.</span>
          <button
            onClick={() => setShowPrivacy(true)}
            className="shrink-0 text-[var(--color-accent)] hover:underline"
          >
            Privacy
          </button>
        </div>
        {showPrivacy && <PrivacyStatementModal onClose={() => setShowPrivacy(false)} />}
      </div>
      <style>{`.ob-input { width: 100%; border: 1px solid var(--color-border); border-radius: 6px; padding: 7px 10px; background: var(--color-bg); font-size: 13px; } .ob-input:focus { border-color: var(--color-accent); outline: none; }`}</style>
    </div>
  );
}

function StepDot({ active, done, icon, label }: { active: boolean; done: boolean; icon: React.ReactNode; label: string }) {
  return (
    <div className={`flex items-center gap-1.5 ${active || done ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full ${
          active ? "bg-[var(--color-accent)] text-white" : done ? "bg-[var(--color-accent)]/30" : "bg-[var(--color-panel-hover)]"
        }`}
      >
        {done ? <Check size={12} /> : icon}
      </span>
      {label}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-[var(--color-text-muted)]">{label}</div>
      {children}
    </label>
  );
}
