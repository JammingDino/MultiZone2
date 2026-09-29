import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Settings, Layers, Pencil, Trash2, Tag as TagIcon, Check, Search, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Popover, pointRect } from "@/components/common/Popover";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import * as api from "@/lib/tauri";
import { ChatList, Disclosure, SIDEBAR_ROW } from "./ChatList";
import { ChatSearch } from "./ChatSearch";
import { getZoneIcon } from "@/lib/zoneIcons";
import { usePersistentSet } from "@/lib/uiState";
import { resolveBaseModel } from "@/lib/baseZone";
import type { Project } from "@/lib/types";
import { CHROME_ACTIVE, CHROME_OUTLINED, CHROME_QUIET } from "@/lib/chrome";
import { ResizeHandle, usePanelWidth } from "@/components/common/ResizeHandle";
import { useIsNarrow } from "@/lib/useIsNarrow";

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
    refreshSkills,
    setActiveChat,
    openSettings,
    openZoneLibrary,
    openProjectsPanel,
    sidebarOpen,
    setSidebarOpen,
    loadThemeFromBackend,
    loadDefaultZone,
    loadAppSettings,
  } = useApp(
    useShallow((s) => ({
      chats: s.chats,
      zones: s.zones,
      providers: s.providers,
      projects: s.projects,
      activeChatId: s.activeChatId,
      defaultZoneId: s.defaultZoneId,
      refreshChats: s.refreshChats,
      refreshZones: s.refreshZones,
      refreshProviders: s.refreshProviders,
      refreshProjects: s.refreshProjects,
      refreshTags: s.refreshTags,
      refreshSkills: s.refreshSkills,
      setActiveChat: s.setActiveChat,
      openSettings: s.openSettings,
      openZoneLibrary: s.openZoneLibrary,
      openProjectsPanel: s.openProjectsPanel,
      sidebarOpen: s.sidebarOpen,
      setSidebarOpen: s.setSidebarOpen,
      loadThemeFromBackend: s.loadThemeFromBackend,
      loadDefaultZone: s.loadDefaultZone,
      loadAppSettings: s.loadAppSettings,
    })),
  );
  const triggerNewChat = useApp((s) => s.triggerNewChat);
  const focusChatSearch = useApp((s) => s.focusChatSearch);
  const tagBtnRef = useRef<HTMLButtonElement>(null);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  // Tool calls and the context panel name MCP servers, so the list is needed
  // from the start rather than only once Settings → MCP has been opened.
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);
  useEffect(() => { refreshMcpServers().catch(() => {}); }, [refreshMcpServers]);

  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  const quickAvailable = !!resolveBaseModel(providers, zones, baseZoneId);
  // A new chat is possible if there's a zone to bind, or a usable Quick chat.
  const canNewChat = zones.length > 0 || quickAvailable;

  // Which project folders are collapsed persists across sessions (ui.* key) so
  // the layout is restored. Sidebar open/closed now lives in the store (so a
  // global shortcut can toggle it) but persists under the same key.
  const collapsed = usePersistentSet("collapsedProjects");
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Project | null>(null);
  // While a message search is running its results take the chat list's place —
  // the question is "which chat was that in", so the answer belongs where the
  // chats normally are (0.15.0).
  const [searching, setSearching] = useState(false);

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
    refreshSkills();
    loadThemeFromBackend();
    loadDefaultZone();
    loadAppSettings();
  }, [refreshProviders, refreshZones, refreshChats, refreshProjects, refreshTags,
      refreshSkills, loadThemeFromBackend, loadDefaultZone, loadAppSettings]);

  // A preference can now be changed from outside this window — over the HTTP
  // API, or by a model calling `app_control`. Re-read the key that changed so
  // "switch to dark mode" is a thing that happens rather than a row in the
  // database the window learns about on its next restart.
  useEffect(() => {
    const unlisten = api.onSettingsUpdated(({ key }) => {
      if (api.isOwnSettingsEcho(key)) return;
      if (key === "theme") loadThemeFromBackend();
      else if (key === "app_settings") loadAppSettings();
      else if (key === "default_zone_id") loadDefaultZone();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [loadThemeFromBackend, loadAppSettings, loadDefaultZone]);

  // Same idea, one level up: any write through the API or `app_control` says
  // which route made it, and the lists that route could have changed re-fetch.
  // Settings rows are handled above, by key.
  useEffect(() => {
    const unlisten = api.onAppDataChanged(({ path }) => {
      if (path.startsWith("/api/zones") || path.startsWith("/api/zone-library")) refreshZones();
      else if (path.startsWith("/api/providers")) refreshProviders();
      else if (path.startsWith("/api/projects")) refreshProjects();
      else if (path.startsWith("/api/tags")) refreshTags();
      else if (path.startsWith("/api/skills")) refreshSkills();
      else if (path.startsWith("/api/mcp")) refreshMcpServers().catch(() => {});
      // A chat route can move a chat between projects or retag it, so the chat
      // list and its tag links both have to come back.
      else if (path.startsWith("/api/chats")) { refreshChats(); refreshTags(); }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [refreshZones, refreshProviders, refreshProjects, refreshTags, refreshSkills, refreshChats, refreshMcpServers]);

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
    // Closes the tabs of any chats that went with it (see `refreshChats`).
    await refreshChats();
  }

  const ungroupedChats = chats.filter((c) => !c.projectId && matchesTagFilter(c.id));
  const filtering = tagFilter.size > 0;

  // The expanded width is the user's (0.17.10). On a phone the sidebar is a
  // drawer capped by the viewport, so the handle is left out there.
  const narrow = useIsNarrow();
  const size = usePanelWidth("ui.sidebarWidth", 288, 200);

  // One footer for both states, so the collapsed rail and the open sidebar put
  // Zones and Settings in exactly the same place (0.18.1): collapsing hides
  // the labels and moves nothing.
  const footer = (
    <div className="mt-auto flex shrink-0 flex-col gap-0.5 border-t border-[var(--color-border)] p-2">
      <RailButton icon={<Layers size={16} />} label="Zones" open={sidebarOpen} onClick={() => openZoneLibrary()} />
      <RailButton icon={<Settings size={16} />} label="Settings" open={sidebarOpen} onClick={openSettings} />
    </div>
  );

  // Both states render this same <aside>, so React keeps one element and its
  // width animates each way (0.18.1). Closing used to snap: the rail dropped
  // the transition class, and a width change without one does not animate.
  const asideClass = `relative flex h-full flex-shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-panel)] ${
    size.dragging ? "" : "transition-[width] duration-200 ease-in-out"
  }`;

  if (!sidebarOpen) {
    return (
      <aside className={asideClass} style={{ width: 48 }}>
        <div className="flex h-12 w-full shrink-0 items-center border-b border-[var(--color-border)] pl-[9px]">
          <button onClick={() => setSidebarOpen(true)} title="Expand sidebar" className={`rounded-md p-1.5 ${CHROME_QUIET}`}>
            <PanelLeftOpen size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-2 p-2">
          <RailButton
            icon={<Plus size={16} />}
            label={canNewChat ? "New chat" : "Set a default model or create a zone first"}
            open={false}
            disabled={!canNewChat}
            onClick={() => onNewChat()}
          />
          <RailButton icon={<Search size={16} />} label="Search messages" open={false} onClick={focusChatSearch} />
        </div>
        {footer}
      </aside>
    );
  }

  // Every tag in one list, from a button beside the search box. The strip it
  // replaces scrolled sideways under a hidden scrollbar, so past the fourth tag
  // the rest were effectively unreachable.
  const tagButton = tags.length > 0 && (
    <>
      <button
        ref={tagBtnRef}
        onClick={() => setTagMenuOpen((v) => !v)}
        title={filtering ? `Filtering by ${tagFilter.size} tag${tagFilter.size === 1 ? "" : "s"}` : "Filter by tag"}
        className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
          filtering || tagMenuOpen ? CHROME_ACTIVE : CHROME_OUTLINED
        }`}
      >
        <TagIcon size={14} />
        {filtering && (
          <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-accent)] px-0.5 text-[9px] text-white">
            {tagFilter.size}
          </span>
        )}
      </button>
      <Popover
        open={tagMenuOpen}
        onClose={() => setTagMenuOpen(false)}
        anchorRef={tagBtnRef}
        zIndex={40}
        className="max-h-80 w-56 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
      >
        <div className="flex items-center justify-between px-3 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Filter by tag
          {filtering && (
            <button onClick={() => setTagFilter(new Set())} className="normal-case tracking-normal hover:text-[var(--color-text)]">
              Clear
            </button>
          )}
        </div>
        {tags.map((t) => (
          <button
            key={t.id}
            onClick={() => toggleTagFilter(t.id)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: t.color ?? "var(--color-text-muted)" }} />
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            {tagFilter.has(t.id) && <Check size={13} className="shrink-0 text-[var(--color-accent)]" />}
          </button>
        ))}
      </Popover>
    </>
  );

  return (
    <aside className={asideClass} style={{ width: narrow ? 288 : size.width }}>
      {!narrow && (
        <ResizeHandle
          side="right"
          width={size.width}
          onResize={size.set}
          onDragging={size.setDragging}
          onReset={size.reset}
          label="Resize sidebar"
        />
      )}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--color-border)] pl-4 pr-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Layers size={16} className="text-[var(--color-accent)]" />
          MultiZone
        </div>
        <button onClick={() => setSidebarOpen(false)} className={`rounded-md p-1.5 ${CHROME_QUIET}`} title="Collapse sidebar">
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* New chat and Search: the same height, the same outline, one above the
          other — the rail's two buttons in the same order. */}
      <div className="shrink-0 p-2 pb-2">
        <button
          onClick={() => onNewChat()}
          disabled={!canNewChat}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 text-sm text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          title={!canNewChat ? "Set a default model or create a zone first" : "New chat"}
        >
          <Plus size={15} />
          New chat
        </button>
      </div>

      <ChatSearch onActiveChange={setSearching} trailing={tagButton || undefined} />

      {/* Chat list with project folders. Hidden outright while a search is
          running — the results took its place rather than filtering it. */}
      <div className={`flex-1 overflow-y-auto px-2 pb-2 ${searching ? "hidden" : ""}`}>
        <SectionLabel
          label="Projects"
          action={
            <button onClick={() => openProjectsPanel("__new__")} title="New project" className={`rounded p-0.5 ${CHROME_QUIET}`}>
              <Plus size={13} />
            </button>
          }
        />
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
                onToggle={() => collapsed.toggle(project.id)}
                onNewChat={() => onNewChat(project.id)}
                onContextMenu={(e) => openProjectMenu(e, project.id)}
                color={color}
                ProjectIcon={ProjectIcon}
              />
              {/* A project shows its five latest chats; the rest are a click
                  away, so a busy project no longer pushes every other one off
                  the screen. */}
              {isOpen && projectChats.length > 0 && (
                <div className="pl-6">
                  <ChatList
                    chats={projectChats}
                    activeId={activeChatId}
                    onSelect={(id) => setActiveChat(id)}
                    projectId={project.id}
                    limit={filtering ? undefined : 5}
                  />
                </div>
              )}
            </div>
          );
        })}

        {ungroupedChats.length > 0 && (
          <>
            {projects.length > 0 && <SectionLabel label="Chats" />}
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

      {footer}

      {/* Project right-click menu */}
      {projectMenu && (
        <Popover
          open
          onClose={() => setProjectMenu(null)}
          anchorRect={pointRect(projectMenu.x, projectMenu.y)}
          zIndex={40}
          className="min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
        >
          <div>
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
        </Popover>
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
  // The same row as a chat (0.18.1) — height, size, trailing chevron — with
  // the project's swatch where a chat has nothing. `min-w-0` on the name so a
  // long one truncates instead of pushing the controls off the edge (#12).
  return (
    <div
      role="button"
      onClick={onToggle}
      onContextMenu={onContextMenu}
      className={`${SIDEBAR_ROW} font-medium text-[var(--color-text)] hover:bg-[var(--color-panel-hover)]`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded" style={{ background: color }}>
        <ProjectIcon size={10} color="white" />
      </span>
      <span className="min-w-0 flex-1 truncate" title={project.name}>
        {project.name}
      </span>
      {chatCount > 0 && (
        <span className="shrink-0 text-[11px] font-normal text-[var(--color-text-muted)] group-hover:hidden">{chatCount}</span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onNewChat(); }}
        title="New chat in this project"
        className={`hidden shrink-0 rounded p-0.5 group-hover:block ${CHROME_QUIET}`}
      >
        <Plus size={13} />
      </button>
      <span className="text-[var(--color-text-muted)]">
        <Disclosure open={isOpen} />
      </span>
    </div>
  );
}

/** A quiet heading over a part of the list, with an optional action on the right. */
function SectionLabel({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {label}
      {action}
    </div>
  );
}

/**
 * A rail or footer control. Open, it is an icon and a label; collapsed, the
 * same icon in the same place, with the label as its tooltip.
 */
function RailButton({
  icon, label, open, onClick, disabled,
}: {
  icon: React.ReactNode; label: string; open: boolean; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`flex h-8 shrink-0 items-center gap-2 rounded-md text-sm disabled:cursor-not-allowed disabled:opacity-50 ${CHROME_QUIET} ${
        open ? "w-full px-2" : "w-8 justify-center"
      }`}
    >
      {icon}
      {open && label}
    </button>
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
    <div className="mz-safe-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
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
