import { useEffect, useState } from "react";
import { X, Plus, Trash2, Folder, FolderOpen, ToggleLeft } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import type { Project, Tag, Zone } from "@/lib/types";
import { ZONE_COLOR_PRESETS, getZoneIcon, ZONE_ICON_GROUPS, ZONE_ICONS } from "@/lib/zoneIcons";

export function ProjectsPanel() {
  const { zones, projects, tags, closeProjectsPanel, refreshProjects, refreshTags } = useApp();
  const [tab, setTab] = useState<"projects" | "tags">("projects");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeProjectsPanel}>
      <div className="flex h-[700px] w-[960px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex h-12 items-center justify-between border-b border-[var(--color-border)] px-4">
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
          <button onClick={closeProjectsPanel} className="rounded p-1 hover:bg-[var(--color-panel-hover)]">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {tab === "projects" ? (
            <ProjectsTab projects={projects} zones={zones} onSaved={refreshProjects} onDeleted={refreshProjects} />
          ) : (
            <TagsTab tags={tags} onSaved={refreshTags} onDeleted={refreshTags} />
          )}
        </div>
      </div>
      <style>{`.input { width: 100%; border: 1px solid var(--color-border); border-radius: 4px; padding: 6px 8px; background: var(--color-panel); font-size: 13px; } .input:focus { border-color: var(--color-accent); outline: none; }`}</style>
    </div>
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
  const [selectedId, setSelectedId] = useState<string | null>(initId ?? null);
  const [isNew, setIsNew] = useState(false);
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
  const [iconSearch, setIconSearch] = useState("");
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
    setIconSearch("");
  }, [project?.id]);

  async function pickDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setDirectory(selected);
  }

  const activeColor = accentColor ?? "var(--color-accent)";
  const PreviewIcon = getZoneIcon(icon);

  const filteredIcons = iconSearch.trim()
    ? ZONE_ICONS.filter((i) => i.label.toLowerCase().includes(iconSearch.toLowerCase()))
    : null;

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

        {/* Color */}
        <div className="mb-4">
          <div className="mb-1.5 text-xs text-[var(--color-text-muted)]">Color</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {ZONE_COLOR_PRESETS.map((c) => (
              <button
                key={c}
                onClick={() => setAccentColor(accentColor === c ? null : c)}
                className="h-6 w-6 rounded-full transition hover:scale-110"
                style={{ background: c, outline: accentColor === c ? `2px solid ${c}` : "2px solid transparent", outlineOffset: "2px" }}
                title={c}
              />
            ))}
            <div className="relative flex h-6 w-8 cursor-pointer items-center justify-center overflow-hidden rounded border border-[var(--color-border)] hover:border-[var(--color-accent)]">
              <input type="color" value={accentColor ?? "#4f9cf9"} onChange={(e) => setAccentColor(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
              <span className="pointer-events-none z-10 text-[9px] font-mono text-[var(--color-text-muted)]">{accentColor ? accentColor.slice(1, 4).toUpperCase() : "···"}</span>
            </div>
          </div>
        </div>

        {/* Icon picker */}
        <div className="mb-4">
          <div className="mb-1.5 text-xs text-[var(--color-text-muted)]">Icon</div>
          <input value={iconSearch} onChange={(e) => setIconSearch(e.target.value)} placeholder="Search icons…" className="input mb-2 text-xs" />
          <div className="max-h-36 overflow-y-auto rounded border border-[var(--color-border)] p-2">
            {filteredIcons !== null ? (
              <div className="grid grid-cols-10 gap-1">
                {filteredIcons.map(({ id: iid, icon: IC, label }) => (
                  <button key={iid} onClick={() => setIcon(iid === icon ? null : iid)} title={label}
                    className="flex items-center justify-center rounded p-1.5 transition"
                    style={icon === iid ? { background: activeColor } : undefined}
                  >
                    <IC size={14} color={icon === iid ? "white" : undefined} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {ZONE_ICON_GROUPS.map((group) => (
                  <div key={group.label}>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">{group.label}</div>
                    <div className="grid grid-cols-10 gap-1">
                      {group.icons.map(({ id: iid, icon: IC, label }) => (
                        <button key={iid} onClick={() => setIcon(iid === icon ? null : iid)} title={label}
                          className="flex items-center justify-center rounded p-1.5 transition"
                          style={icon === iid ? { background: activeColor } : undefined}
                        >
                          <IC size={14} color={icon === iid ? "white" : undefined} />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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
          <div className="mb-1.5 text-xs text-[var(--color-text-muted)]">Color</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {ZONE_COLOR_PRESETS.map((c) => (
              <button key={c} onClick={() => setColor(color === c ? null : c)}
                className="h-6 w-6 rounded-full transition hover:scale-110"
                style={{ background: c, outline: color === c ? `2px solid ${c}` : "2px solid transparent", outlineOffset: "2px" }}
                title={c}
              />
            ))}
            <div className="relative flex h-6 w-8 cursor-pointer items-center justify-center overflow-hidden rounded border border-[var(--color-border)]">
              <input type="color" value={color ?? "#4f9cf9"} onChange={(e) => setColor(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
              <span className="pointer-events-none z-10 text-[9px] font-mono text-[var(--color-text-muted)]">{color ? color.slice(1, 4).toUpperCase() : "···"}</span>
            </div>
          </div>
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
