import { useEffect, useState } from "react";
import { X, Plus, Trash2, Folder, FolderOpen, Database, RefreshCw, FileText, Loader2, AlertTriangle } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import * as api from "@/lib/tauri";
import type { IndexSummary, KbDocument, KnowledgeStatus, Project, Tag, Zone } from "@/lib/types";
import { getZoneIcon } from "@/lib/zoneIcons";
import { IconPicker } from "@/components/common/IconPicker";
import { ColorPicker } from "@/components/common/ColorPicker";
import { Modal } from "@/components/common/Modal";
import { PRIMARY_ACTION } from "@/lib/chrome";

export function ProjectsPanel() {
  const { zones, projects, tags, closeProjectsPanel, refreshProjects, refreshTags } = useApp(
    useShallow((s) => ({
      zones: s.zones,
      projects: s.projects,
      tags: s.tags,
      closeProjectsPanel: s.closeProjectsPanel,
      refreshProjects: s.refreshProjects,
      refreshTags: s.refreshTags,
    })),
  );
  const [tab, setTab] = useState<"projects" | "tags">("projects");

  return (
    <Modal
      onClose={closeProjectsPanel}
      header={
        <div className="flex items-center gap-1">
          {(["projects", "tags"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1.5 text-sm capitalize transition ${
                tab === t
                  ? "bg-[var(--color-panel-hover)] font-medium text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      }
    >
      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {tab === "projects" ? (
          <ProjectsTab projects={projects} zones={zones} onSaved={refreshProjects} onDeleted={refreshProjects} />
        ) : (
          <TagsTab tags={tags} onSaved={refreshTags} onDeleted={refreshTags} />
        )}
      </div>
      <style>{`.input { width: 100%; border: 1px solid var(--color-border); border-radius: 4px; padding: 6px 8px; background: var(--color-panel); font-size: 13px; } .input:focus { border-color: var(--color-accent); outline: none; }`}</style>
    </Modal>
  );
}

// ─── Projects tab ─────────────────────────────────────────────────────────────

function ProjectsTab({
  projects,
  zones,
  onSaved,
  onDeleted,
}: {
  projects: Project[];
  zones: Zone[];
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const initId = useApp((s) => s.projectsPanelInitId);
  const closeProjectsPanel = useApp((s) => s.closeProjectsPanel);
  // The sidebar's "New project" button opens the panel with the "__new__"
  // sentinel so we land straight in the create form.
  const initNew = initId === "__new__";
  const [selectedId, setSelectedId] = useState<string | null>(initNew ? null : initId ?? null);
  const [isNew, setIsNew] = useState(initNew);
  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const showForm = isNew || selectedId !== null;

  async function onSaveProject(_saved: Project) {
    await onSaved();
    closeProjectsPanel();
  }

  async function onDeleteProject() {
    await onDeleted();
    setSelectedId(null);
    setIsNew(false);
  }

  return (
    <>
      {/* Left list */}
      <div className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)]">
        <div className="border-b border-[var(--color-border)] p-2">
          <button
            onClick={() => { setSelectedId(null); setIsNew(true); }}
            className={`flex w-full items-center justify-center gap-1.5 rounded border border-dashed py-2 text-xs transition ${
              isNew
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            }`}
          >
            <Plus size={12} /> New Project
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {projects.length === 0 && (
            <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">No projects yet.</div>
          )}
          {projects.map((p) => {
            const isSelected = p.id === selectedId && !isNew;
            const Icon = getZoneIcon(p.icon);
            const color = p.accentColor ?? "var(--color-accent)";
            return (
              <div
                key={p.id}
                onClick={() => { setSelectedId(p.id); setIsNew(false); }}
                className={`flex cursor-pointer items-center gap-2 px-2 py-2 transition ${
                  isSelected ? "bg-[var(--color-panel-hover)]" : "hover:bg-[var(--color-panel-hover)]"
                }`}
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded" style={{ background: color }}>
                  <Icon size={13} color="white" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right form */}
      <div className="flex min-w-0 flex-1 flex-col">
        {showForm ? (
          <ProjectForm
            project={isNew ? null : selected}
            zones={zones}
            onSaved={onSaveProject}
            onDeleted={onDeleteProject}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[var(--color-text-muted)]">
            <div className="text-sm">Select a project to edit, or create a new one.</div>
          </div>
        )}
      </div>
    </>
  );
}

function ProjectForm({
  project,
  zones,
  onSaved,
  onDeleted,
}: {
  project: Project | null;
  zones: Zone[];
  onSaved: (p: Project) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [accentColor, setAccentColor] = useState<string | null>(null);
  const [defaultZoneId, setDefaultZoneId] = useState<string | null>(null);
  const [contextSnippet, setContextSnippet] = useState("");
  const [directory, setDirectory] = useState<string | null>(null);
  const [defaultContextEnabled, setDefaultContextEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setIcon(project.icon ?? null);
      setAccentColor(project.accentColor ?? null);
      setDefaultZoneId(project.defaultZoneId ?? null);
      setContextSnippet(project.contextSnippet ?? "");
      setDirectory(project.directory ?? null);
      setDefaultContextEnabled(project.defaultContextEnabled ?? false);
    } else {
      setName(""); setIcon(null); setAccentColor(null);
      setDefaultZoneId(null); setContextSnippet(""); setDirectory(null);
      setDefaultContextEnabled(false);
    }
  }, [project?.id]);

  async function pickDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setDirectory(selected);
  }

  const activeColor = accentColor ?? "var(--color-accent)";
  const PreviewIcon = getZoneIcon(icon);

  async function onSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const saved = await api.upsertProject({
        id: project?.id,
        name: name.trim(),
        icon,
        accentColor,
        defaultZoneId,
        contextSnippet: contextSnippet.trim() || null,
        directory: directory || null,
        defaultContextEnabled,
      });
      onSaved(saved);
    } finally { setSaving(false); }
  }

  async function onDelete() {
    if (!project) return;
    await api.deleteProject(project.id);
    onDeleted();
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4">
        {/* Name + icon preview */}
        <div className="mb-3 flex items-end gap-3">
          <div className="flex-1">
            <label className="mb-3 block">
              <div className="mb-1 text-xs text-[var(--color-text-muted)]">Name</div>
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
            </label>
          </div>
          <div className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg shadow-sm" style={{ background: activeColor }}>
            <PreviewIcon size={18} color="white" />
          </div>
        </div>

        {/* Identity: the same side-by-side icon + colour pair the zone editor
            uses, from the same two controls. */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <IconPicker value={icon} onChange={setIcon} activeColor={activeColor} />
          <ColorPicker value={accentColor} onChange={setAccentColor} />
        </div>

        {/* Default zone */}
        <label className="mb-3 block">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">Default zone for new chats</div>
          <select value={defaultZoneId ?? ""} onChange={(e) => setDefaultZoneId(e.target.value || null)} className="input">
            <option value="">— inherit global default —</option>
            {zones.map((z: Zone) => <option key={z.id} value={z.id}>{z.name} · {z.model}</option>)}
          </select>
        </label>

        {/* Project directory */}
        <div className="mb-3">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">
            Project directory
            <span className="ml-2 font-normal opacity-60">(file_system tool reads run from here)</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={pickDirectory}
              className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
            >
              <FolderOpen size={13} /> Choose folder…
            </button>
            {directory ? (
              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5">
                <Folder size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                <span className="truncate font-mono text-xs" title={directory}>{directory}</span>
                <button
                  onClick={() => setDirectory(null)}
                  className="ml-auto shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  title="Clear directory"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <span className="text-xs text-[var(--color-text-muted)]">No directory set</span>
            )}
          </div>
        </div>

        {/* Context snippet */}
        <label className="mb-3 block">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">
            Context snippet
            <span className="ml-2 font-normal opacity-60">(prepended to system prompt when enabled per-chat)</span>
          </div>
          <textarea
            value={contextSnippet}
            onChange={(e) => setContextSnippet(e.target.value)}
            rows={5}
            className="input font-mono text-xs"
            placeholder="e.g. You are working in the context of the Work project. Always respond professionally."
          />
        </label>

        {/* Default context on */}
        <div
          onClick={() => setDefaultContextEnabled((v) => !v)}
          className="flex cursor-pointer items-center justify-between rounded border border-[var(--color-border)] px-3 py-2.5 hover:border-[var(--color-accent)]"
        >
          <div>
            <div className="text-sm font-medium">Enable context by default</div>
            <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              New chats in this project will start with the context snippet active
            </div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); setDefaultContextEnabled((v) => !v); }}
            className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${defaultContextEnabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
          >
            <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${defaultContextEnabled ? "translate-x-4" : ""}`} />
          </button>
        </div>

        {/* Knowledge (RAG) — only for saved projects, since indexing needs a
            persisted project id + directory. */}
        {project ? (
          <KnowledgeSection project={project} />
        ) : (
          <div className="mt-4 rounded border border-dashed border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-muted)]">
            <Database size={13} className="mb-1 inline" /> Knowledge (document search) can be set
            up here after you create the project and give it a directory.
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
        {project && (
          <button onClick={onDelete} className="flex items-center gap-1 rounded border border-[var(--color-danger)] px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white">
            <Trash2 size={12} /> Delete
          </button>
        )}
        <button onClick={onSave} disabled={saving || !name.trim()} className="rounded px-3 py-1.5 text-xs text-white disabled:opacity-50" style={{ background: activeColor }}>
          {project ? "Save" : "Create project"}
        </button>
      </div>
    </>
  );
}

// ─── Knowledge (RAG) section ───────────────────────────────────────────────────

function KnowledgeSection({ project }: { project: Project }) {
  const providers = useApp((s) => s.providers);
  const refreshProjects = useApp((s) => s.refreshProjects);

  const [providerId, setProviderId] = useState<string | null>(project.kbProviderId);
  const [model, setModel] = useState(project.kbEmbeddingModel ?? "");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [showDocs, setShowDocs] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [summary, setSummary] = useState<IndexSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Saved config on the project; local state is "dirty" until applied.
  const savedProvider = project.kbProviderId;
  const savedModel = project.kbEmbeddingModel ?? "";
  const dirty = (providerId ?? null) !== (savedProvider ?? null) || model.trim() !== savedModel;
  const configured = !!savedProvider && !!savedModel;
  const hasDir = !!project.directory?.trim();

  async function reload() {
    try {
      const [st, ds] = await Promise.all([
        api.getKnowledgeStatus(project.id),
        api.listKnowledgeDocuments(project.id),
      ]);
      setStatus(st);
      setDocs(ds);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    setProviderId(project.kbProviderId);
    setModel(project.kbEmbeddingModel ?? "");
    setSummary(null);
    setError(null);
    reload();
    // Live auto re-index of this project's directory refreshes the panel.
    const un = api.onKnowledgeUpdated((e) => { if (e.scope === project.id) reload(); });
    return () => { un.then((f) => f()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Offer model suggestions from the provider's /models list (best-effort;
  // embedding model ids aren't always listed, so the field stays free-text).
  useEffect(() => {
    let cancelled = false;
    if (!providerId) { setModelOptions([]); return; }
    api.fetchModels(providerId)
      .then((m) => { if (!cancelled) setModelOptions(m); })
      .catch(() => { if (!cancelled) setModelOptions([]); });
    return () => { cancelled = true; };
  }, [providerId]);

  async function saveConfig() {
    setSavingCfg(true);
    setError(null);
    try {
      await api.setProjectKbConfig(project.id, providerId, model.trim() || null);
      await refreshProjects();
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
      const s = await api.indexProjectKnowledge(project.id);
      setSummary(s);
      await refreshProjects();
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setIndexing(false);
    }
  }

  async function clearAll() {
    if (!confirm("Remove the entire knowledge index for this project? The embedding settings are kept.")) return;
    await api.clearProjectKnowledge(project.id);
    await refreshProjects();
    await reload();
    setSummary(null);
  }

  async function removeDoc(id: string) {
    await api.removeKnowledgeDocument(id);
    await refreshProjects();
    await reload();
  }

  const indexed = !!project.kbIndexedAt;

  return (
    <div className="mt-4 rounded-lg border border-[var(--color-border)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <Database size={14} className="text-[var(--color-accent)]" />
        <span className="text-sm font-medium">Knowledge (document search)</span>
      </div>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        Index this project's directory so zones can search it during a chat (the{" "}
        <code className="rounded bg-[var(--color-bg)] px-1">search_local_files</code> tool). Pick an
        embedding model from one of your providers — for a local model, add Ollama as a provider and
        choose an embedding model such as <code className="rounded bg-[var(--color-bg)] px-1">nomic-embed-text</code>.
      </p>

      {/* Embedding provider + model */}
      <div className="mb-2 grid grid-cols-2 gap-2">
        <label className="block">
          <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">Embedding provider</div>
          <select
            value={providerId ?? ""}
            onChange={(e) => setProviderId(e.target.value || null)}
            className="input"
          >
            <option value="">— none —</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="block">
          <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">Embedding model</div>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            list={`kb-models-${project.id}`}
            placeholder="e.g. text-embedding-3-small"
            className="input"
            disabled={!providerId}
          />
          <datalist id={`kb-models-${project.id}`}>
            {modelOptions.map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
      </div>

      {dirty && (
        <div className="mb-2 flex items-start gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-500" />
          <span>
            {indexed
              ? "Changing the embedding model rebuilds the index from scratch (different vector space). Saving clears the current index — re-index afterwards."
              : "Save the embedding settings, then index the directory."}
          </span>
        </div>
      )}

      <div className="mb-3 flex items-center gap-2">
        {dirty && (
          <button
            onClick={saveConfig}
            disabled={savingCfg}
            className={`rounded px-2.5 py-1 text-xs ${PRIMARY_ACTION}`}
          >
            {savingCfg ? "Saving…" : "Save settings"}
          </button>
        )}
        <button
          onClick={runIndex}
          disabled={indexing || !configured || dirty || !hasDir}
          title={
            !hasDir ? "Set and save a project directory first."
              : !configured ? "Choose and save an embedding provider + model first."
              : dirty ? "Save the embedding settings first."
              : "Walk the directory and (re)build the index."
          }
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1 text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
        >
          {indexing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {indexing ? "Indexing…" : indexed ? "Re-index" : "Index directory"}
        </button>
        {status && status.documentCount > 0 && (
          <button
            onClick={clearAll}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
          >
            <Trash2 size={11} /> Clear
          </button>
        )}
      </div>

      {!hasDir && (
        <div className="mb-2 text-[11px] italic text-[var(--color-text-muted)]">
          This project has no directory set — choose one above and save the project first.
        </div>
      )}

      {/* Status line */}
      {status && (
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">
          {status.documentCount > 0 ? (
            <>
              {status.documentCount} document{status.documentCount === 1 ? "" : "s"} ·{" "}
              {status.chunkCount} chunk{status.chunkCount === 1 ? "" : "s"}
              {project.kbDimensions ? ` · ${project.kbDimensions}-dim` : ""}
              {project.kbIndexedAt ? ` · indexed ${new Date(project.kbIndexedAt).toLocaleString()}` : ""}
            </>
          ) : (
            <>Not indexed yet.</>
          )}
        </div>
      )}

      {/* Last run summary */}
      {summary && (
        <div className="mb-2 text-[11px] text-[var(--color-text-muted)]">
          Indexed {summary.indexed}, unchanged {summary.unchanged}, removed {summary.removed}
          {summary.failed > 0 ? `, failed ${summary.failed}` : ""} · {summary.totalChunks} new chunks.
          {summary.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-[var(--color-danger)]">
              {summary.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      {error && <div className="mb-2 text-[11px] text-[var(--color-danger)]">{error}</div>}

      {/* Document viewer */}
      {docs.length > 0 && (
        <div>
          <button
            onClick={() => setShowDocs((v) => !v)}
            className="text-[11px] text-[var(--color-accent)] hover:underline"
          >
            {showDocs ? "Hide" : "Show"} indexed documents ({docs.length})
          </button>
          {showDocs && (
            <div className="mt-1 max-h-44 overflow-y-auto rounded border border-[var(--color-border)]">
              {docs.map((d) => (
                <div
                  key={d.id}
                  className="group flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 last:border-b-0"
                >
                  <FileText size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={d.path}>{d.path}</span>
                  {d.status === "error" ? (
                    <span className="shrink-0 text-[10px] text-[var(--color-danger)]" title={d.error ?? ""}>error</span>
                  ) : (
                    <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{d.chunkCount} ch.</span>
                  )}
                  <button
                    onClick={() => removeDoc(d.id)}
                    className="shrink-0 text-[var(--color-text-muted)] opacity-0 transition hover:text-[var(--color-danger)] group-hover:opacity-100"
                    title="Remove from index"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Per-project default for knowledge in new chats. */}
      <div className="mt-3 border-t border-[var(--color-border)] pt-3">
        <label className="flex items-center justify-between gap-2 text-xs">
          <span className="text-[var(--color-text-muted)]">Knowledge in new chats</span>
          <select
            value={project.kbDefaultEnabled === null ? "inherit" : project.kbDefaultEnabled ? "on" : "off"}
            onChange={async (e) => {
              const v = e.target.value;
              await api.setProjectKbDefault(project.id, v === "inherit" ? null : v === "on");
              await refreshProjects();
            }}
            className="input w-32"
          >
            <option value="inherit">Use global default</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
          Whether chats in this project start with the <code className="rounded bg-[var(--color-bg)] px-1">search_local_files</code> tool available from the first message.
        </div>
      </div>
    </div>
  );
}

// ─── Tags tab ─────────────────────────────────────────────────────────────────

function TagsTab({
  tags,
  onSaved,
  onDeleted,
}: {
  tags: Tag[];
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const closeProjectsPanel = useApp((s) => s.closeProjectsPanel);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const selected = tags.find((t) => t.id === selectedId) ?? null;
  const showForm = isNew || selectedId !== null;

  async function onSaveTag(_saved: Tag) { await onSaved(); closeProjectsPanel(); }
  async function onDeleteTag() { await onDeleted(); setSelectedId(null); setIsNew(false); }

  return (
    <>
      <div className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)]">
        <div className="border-b border-[var(--color-border)] p-2">
          <button
            onClick={() => { setSelectedId(null); setIsNew(true); }}
            className={`flex w-full items-center justify-center gap-1.5 rounded border border-dashed py-2 text-xs transition ${
              isNew ? "border-[var(--color-accent)] text-[var(--color-accent)]" : "border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            }`}
          >
            <Plus size={12} /> New Tag
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {tags.length === 0 && <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">No tags yet.</div>}
          {tags.map((t) => {
            const isSelected = t.id === selectedId && !isNew;
            return (
              <div
                key={t.id}
                onClick={() => { setSelectedId(t.id); setIsNew(false); }}
                className={`flex cursor-pointer items-center gap-2 px-2 py-2 transition ${isSelected ? "bg-[var(--color-panel-hover)]" : "hover:bg-[var(--color-panel-hover)]"}`}
              >
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: t.color ?? "var(--color-text-muted)" }} />
                <span className="truncate text-sm">{t.name}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {showForm ? (
          <TagForm tag={isNew ? null : selected} onSaved={onSaveTag} onDeleted={onDeleteTag} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">
            Select a tag to edit, or create a new one.
          </div>
        )}
      </div>
    </>
  );
}

function TagForm({
  tag,
  onSaved,
  onDeleted,
}: {
  tag: Tag | null;
  onSaved: (t: Tag) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [contextSnippet, setContextSnippet] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tag) { setName(tag.name); setColor(tag.color ?? null); setContextSnippet(tag.contextSnippet ?? ""); }
    else { setName(""); setColor(null); setContextSnippet(""); }
  }, [tag?.id]);

  async function onSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const saved = await api.upsertTag({ id: tag?.id, name: name.trim(), color, contextSnippet: contextSnippet.trim() || null });
      onSaved(saved);
    } finally { setSaving(false); }
  }

  async function onDelete() {
    if (!tag) return;
    await api.deleteTag(tag.id);
    onDeleted();
  }

  const activeColor = color ?? "var(--color-accent)";

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4">
        <label className="mb-3 block">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">Name</div>
          <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
        </label>

        <div className="mb-4">
          <ColorPicker value={color} onChange={setColor} clearLabel="Use default" />
        </div>

        <label className="mb-3 block">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">
            Context snippet
            <span className="ml-2 font-normal opacity-60">(injected when enabled on a chat)</span>
          </div>
          <textarea value={contextSnippet} onChange={(e) => setContextSnippet(e.target.value)} rows={6}
            className="input font-mono text-xs"
            placeholder="e.g. This conversation relates to legal matters. Always include appropriate disclaimers."
          />
        </label>
      </div>

      <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
        {tag && (
          <button onClick={onDelete} className="flex items-center gap-1 rounded border border-[var(--color-danger)] px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white">
            <Trash2 size={12} /> Delete
          </button>
        )}
        <button onClick={onSave} disabled={saving || !name.trim()} className="rounded px-3 py-1.5 text-xs text-white disabled:opacity-50" style={{ background: activeColor }}>
          {tag ? "Save" : "Create tag"}
        </button>
      </div>
    </>
  );
}
