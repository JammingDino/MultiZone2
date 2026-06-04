import { useEffect, useState } from "react";
import { X, Plus, Trash2, RefreshCw, Server, Palette, MessageSquare, Database, AlertTriangle, Loader2 } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import type { DbStats, Provider } from "@/lib/types";

type Tab = "providers" | "appearance" | "chat" | "data";

export function SettingsModal() {
  const { closeSettings } = useApp();
  const [tab, setTab] = useState<Tab>("providers");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex h-[620px] w-[820px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] shadow-xl">
        <div className="flex h-12 items-center justify-between border-b border-[var(--color-border)] px-4">
          <div className="font-medium">Settings</div>
          <button onClick={closeSettings} className="rounded p-1 hover:bg-[var(--color-panel-hover)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-1 overflow-hidden">
          <nav className="flex w-44 flex-col gap-1 border-r border-[var(--color-border)] p-2 text-sm">
            <TabButton active={tab === "providers"} icon={<Server size={14} />} label="Providers" onClick={() => setTab("providers")} />
            <TabButton active={tab === "appearance"} icon={<Palette size={14} />} label="Appearance" onClick={() => setTab("appearance")} />
            <TabButton active={tab === "chat"} icon={<MessageSquare size={14} />} label="Chat" onClick={() => setTab("chat")} />
            <TabButton active={tab === "data"} icon={<Database size={14} />} label="Data" onClick={() => setTab("data")} />
          </nav>
          <div className="flex-1 overflow-y-auto p-4">
            {tab === "providers" && <ProvidersTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "chat" && <ChatTab />}
            {tab === "data" && <DataTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded px-2 py-1.5 text-left ${
        active ? "bg-[var(--color-panel-hover)] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Providers ────────────────────────────────────────────────────────────────

function ProvidersTab() {
  const { providers, refreshProviders } = useApp();
  const [editing, setEditing] = useState<Partial<Provider> | null>(null);

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">Providers</h3>
        <button
          onClick={() => setEditing({ name: "", baseUrl: "http://localhost:11434/v1", apiKey: "" })}
          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)]"
        >
          <Plus size={12} /> Add provider
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {providers.map((p) => (
          <div
            key={p.id}
            onClick={() => setEditing(p)}
            className="cursor-pointer rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm hover:border-[var(--color-accent)]"
          >
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-[var(--color-text-muted)]">{p.baseUrl}</div>
          </div>
        ))}
        {providers.length === 0 && (
          <div className="rounded border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-text-muted)]">
            No providers yet. Add one to get started.
          </div>
        )}
      </div>

      {editing && (
        <ProviderForm
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { await refreshProviders(); setEditing(null); }}
        />
      )}
    </>
  );
}

// ─── Appearance ───────────────────────────────────────────────────────────────

const ACCENT_PRESETS = ["#4f9cf9", "#22c55e", "#a855f7", "#f97316", "#ec4899", "#facc15"];

function AppearanceTab() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="mb-2 text-sm font-medium">Color mode</h3>
        <div className="flex gap-2">
          {(["dark", "light"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setTheme({ mode: m })}
              className={`flex-1 rounded border px-3 py-2 text-sm ${theme.mode === m ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]" : "border-[var(--color-border)] hover:border-[var(--color-accent)]"}`}
            >
              {m === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Accent color</h3>
        <div className="flex flex-wrap items-center gap-2">
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              onClick={() => setTheme({ accent: c })}
              className={`h-8 w-8 rounded-full border-2 ${theme.accent.toLowerCase() === c.toLowerCase() ? "border-[var(--color-text)]" : "border-transparent"}`}
              style={{ background: c }}
              title={c}
            />
          ))}
          <label className="ml-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            Custom
            <input
              type="color"
              value={theme.accent}
              onChange={(e) => setTheme({ accent: e.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
            />
          </label>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Message font size</h3>
        <div className="flex gap-2">
          {([["normal", "Normal (14px)"], ["large", "Large (16px)"], ["xl", "X-Large (18px)"]] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setAppSettings({ fontSize: val })}
              className={`flex-1 rounded border px-3 py-2 text-sm ${appSettings.fontSize === val ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]" : "border-[var(--color-border)] hover:border-[var(--color-accent)]"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Preview</h3>
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-2xl rounded-tr-sm px-3 py-1.5 text-white" style={{ background: theme.accent }}>
              Hello!
            </span>
          </div>
          <div className="text-[var(--color-text-muted)]">
            User bubbles use your accent color. Bot replies use the panel color.
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function ChatTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const zones = useApp((s) => s.zones);
  const defaultZoneId = useApp((s) => s.defaultZoneId);
  const setDefaultZone = useApp((s) => s.setDefaultZone);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Default zone</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          The zone new chats start with. A project's own default zone overrides this for chats created inside that project.
        </p>
        <select
          value={defaultZoneId ?? ""}
          onChange={(e) => setDefaultZone(e.target.value || null)}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">No default (use first zone)</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </select>
        {zones.length === 0 && (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            No zones yet — create one from “Configure Zones”.
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Send key</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Which key combination sends a message. Shift+Enter always inserts a new line.
        </p>
        <div className="flex gap-2">
          {([
            ["enter", "Enter", "Press Enter to send"],
            ["ctrl_enter", "Ctrl+Enter", "Press Ctrl+Enter (⌘+Enter on Mac) to send"],
          ] as const).map(([val, label, desc]) => (
            <button
              key={val}
              onClick={() => setAppSettings({ sendKey: val })}
              className={`flex-1 rounded border px-3 py-2.5 text-left text-sm ${appSettings.sendKey === val ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]" : "border-[var(--color-border)] hover:border-[var(--color-accent)]"}`}
            >
              <div className="font-medium">{label}</div>
              <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{desc}</div>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Chat titles</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Automatically ask the model to generate a short title after the first response.
        </p>
        <label className="flex cursor-pointer items-center justify-between rounded border border-[var(--color-border)] px-3 py-2.5 hover:border-[var(--color-accent)]">
          <span className="text-sm">Auto-generate titles</span>
          <Toggle
            checked={appSettings.autoTitle}
            onChange={(v) => setAppSettings({ autoTitle: v })}
          />
        </label>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Reasoning blocks</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Show thinking/reasoning expanded by default. When off, blocks are collapsed once streaming finishes.
        </p>
        <label className="flex cursor-pointer items-center justify-between rounded border border-[var(--color-border)] px-3 py-2.5 hover:border-[var(--color-accent)]">
          <span className="text-sm">Expand reasoning by default</span>
          <Toggle
            checked={appSettings.expandThinkingByDefault}
            onChange={(v) => setAppSettings({ expandThinkingByDefault: v })}
          />
        </label>
      </section>
    </div>
  );
}

// ─── Data ─────────────────────────────────────────────────────────────────────

function DataTab() {
  const [stats, setStats] = useState<DbStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [resetStage, setResetStage] = useState<"idle" | "confirm" | "resetting">("idle");

  useEffect(() => {
    setLoadingStats(true);
    api.getDbStats().then(setStats).catch(console.error).finally(() => setLoadingStats(false));
  }, []);

  async function doReset() {
    setResetStage("resetting");
    try {
      await api.resetDatabase();
    } catch (e) {
      console.error(e);
      setResetStage("idle");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Stats */}
      <section>
        <h3 className="mb-3 text-sm font-medium">Database</h3>
        {loadingStats ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <Loader2 size={13} className="animate-spin" /> Loading…
          </div>
        ) : stats ? (
          <div className="grid grid-cols-3 gap-2">
            {([
              ["Chats", stats.chats],
              ["Messages", stats.messages],
              ["Zones", stats.zones],
              ["Projects", stats.projects],
              ["Tags", stats.tags],
            ] as const).map(([label, count]) => (
              <div key={label} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-center">
                <div className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">{count}</div>
                <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{label}</div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* Reset */}
      <section>
        <h3 className="mb-1 text-sm font-medium">Reset</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Permanently deletes the database, all chats, zones, projects, tags, and attachments. The app will exit — on next launch everything starts fresh.
        </p>

        {resetStage === "idle" && (
          <button
            onClick={() => setResetStage("confirm")}
            className="flex items-center gap-2 rounded border border-[var(--color-danger)] px-4 py-2 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
          >
            <Trash2 size={14} />
            Reset to fresh install…
          </button>
        )}

        {resetStage === "confirm" && (
          <div className="rounded border border-[var(--color-danger)] bg-[var(--color-danger)]/5 p-4">
            <div className="mb-3 flex items-start gap-2 text-sm">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
              <div>
                <div className="font-medium text-[var(--color-danger)]">This cannot be undone.</div>
                <div className="mt-0.5 text-[var(--color-text-muted)]">
                  All chats, messages, zones, projects, tags, providers and attached files will be permanently deleted. The app will exit immediately after.
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setResetStage("idle")}
                className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
              >
                Cancel
              </button>
              <button
                onClick={doReset}
                className="rounded bg-[var(--color-danger)] px-3 py-1.5 text-sm text-white hover:opacity-90"
              >
                Yes, delete everything and exit
              </button>
            </div>
          </div>
        )}

        {resetStage === "resetting" && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 size={14} className="animate-spin" /> Deleting… the app will exit shortly.
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Shared components ────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`}
      />
    </button>
  );
}

function ProviderForm({ value, onClose, onSaved }: { value: Partial<Provider>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(value.name ?? "");
  const [baseUrl, setBaseUrl] = useState(value.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(value.apiKey ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSave() {
    if (!name.trim() || !baseUrl.trim()) return;
    setSaving(true);
    try {
      await api.upsertProvider({ id: value.id, name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || null });
      onSaved();
    } finally { setSaving(false); }
  }

  async function onDelete() {
    if (!value.id) return;
    await api.deleteProvider(value.id);
    onSaved();
  }

  async function onTest() {
    if (!value.id) { setTestResult("Save the provider first to test models."); return; }
    setTesting(true);
    setTestResult(null);
    try {
      const models = await api.fetchModels(value.id);
      setTestResult(`Found ${models.length} model${models.length === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setTestResult(`Error: ${e?.message || String(e)}`);
    } finally { setTesting(false); }
  }

  return (
    <div className="mt-4 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Ollama local" />
      </Field>
      <Field label="Base URL">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="input" placeholder="http://localhost:11434/v1" />
      </Field>
      <Field label="API key (optional)">
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" className="input" placeholder="sk-..." />
      </Field>
      {testResult && (
        <div className="my-2 rounded bg-[var(--color-panel)] p-2 text-xs text-[var(--color-text-muted)]">{testResult}</div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        {value.id && (
          <button onClick={onDelete} className="flex items-center gap-1 rounded border border-[var(--color-danger)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white">
            <Trash2 size={12} /> Delete
          </button>
        )}
        <button onClick={onTest} disabled={testing} className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] disabled:opacity-50">
          <RefreshCw size={12} className={testing ? "animate-spin" : ""} /> Test
        </button>
        <button onClick={onClose} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)]">
          Cancel
        </button>
        <button onClick={onSave} disabled={saving} className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          Save
        </button>
      </div>
      <style>{`.input { width: 100%; border: 1px solid var(--color-border); border-radius: 4px; padding: 6px 8px; background: var(--color-panel); font-size: 13px; } .input:focus { border-color: var(--color-accent); }`}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block">
      <div className="mb-1 text-xs text-[var(--color-text-muted)]">{label}</div>
      {children}
    </label>
  );
}
