import { useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw, ChevronRight, Search } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { VisionOverrideSelect } from "@/components/common/VisionOverrideSelect";
import { resolveBaseProvider } from "@/lib/baseZone";
import { PROVIDER_PRESETS, presetForBaseUrl, type ProviderPreset } from "@/lib/providerPresets";
import type { Provider } from "@/lib/types";
import { errorText } from "@/lib/errors";
import { ErrorNote } from "@/components/common/ErrorNote";
import { Field } from "../controls";

export function ProvidersTab() {
  const { providers, refreshProviders } = useApp(
    useShallow((s) => ({ providers: s.providers, refreshProviders: s.refreshProviders })),
  );
  const zones = useApp((s) => s.zones);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");

  // There is no separate "default provider" setting (0.9.9) — the base zone in
  // Settings → Chat names one, and that is the provider everything falls back
  // to. Shown here so the Providers list still says which one that is.
  const baseProvider = resolveBaseProvider(providers, zones, baseZoneId);

  // A list of a dozen endpoints is a list you scroll rather than read, and the
  // editor used to open above it — so clicking the ninth provider scrolled the
  // one you wanted off the top. Rows are one line each and open in place, and a
  // filter appears once there are enough of them to be worth filtering.
  const q = filter.trim().toLowerCase();
  const shown = q
    ? providers.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.baseUrl.toLowerCase().includes(q) ||
          (p.defaultModel ?? "").toLowerCase().includes(q),
      )
    : providers;

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Providers</h3>
        <button
          onClick={() => { setOpenId(null); setAdding(true); }}
          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} /> Add provider
        </button>
      </div>

      {providers.length > 5 && (
        <div className="relative mb-2">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter providers"
            className="input !pl-7 text-xs"
          />
        </div>
      )}

      {adding && (
        <ProviderForm
          value={{ name: "", baseUrl: "", apiKey: "" }}
          onClose={() => setAdding(false)}
          onDeleted={async () => { await refreshProviders(); setAdding(false); }}
        />
      )}

      <div className="flex flex-col gap-1">
        {shown.map((p) => {
          const open = openId === p.id;
          return (
            <div
              key={p.id}
              className={`rounded border bg-[var(--color-bg)] ${
                open ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
              }`}
            >
              <button
                onClick={() => setOpenId(open ? null : p.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:text-[var(--color-accent)]"
              >
                <ChevronRight
                  size={12}
                  className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-90" : ""}`}
                />
                <span className="shrink-0 font-medium">{p.name}</span>
                <span className="truncate text-xs text-[var(--color-text-muted)]">{p.baseUrl}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">
                  {p.defaultModel || ""}
                </span>
              </button>
              {open && (
                <div className="border-t border-[var(--color-border)] p-3">
                  <ProviderForm
                    value={p}
                    onClose={() => setOpenId(null)}
                    onDeleted={async () => { await refreshProviders(); setOpenId(null); }}
                  />
                </div>
              )}
            </div>
          );
        })}
        {providers.length === 0 && !adding && (
          <div className="rounded border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-text-muted)]">
            No providers yet. Add one to get started.
          </div>
        )}
        {providers.length > 0 && shown.length === 0 && (
          <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
            Nothing matches “{filter}”.
          </div>
        )}
      </div>

      {baseProvider && (
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          Everything falls back to <span className="font-medium text-[var(--color-text)]">{baseProvider.name}</span>,
          the provider behind your base zone (Settings → Chat).
        </p>
      )}
    </>
  );
}

// ─── Appearance ───────────────────────────────────────────────────────────────

/**
 * The provider editor, which saves itself.
 *
 * It used to autosave only once a provider existed, and existing meant having
 * pressed "Add provider" — so a new provider could not be tested until it had
 * been saved, and the one thing you want to do with an endpoint and a key you
 * just typed is find out whether they work. A name and a base URL is enough to
 * be a provider, so as soon as both are filled the row is written and the form
 * carries on editing it. There is no save button in either direction.
 */
function ProviderForm({ value, onClose, onDeleted }: { value: Partial<Provider>; onClose: () => void; onDeleted: () => void }) {
  const refreshProviders = useApp((s) => s.refreshProviders);
  const [id, setId] = useState<string | null>(value.id ?? null);
  const [name, setName] = useState(value.name ?? "");
  const [baseUrl, setBaseUrl] = useState(value.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(value.apiKey ?? "");
  const [defaultModel, setDefaultModel] = useState(value.defaultModel ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  // Why the last autosave failed — a duplicate name, say — until one succeeds.
  const [saveError, setSaveError] = useState<unknown>(null);
  const [presetId, setPresetId] = useState<string | null>(null);

  // Auto-load the model list when editing an existing provider.
  useEffect(() => {
    if (!value.id) return;
    let cancelled = false;
    setTesting(true);
    setTestResult(null);
    api.fetchModels(value.id)
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setTestResult(`Found ${list.length} model${list.length === 1 ? "" : "s"}.`);
      })
      .catch((e: any) => { if (!cancelled) setTestResult(errorText(e)); })
      .finally(() => { if (!cancelled) setTesting(false); });
    return () => { cancelled = true; };
  }, [value.id]);

  // Autosave, debounced past a burst of typing. The first write is what creates
  // a new provider, so `id` is adopted from what comes back.
  useEffect(() => {
    if (!name.trim() || !baseUrl.trim()) return;
    const timer = setTimeout(async () => {
      try {
        const saved = await api.upsertProvider({
          id: id ?? undefined,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || null,
          defaultModel: defaultModel.trim() || null,
        });
        if (!id) setId(saved.id);
        await refreshProviders();
        setSaveError(null);
      } catch (e) {
        console.error("provider autosave failed", e);
        setSaveError(e);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [name, baseUrl, apiKey, defaultModel, id]);

  async function onDelete() {
    if (id) await api.deleteProvider(id);
    onDeleted();
  }

  async function onTest() {
    if (!id) { setTestResult("Fill in a name and base URL first."); return; }
    setTesting(true);
    setTestResult(null);
    try {
      const list = await api.fetchModels(id);
      setModels(list);
      setTestResult(`Found ${list.length} model${list.length === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setTestResult(errorText(e));
    } finally { setTesting(false); }
  }

  /** Fill the form from a known service, leaving anything the user typed. */
  function applyPreset(p: ProviderPreset) {
    setPresetId(p.id);
    setName(p.name);
    setBaseUrl(p.baseUrl);
    if (p.suggestedModel && !defaultModel.trim()) setDefaultModel(p.suggestedModel);
  }

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? presetForBaseUrl(baseUrl);

  return (
    <div className={value.id ? "" : "mb-4 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3"}>
      {!value.id && (
        <div className="mb-3">
          <div className="mb-1.5 text-xs text-[var(--color-text-muted)]">
            Start from a known service, or fill the fields in yourself.{" "}
            <span className="text-[var(--color-accent)]">Free</span> marks the ones with a standing
            free tier and no card.
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={`${p.blurb} — ${p.baseUrl}`}
                onClick={() => applyPreset(p)}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  preset?.id === p.id
                    ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]"
                    : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                }`}
              >
                {p.name}
                {p.freeTier && (
                  <span className="ml-1 text-[10px] text-[var(--color-accent)]">free</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Ollama local" />
      </Field>
      <Field label="Base URL">
        <input
          value={baseUrl}
          onChange={(e) => { setPresetId(null); setBaseUrl(e.target.value); }}
          className="input"
          placeholder="http://localhost:11434/v1"
        />
      </Field>
      <Field label={preset && !preset.needsKey ? "API key (not needed for a local server)" : "API key (optional)"}>
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" className="input" placeholder="sk-..." />
      </Field>
      {/* Said where the key is typed rather than only in the privacy statement,
          because this is the moment someone decides whether to paste one. */}
      {apiKey.trim() !== "" && (
        <p className="-mt-1 mb-2 text-[11px] text-[var(--color-text-muted)]">
          Stored in plain text in this app’s local database — not encrypted, not in your OS
          keychain. It never leaves the machine except to the provider above.
        </p>
      )}
      {preset?.keyUrl && (
        <p className="-mt-1 mb-2 text-[11px] text-[var(--color-text-muted)]">
          Get a {preset.name} key at{" "}
          <a
            href={preset.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-accent)] underline underline-offset-2"
          >
            {preset.keyUrl.replace(/^https:\/\//, "")}
          </a>
          {preset.freeTier && ` — ${preset.freeTier}.`}
        </p>
      )}
      <Field label="Default model">
        <ModelCombobox
          value={defaultModel}
          onChange={setDefaultModel}
          options={models}
          className="input"
          placeholder={testing ? "Loading models…" : value.id ? "Pick or type a model" : "Add provider first, or type a model name"}
        />
      </Field>
      {defaultModel.trim() && (
        <Field label="Image input (default model)">
          <VisionOverrideSelect model={defaultModel} />
        </Field>
      )}
      {testResult && (
        <div className="my-2 rounded bg-[var(--color-panel)] p-2 text-xs text-[var(--color-text-muted)]">{testResult}</div>
      )}
      <ErrorNote error={saveError} context="Not saved" className="my-2 rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500" />
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onDelete} className="flex items-center gap-1 rounded border border-[var(--color-danger)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white">
          <Trash2 size={12} /> {id ? "Delete" : "Discard"}
        </button>
        <button onClick={onTest} disabled={testing} className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50">
          <RefreshCw size={12} className={testing ? "animate-spin" : ""} /> Test
        </button>
        <button onClick={onClose} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
          Done
        </button>
      </div>
    </div>
  );
}
