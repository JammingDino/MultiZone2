import { useEffect, useState } from "react";
import { Plus, Settings, Layers, ChevronRight, ChevronDown, FolderPlus, ChevronLeft, Pencil, Trash2 } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { ChatList } from "./ChatList";
import { getZoneIcon } from "@/lib/zoneIcons";
import type { Project } from "@/lib/types";

export function Sidebar() {
  const {
    chats,
    zones,
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
    openZonesPanel,
    openProjectsPanel,
    loadThemeFromBackend,
    loadDefaultZone,
    loadAppSettings,
  } = useApp();

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);

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
    const hasZone = (id: string | null | undefined): id is string =>
      !!id && zones.some((z) => z.id === id);
    const project = projectId ? projects.find((p) => p.id === projectId) : null;
    const effectiveZoneId =
      (hasZone(project?.defaultZoneId) ? project!.defaultZoneId : null) ??
      (hasZone(defaultZoneId) ? defaultZoneId : null) ??
      (zones[0]?.id ?? null);
    const chat = await api.createChat(effectiveZoneId, projectId ?? null);
    await refreshChats();
    await setActiveChat(chat.id);
  }

  function openProjectMenu(e: React.MouseEvent, projectId: string) {
    e.preventDefault();
    e.stopPropagation();
    setProjectMenu({ projectId, x: e.clientX, y: e.clientY });
  }

  async function deleteProjectFromMenu(projectId: string) {
    setProjectMenu(null);
    await api.deleteProject(projectId);
    await refreshProjects();
    await refreshChats();
  }

  function toggleCollapse(projectId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  const ungroupedChats = chats.filter((c) => !c.projectId);

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
            disabled={zones.length === 0}
            title={zones.length === 0 ? "Create a zone first" : "New chat"}
            className="flex items-center justify-center rounded p-2 hover:bg-[var(--color-panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={16} />
          </button>
        </div>

        {/* Footer icons */}
        <div className="mt-auto border-t border-[var(--color-border)] p-1 flex flex-col items-center gap-1">
          <button
            onClick={openZonesPanel}
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

      {/* New chat button */}
      <button
        onClick={() => onNewChat()}
        disabled={zones.length === 0}
        className="m-2 flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-hover)] py-2 text-sm transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        title={zones.length === 0 ? "Create a zone first" : "New chat"}
      >
        <Plus size={14} />
        New chat
      </button>

      {/* Chat list with project folders */}
      <div className="flex-1 overflow-y-auto">
        {projects.map((project) => {
          const projectChats = chats.filter((c) => c.projectId === project.id);
          const isOpen = !collapsed.has(project.id);
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
              <div className="mx-2 my-1 border-t border-[var(--color-border)]" />
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
              onClick={() => deleteProjectFromMenu(projectMenu.projectId)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-danger)] hover:bg-[var(--color-panel-hover)]"
            >
              <Trash2 size={14} /> Delete project
            </button>
          </div>
        </>
      )}

      {/* Footer buttons */}
      <div className="border-t border-[var(--color-border)] p-2 flex flex-col gap-1">
        <button
          onClick={openZonesPanel}
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
