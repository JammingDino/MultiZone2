import { useEffect, useMemo, useState } from "react";
import { Plus, Settings, Layers, ChevronRight, ChevronDown, FolderPlus, ChevronLeft, Pencil, Trash2, Tag as TagIcon, X, Sparkles } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { ChatList } from "./ChatList";
import { getZoneIcon } from "@/lib/zoneIcons";
import type { Project } from "@/lib/types";

export function Sidebar() {
  const {
    chats,
    zones,
    providers,
    projects,
    activeChatId,
    defaultZoneId,
    refreshChats,
    refreshZones,
    refreshProviders,
    refreshProjects,
    refreshTags,
    setActiveChat,
    openSettings,
    openZoneLibrary,
    openProjectsPanel,
    loadThemeFromBackend,
    loadDefaultZone,
    loadAppSettings,
  } = useApp();
  const triggerNewChat = useApp((s) => s.triggerNewChat);

  const defaultProviderId = useApp((s) => s.appSettings.defaultProviderId);
  const quickProvider = providers.find((p) => p.id === (defaultProviderId ?? providers[0]?.id)) ?? null;
  const quickAvailable = !!quickProvider?.defaultModel?.trim();
  // A new chat is possible if there's a zone to bind, or a usable Quick chat.
  const canNewChat = zones.length > 0 || quickAvailable;

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Project | null>(null);

  // Tag filtering: a chat matches when no filter is set, or it carries any of
  // the selected tags (union). Built from the flat chat↔tag link list.
  const tags = useApp((s) => s.tags);
  const chatTagLinks = useApp((s) => s.chatTagLinks);
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const tagIdsByChat = useMemo(() => {
    const m: Record<string, Set<string>> = {};
    for (const l of chatTagLinks) (m[l.chatId] ??= new Set()).add(l.tagId);
    return m;
  }, [chatTagLinks]);
  const matchesTagFilter = (chatId: string) =>
    tagFilter.size === 0 || [...tagFilter].some((tid) => tagIdsByChat[chatId]?.has(tid));
  function toggleTagFilter(tagId: string) {
    setTagFilter((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  useEffect(() => {
    refreshProviders();
    refreshZones();
    refreshChats();
    refreshProjects();
    refreshTags();
    loadThemeFromBackend();
    loadDefaultZone();
    loadAppSettings();
  }, [refreshProviders, refreshZones, refreshChats, refreshProjects, refreshTags,
      loadThemeFromBackend, loadDefaultZone, loadAppSettings]);

  async function onNewChat(projectId?: string) {
    triggerNewChat(projectId ?? null);
    await setActiveChat(null);
  }

  function openProjectMenu(e: React.MouseEvent, projectId: string) {
    e.preventDefault();
    e.stopPropagation();
    setProjectMenu({ projectId, x: e.clientX, y: e.clientY });
  }

  async function confirmDeleteProject(deleteChats: boolean) {
    if (!deleteConfirm) return;
    const project = deleteConfirm;
    setDeleteConfirm(null);
    await api.deleteProject(project.id, deleteChats);
    await refreshProjects();
    await refreshChats();
    // If the active chat lived in a deleted-with-chats project, it's gone now.
    if (deleteChats && activeChatId) {
      const stillExists = (await api.listChats()).some((c) => c.id === activeChatId);
      if (!stillExists) await setActiveChat(null);
    }
  }

  function toggleCollapse(projectId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  const ungroupedChats = chats.filter((c) => !c.projectId && matchesTagFilter(c.id));
  const filtering = tagFilter.size > 0;

  if (!sidebarOpen) {
    return (
      <aside className="flex h-full w-12 flex-shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
        {/* Expand button */}
        <div className="flex h-12 items-center justify-center border-b border-[var(--color-border)]">
          <button
            onClick={() => setSidebarOpen(true)}
            title="Expand sidebar"
            className="rounded p-1.5 hover:bg-[var(--color-panel-hover)]"
          >
            <ChevronRight size={16} className="text-[var(--color-accent)]" />
          </button>
        </div>

        {/* New chat icon */}
        <div className="flex flex-col items-center gap-1 p-1 pt-2">
          <button
            onClick={() => onNewChat()}
            disabled={!canNewChat}
            title={!canNewChat ? "Set a default model or create a zone first" : "New chat"}
            className="flex items-center justify-center rounded p-2 hover:bg-[var(--color-panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={16} />
          </button>
        </div>

        {/* Footer icons */}
        <div className="mt-auto border-t border-[var(--color-border)] p-1 flex flex-col items-center gap-1">
          <button
            onClick={openZoneLibrary}
            title="Configure Zones"
            className="rounded p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-accent)]"
          >
            <Layers size={15} />
          </button>
          <button
            onClick={() => openProjectsPanel()}
            title="Manage Projects"
            className="rounded p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-accent)]"
          >
            <FolderPlus size={15} />
          </button>
          <button
            onClick={openSettings}
            title="Settings"
            className="rounded p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-accent)]"
          >
            <Settings size={15} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-72 flex-shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex items-center gap-2 font-semibold">
          <Layers size={18} className="text-[var(--color-accent)]" />
          MultiZone
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={openSettings}
            className="rounded p-1.5 hover:bg-[var(--color-panel-hover)]"
            title="Settings"
          >
            <Settings size={16} />
          </button>
          <button
            onClick={() => setSidebarOpen(false)}
            className="rounded p-1.5 hover:bg-[var(--color-panel-hover)]"
            title="Collapse sidebar"
          >
            <ChevronLeft size={16} />
          </button>
        </div>
      </div>

      {/* New chat + New project */}
      <div className="m-2 flex gap-2">
        <button
          onClick={() => onNewChat()}
          disabled={!canNewChat}
          className="flex flex-1 items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-hover)] py-2 text-sm transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          title={!canNewChat ? "Set a default model or create a zone first" : "New chat"}
        >
          <Plus size={14} />
          New chat
        </button>
        <button
          onClick={() => openProjectsPanel("__new__")}
          className="flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 text-sm text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          title="New project"
        >
          <FolderPlus size={15} />
        </button>
      </div>

      {/* Tag filter bar */}
      {tags.length > 0 && (
        <div className="mx-2 mb-1 flex flex-wrap items-center gap-1">
          <TagIcon size={11} className="mr-0.5 shrink-0 text-[var(--color-text-muted)]" />
          {tags.map((t) => {
            const active = tagFilter.has(t.id);
            return (
              <button
                key={t.id}
                onClick={() => toggleTagFilter(t.id)}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition ${
                  active ? "text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
                style={
                  active
                    ? { background: t.color ?? "var(--color-accent)", borderColor: "transparent" }
                    : { borderColor: t.color ?? "var(--color-border)" }
                }
                title={active ? `Filtering by “${t.name}”` : `Filter by “${t.name}”`}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: active ? "white" : t.color ?? "var(--color-text-muted)" }}
                />
                {t.name}
              </button>
            );
          })}
          {filtering && (
            <button
              onClick={() => setTagFilter(new Set())}
              className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              title="Clear tag filter"
            >
              <X size={10} /> clear
            </button>
          )}
        </div>
      )}

      {/* Chat list with project folders */}
      <div className="flex-1 overflow-y-auto">
        {projects.map((project) => {
          const projectChats = chats.filter((c) => c.projectId === project.id && matchesTagFilter(c.id));
          // While a tag filter is active, hide projects with no matching chats.
          if (filtering && projectChats.length === 0) return null;
          const isOpen = !collapsed.has(project.id) || filtering;
          const color = project.accentColor ?? "var(--color-text-muted)";
          const ProjectIcon = getZoneIcon(project.icon);
          return (
            <div key={project.id}>
              <ProjectFolderHeader
                project={project}
                chatCount={projectChats.length}
                isOpen={isOpen}
                onToggle={() => toggleCollapse(project.id)}
                onNewChat={() => onNewChat(project.id)}
                onContextMenu={(e) => openProjectMenu(e, project.id)}
                color={color}
                ProjectIcon={ProjectIcon}
              />
              {isOpen && (
                <div className="pl-3">
                  <ChatList
                    chats={projectChats}
                    activeId={activeChatId}
                    onSelect={(id) => setActiveChat(id)}
                    projectId={project.id}
                  />
                </div>
              )}
            </div>
          );
        })}

        {ungroupedChats.length > 0 && (
          <>
            {projects.length > 0 && (
              <div className="mx-2 mb-0.5 mt-2 px-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Ungrouped
              </div>
            )}
            <ChatList
              chats={ungroupedChats}
              activeId={activeChatId}
              onSelect={(id) => setActiveChat(id)}
              projectId={null}
            />
          </>
        )}

        {chats.length === 0 && projects.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-[var(--color-text-muted)]">
            No chats yet
          </div>
        )}

        {filtering && !chats.some((c) => matchesTagFilter(c.id)) && (
          <div className="px-3 py-8 text-center text-xs text-[var(--color-text-muted)]">
            No chats match this tag filter.
          </div>
        )}
      </div>

      {/* Project right-click menu */}
      {projectMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setProjectMenu(null)} onContextMenu={(e) => { e.preventDefault(); setProjectMenu(null); }} />
          <div
            className="fixed z-50 min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
            style={{ left: projectMenu.x, top: projectMenu.y }}
          >
            <button
              onClick={() => { setProjectMenu(null); onNewChat(projectMenu.projectId); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
            >
              <Plus size={14} /> New chat
            </button>
            <button
              onClick={() => { const id = projectMenu.projectId; setProjectMenu(null); openProjectsPanel(id); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
            >
              <Pencil size={14} /> Edit project
            </button>
            <div className="my-0.5 border-t border-[var(--color-border)]" />
            <button
              onClick={() => {
                const project = projects.find((p) => p.id === projectMenu.projectId) ?? null;
                setProjectMenu(null);
                setDeleteConfirm(project);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-danger)] hover:bg-[var(--color-panel-hover)]"
            >
              <Trash2 size={14} /> Delete project
            </button>
          </div>
        </>
      )}

      {/* Delete-project confirmation: keep chats (move to Ungrouped) or delete all */}
      {deleteConfirm && (
        <DeleteProjectDialog
          project={deleteConfirm}
          chatCount={chats.filter((c) => c.projectId === deleteConfirm.id).length}
          onKeepChats={() => confirmDeleteProject(false)}
          onDeleteChats={() => confirmDeleteProject(true)}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {/* Footer buttons */}
      <div className="border-t border-[var(--color-border)] p-2 flex flex-col gap-1">
        <button
          onClick={openZoneLibrary}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-[var(--color-border)] py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Layers size={13} />
          Configure Zones
        </button>
        <button
          onClick={() => openProjectsPanel()}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-[var(--color-border)] py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <FolderPlus size={13} />
          Manage Projects
        </button>
      </div>
    </aside>
  );
}

function ProjectFolderHeader({
  project,
  chatCount,
  isOpen,
  onToggle,
  onNewChat,
  onContextMenu,
  color,
  ProjectIcon,
}: {
  project: Project;
  chatCount: number;
  isOpen: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  color: string;
  ProjectIcon: React.ComponentType<{ size?: number; color?: string }>;
}) {
  return (
    <div className="group mx-1 flex items-center gap-1 rounded px-1 py-1" onContextMenu={onContextMenu}>
      <button
        onClick={onToggle}
        onContextMenu={onContextMenu}
        className="flex flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
      >
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
          style={{ background: color }}
        >
          <ProjectIcon size={10} color="white" />
        </span>
        <span className="flex-1 truncate text-left">{project.name}</span>
        {chatCount > 0 && (
          <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
            {chatCount}
          </span>
        )}
      </button>
      <button
        onClick={onNewChat}
        title="New chat in this project"
        className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-accent)]"
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

function DeleteProjectDialog({
  project,
  chatCount,
  onKeepChats,
  onDeleteChats,
  onCancel,
}: {
  project: Project;
  chatCount: number;
  onKeepChats: () => void;
  onDeleteChats: () => void;
  onCancel: () => void;
}) {
  const chatLabel = `${chatCount} chat${chatCount === 1 ? "" : "s"}`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="w-[380px] rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-sm font-medium">Delete “{project.name}”?</div>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          {chatCount === 0
            ? "This project has no chats."
            : `This project has ${chatLabel}. Choose what to do with them.`}
        </p>
        <div className="flex flex-col gap-2">
          {chatCount > 0 && (
            <button
              onClick={onKeepChats}
              className="flex flex-col items-start rounded border border-[var(--color-border)] px-3 py-2 text-left transition hover:border-[var(--color-accent)]"
            >
              <span className="text-sm">Keep {chatLabel}</span>
              <span className="text-xs text-[var(--color-text-muted)]">Move them to Ungrouped</span>
            </button>
          )}
          <button
            onClick={onDeleteChats}
            className="flex flex-col items-start rounded border border-[var(--color-danger)]/50 px-3 py-2 text-left text-[var(--color-danger)] transition hover:bg-[var(--color-danger)]/10"
          >
            <span className="text-sm">
              {chatCount > 0 ? `Delete project and ${chatLabel}` : "Delete project"}
            </span>
            {chatCount > 0 && (
              <span className="text-xs opacity-80">Permanently removes the chats and their messages</span>
            )}
          </button>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
