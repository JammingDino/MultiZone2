import { useState } from "react";
import { Layers, Loader2, Server, Sparkles, ArrowRight, Check } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { seedDefaultZones } from "@/lib/defaultZones";

/**
 * First-run gate. Shown full-screen (and non-dismissable) until the user has
 * configured at least one provider *with* a default model — the minimum needed
 * to start a Quick chat. Power-user features (zones, tools, projects) come
 * later; this just gets a model wired up so the app is usable on launch.
 */
export function Onboarding() {
  const refreshProviders = useApp((s) => s.refreshProviders);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const existingZones = useApp((s) => s.zones);
  const refreshZones = useApp((s) => s.refreshZones);

  const [step, setStep] = useState<"provider" | "model">("provider");
  const [name, setName] = useState("Local (Ollama)");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);

  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // Mark seeding done up front so the app-level one-time seeder doesn't also
      // fire while we seed here.
      await setAppSettings({ defaultProviderId: providerId, seededStarterZones: true });

      // Seed a starter set of zones (bound to this provider + model) so the user
      // lands with a useful spread of assistants. We don't set a default zone —
      // the home screen starts on Quick chat and the user can pick a default in
      // Settings if they want one.
      if (existingZones.length === 0) {
        await seedDefaultZones(providerId, model.trim());
        await refreshZones();
      }

      await refreshProviders();
      // The gate condition (provider with default model) is now satisfied, so
      // this overlay unmounts on the next render.
    } catch (e: any) {
      setError(`Failed to finish setup: ${e?.message || String(e)}`);
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-[var(--color-bg)]/95 backdrop-blur-sm">
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
              className="mt-1 flex items-center justify-center gap-1.5 rounded bg-[var(--color-accent)] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
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
                className="rounded border border-[var(--color-border)] px-3 py-2 text-sm hover:border-[var(--color-accent)] disabled:opacity-50"
              >
                Back
              </button>
              <button
                onClick={onFinish}
                disabled={busy || !model.trim()}
                className="flex flex-1 items-center justify-center gap-1.5 rounded bg-[var(--color-accent)] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Start chatting
              </button>
            </div>
          </div>
        )}
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
