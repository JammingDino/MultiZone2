import { useEffect, useState } from "react";
import { RefreshCw, Loader2, Folder, FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import type { GlobalKbView, IndexSummary, KbDocument, Provider } from "@/lib/types";
import { PRIMARY_ACTION } from "@/lib/chrome";
import { ErrorNote } from "@/components/common/ErrorNote";
import { reportError } from "@/lib/reportError";

export function KnowledgeTab() {
  const providers = useApp((s) => s.providers);
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);

  const [kb, setKb] = useState<GlobalKbView | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [showDocs, setShowDocs] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [summary, setSummary] = useState<IndexSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savedProvider = kb?.providerId ?? null;
  const savedModel = kb?.embeddingModel ?? "";
  const dirty = (providerId ?? null) !== savedProvider || model.trim() !== savedModel;
  const configured = !!savedProvider && !!savedModel;
  const dir = appSettings.defaultDirectory?.trim();

  async function reload() {
    try {
      const view = await api.getGlobalKb();
      setKb(view);
      setProviderId(view.providerId);
      setModel(view.embeddingModel ?? "");
      setDocs(await api.listGlobalKbDocuments());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    reload().catch(reportError("Couldn't load the knowledge base"));
    const un = api.onKnowledgeUpdated(() => reload().catch(reportError("Couldn't load the knowledge base")));
    return () => { un.then((f) => f()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!providerId) { setModelOptions([]); return; }
    api.fetchModels(providerId)
      .then((m) => { if (!cancelled) setModelOptions(m); })
      .catch(() => { if (!cancelled) setModelOptions([]); });
    return () => { cancelled = true; };
  }, [providerId]);

  async function pickDir() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setAppSettings({ defaultDirectory: selected });
  }

  async function saveConfig() {
    setSavingCfg(true);
    setError(null);
    try {
      await api.setGlobalKbConfig(providerId, model.trim() || null);
      await reload();
      setSummary(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingCfg(false);
    }
  }

  async function runIndex() {
    setIndexing(true);
    setError(null);
    setSummary(null);
    try {
      setSummary(await api.indexGlobalKnowledge());
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setIndexing(false);
    }
  }

  async function clearAll() {
    if (!confirm("Remove the entire global knowledge index? The embedding settings are kept.")) return;
    await api.clearGlobalKnowledge();
    await reload();
    setSummary(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="mb-1 text-sm font-medium">Knowledge</h3>
        <p className="text-xs text-[var(--color-text-muted)]">New projects use this model. For a local one, add Ollama and pick <code className="rounded bg-[var(--color-bg)] px-1">nomic-embed-text</code>.</p>
      </section>

      {/* Default embedding provider + model */}
      <section>
        <div className="mb-1.5 text-xs font-medium">Default embedding model</div>
        <div className="grid grid-cols-2 narrow:grid-cols-1 gap-2">
          <label className="block">
            <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">Provider</div>
            <select value={providerId ?? ""} onChange={(e) => setProviderId(e.target.value || null)} className="input">
              <option value="">— none —</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="block">
            <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">Model</div>
            <ModelCombobox
              value={model}
              onChange={setModel}
              options={modelOptions}
              placeholder="e.g. text-embedding-3-small"
              className="input"
              disabled={!providerId}
            />
          </label>
        </div>
        {dirty && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">
            {/* Not a save button: applying this *discards* the existing index,
                because the vectors belong to the old model's space. It stays an
                explicit press for the same reason a delete does. */}
            <span>Applying this discards the global index — it has to be rebuilt.</span>
            <button onClick={saveConfig} disabled={savingCfg} className={`shrink-0 rounded px-2 py-1 ${PRIMARY_ACTION}`}>
              {savingCfg ? "Applying…" : "Apply & rebuild"}
            </button>
          </div>
        )}
      </section>

      {/* Default directory + global index */}
      <section>
        <div className="mb-1.5 text-xs font-medium">Global knowledge base</div>
        <div className="mb-2 flex items-center gap-2">
          {dir ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5">
              <FolderOpen size={13} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="truncate font-mono text-xs" title={dir}>{dir}</span>
            </div>
          ) : (
            <span className="flex-1 text-xs text-[var(--color-text-muted)]">No default directory set.</span>
          )}
          <button onClick={pickDir} className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
            <Folder size={12} /> {dir ? "Change" : "Choose"}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={runIndex}
            disabled={indexing || !configured || !dir || dirty}
            title={
              !dir ? "Choose a default directory first."
                : !configured ? "Set an embedding provider and model first."
                : dirty ? "Apply the embedding change first."
                : "Walk the default directory and (re)index it."
            }
            className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
          >
            {indexing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {indexing ? "Indexing…" : (kb && kb.documentCount > 0 ? "Re-index" : "Index directory")}
          </button>
          {kb && kb.documentCount > 0 && (
            <button onClick={clearAll} className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]">
              Clear index
            </button>
          )}
        </div>

        {kb && (
          <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            {kb.documentCount > 0
              ? <>{kb.documentCount} document{kb.documentCount === 1 ? "" : "s"} · {kb.chunkCount} chunk{kb.chunkCount === 1 ? "" : "s"}{kb.dimensions ? ` · ${kb.dimensions}-dim` : ""}{kb.indexedAt ? ` · indexed ${new Date(kb.indexedAt).toLocaleString()}` : ""}</>
              : "Not indexed yet."}
          </div>
        )}

        <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs">
          <button
            onClick={() => setAppSettings({ autoReindex: !appSettings.autoReindex })}
            className={`relative h-5 w-9 rounded-full transition-colors ${appSettings.autoReindex ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
          >
            <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${appSettings.autoReindex ? "translate-x-4" : ""}`} />
          </button>
          <span>Auto re-index — watch indexed directories and re-embed changed files automatically</span>
        </label>

        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
          <button
            onClick={() => setAppSettings({ knowledgeDefaultEnabled: !appSettings.knowledgeDefaultEnabled })}
            className={`relative h-5 w-9 rounded-full transition-colors ${appSettings.knowledgeDefaultEnabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
          >
            <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${appSettings.knowledgeDefaultEnabled ? "translate-x-4" : ""}`} />
          </button>
          <span>Enable knowledge in new chats by default — the <code className="rounded bg-[var(--color-bg)] px-1">search_local_files</code> tool is available from the first message (projects can override this)</span>
        </label>

        {summary && (
          <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[11px] text-[var(--color-text-muted)]">
            Indexed {summary.indexed}, unchanged {summary.unchanged}, removed {summary.removed}, failed {summary.failed}
            {summary.totalChunks ? ` · ${summary.totalChunks} new chunks` : ""}.
            {summary.errors.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-[var(--color-danger)]">
                {summary.errors.slice(0, 8).map((e, i) => <li key={i} className="truncate" title={e}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        {error && (
          <ErrorNote error={error} className="mt-2 rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500" />
        )}

        {docs.length > 0 && (
          <div className="mt-2">
            <button onClick={() => setShowDocs((v) => !v)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              {showDocs ? "Hide" : "Show"} indexed documents ({docs.length})
            </button>
            {showDocs && (
              <div className="mt-1.5 flex max-h-48 flex-col gap-1 overflow-y-auto">
                {docs.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px]">
                    <span className="truncate font-mono" title={d.path}>{d.path}</span>
                    <span className="shrink-0 text-[var(--color-text-muted)]">{d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Memory ─────────────────────────────────────────────────────────────────────
