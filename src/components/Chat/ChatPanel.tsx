import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Tag as TagIcon, X, Zap, Folder, FolderX, ChevronDown, SplitSquareHorizontal, Plus } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { MessageThread } from "./MessageThread";
import { InputBar, type InputBarHandle } from "./InputBar";
import { ZonePicker } from "./ZonePicker";
import { SettingsModal } from "@/components/Settings/SettingsModal";
import { ZoneEditor } from "@/components/Zones/ZoneEditor";
import { ZonesPanel } from "@/components/Zones/ZonesPanel";
import { ProjectsPanel } from "@/components/Projects/ProjectsPanel";
import { getZoneIcon } from "@/lib/zoneIcons";
import { AskUserCard } from "@/components/Message/StepBlock";

export function ChatPanel() {
  const {
    activeChatId,
    chats,
    zones,
    projects,
    tags,
    tagsByChat,
    chatZonesByChat,
    settingsOpen,
    zoneEditorOpen,
    zonesPanelOpen,
    projectsPanelOpen,
    applyStreamEvent,
    setChatTitle,
    refreshChats,
    refreshTags,
    loadChatTags,
    loadChatZones,
    setChatProject,
    toggleProjectContext,
    addChatTag,
    removeChatTag,
    toggleChatTagContext,
    addPerspectiveZone,
    removePerspectiveZone,
  } = useApp();

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const activeZone = activeChat ? zones.find((z) => z.id === activeChat.zoneId) : null;
  const messagesByChat = useApp((s) => s.messagesByChat);

  // Detect a pending ask_user that hasn't been answered yet.
  // Walk the tail of the message list: if the most recent non-user messages
  // include a tool result with rendered === "ask_user" before hitting a user
  // message, the question is still waiting.
  const pendingAskUser = useMemo(() => {
    if (!activeChatId) return null;
    const msgs = messagesByChat[activeChatId] ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "user") return null;
      if (m.role === "tool") {
        try {
          const parts = JSON.parse(m.content) as Array<{ type: string; text?: string }>;
          const textPart = parts.find((p) => p.type === "text");
          if (!textPart?.text) continue;
          const parsed = JSON.parse(textPart.text);
          if (parsed?.rendered === "ask_user" && parsed?.status === "waiting_for_user") {
            return { chatId: activeChatId, parsed };
          }
        } catch {}
      }
    }
    return null;
  }, [activeChatId, messagesByChat]);

  const inputRef = useRef<InputBarHandle>(null);
  const dragDepth = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);

  function hasFiles(e: React.DragEvent) {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function onDragEnter(e: React.DragEvent) {
    if (!activeChat || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragOver(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!activeChat || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: React.DragEvent) {
    if (!activeChat || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  }
  function onDrop(e: React.DragEvent) {
    if (!activeChat || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      inputRef.current?.addFiles(e.dataTransfer.files);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let unlistenStream: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;
    let unlistenTags: (() => void) | undefined;
    api.onStream((env) => {
      applyStreamEvent(env.chatId, env.event, env.perspectiveZoneId);
    }).then((u) => {
      if (cancelled) u();
      else unlistenStream = u;
    });
    api.onChatTitleUpdated(({ chatId, title }) => {
      setChatTitle(chatId, title);
      refreshChats();
    }).then((u) => {
      if (cancelled) u();
      else unlistenTitle = u;
    });
    api.onChatTagsUpdated(({ chatId }) => {
      // The model created/assigned a tag — refresh the global tag list and
      // this chat's tag chips so the strip updates live.
      refreshTags();
      loadChatTags(chatId);
    }).then((u) => {
      if (cancelled) u();
      else unlistenTags = u;
    });
    return () => {
      cancelled = true;
      unlistenStream?.();
      unlistenTitle?.();
      unlistenTags?.();
    };
  }, [applyStreamEvent, setChatTitle, refreshChats, refreshTags, loadChatTags]);

  return (
    <main
      className="relative flex h-full flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {activeChat ? (
        <>
          <header className="flex h-12 items-center gap-3 border-b border-[var(--color-border)] px-4">
            <div className="min-w-0 flex-1 truncate text-sm font-medium">{activeChat.title}</div>
            <PerspectiveZonePicker
              chatId={activeChat.id}
              primaryZoneId={activeChat.zoneId}
              perspectiveZones={chatZonesByChat[activeChat.id] ?? []}
              allZones={zones}
              onAdd={(zoneId) => addPerspectiveZone(activeChat.id, zoneId)}
              onRemove={(zoneId) => removePerspectiveZone(activeChat.id, zoneId)}
            />
            <ZonePicker chatId={activeChat.id} currentZoneId={activeChat.zoneId} />
          </header>

          {/* Project + tag strip — always available so you can set the chat's
              project and tags from one place. */}
          <ProjectTagStrip
            chatId={activeChat.id}
            projectId={activeChat.projectId}
            projectContextEnabled={activeChat.projectContextEnabled}
            projects={projects}
            chatTags={tagsByChat[activeChat.id] ?? []}
            allTags={tags}
            onSetProject={(projectId) => setChatProject(activeChat.id, projectId)}
            onToggleProjectContext={(e) => toggleProjectContext(activeChat.id, e)}
            onAddTag={(tagId) => addChatTag(activeChat.id, tagId)}
            onRemoveTag={(tagId) => removeChatTag(activeChat.id, tagId)}
            onToggleTagContext={(tagId, e) => toggleChatTagContext(activeChat.id, tagId, e)}
          />

          <MessageThread chatId={activeChat.id} />
          {pendingAskUser ? (
            <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
              <div className="mx-auto max-w-3xl">
                <AskUserCard
                  chatId={pendingAskUser.chatId}
                  questions={
                    pendingAskUser.parsed.mode === "multi" &&
                    Array.isArray(pendingAskUser.parsed.questions)
                      ? pendingAskUser.parsed.questions
                      : [
                          {
                            question: pendingAskUser.parsed.question ?? "",
                            options: Array.isArray(pendingAskUser.parsed.options)
                              ? pendingAskUser.parsed.options
                              : [],
                            allow_free_text: pendingAskUser.parsed.allow_free_text !== false,
                          },
                        ]
                  }
                />
              </div>
            </div>
          ) : (
            <InputBar chatId={activeChat.id} disabled={!activeZone} ref={inputRef} />
          )}
        </>
      ) : (
        <EmptyState />
      )}
      {isDragOver && activeChat && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[var(--color-bg)]/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-panel)]/80 px-10 py-8 text-sm text-[var(--color-text)]">
            <Upload size={28} className="text-[var(--color-accent)]" />
            <div>Drop files to attach</div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Images, PDFs, and text files supported
            </div>
          </div>
        </div>
      )}
      {settingsOpen && <SettingsModal />}
      {zoneEditorOpen && <ZoneEditor />}
      {zonesPanelOpen && <ZonesPanel />}
      {projectsPanelOpen && <ProjectsPanel />}
    </main>
  );
}

import type { ChatTagEntry, ChatZone, Project, Tag, Zone } from "@/lib/types";

function ProjectTagStrip({
  chatId,
  projectId,
  projectContextEnabled,
  projects,
  chatTags,
  allTags,
  onSetProject,
  onToggleProjectContext,
  onAddTag,
  onRemoveTag,
  onToggleTagContext,
}: {
  chatId: string;
  projectId: string | null;
  projectContextEnabled: boolean;
  projects: Project[];
  chatTags: ChatTagEntry[];
  allTags: Tag[];
  onSetProject: (projectId: string | null) => void;
  onToggleProjectContext: (enabled: boolean) => void;
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
  onToggleTagContext: (tagId: string, enabled: boolean) => void;
}) {
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const ProjectIcon = project ? getZoneIcon(project.icon) : null;
  const projectColor = project?.accentColor ?? "var(--color-accent)";
  const unassignedTags = allTags.filter((t) => !chatTags.some((ct) => ct.tagId === t.id));
  const projectHasSnippet = !!project?.contextSnippet?.trim();

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-1.5">
      {/* Project selector */}
      <div className="relative">
        <button
          onClick={() => setShowProjectPicker((v) => !v)}
          title="Set the project this chat belongs to"
          className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          {project ? (
            <>
              {ProjectIcon && (
                <span className="flex h-3.5 w-3.5 items-center justify-center rounded" style={{ background: projectColor }}>
                  <ProjectIcon size={9} color="white" />
                </span>
              )}
              {project.name}
            </>
          ) : (
            <>
              <Folder size={11} /> No project
            </>
          )}
          <ChevronDown size={11} />
        </button>
        {showProjectPicker && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setShowProjectPicker(false)} />
            <div className="absolute left-0 top-full z-40 mt-1 min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
              <button
                onClick={() => { onSetProject(null); setShowProjectPicker(false); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)] ${!project ? "text-[var(--color-accent)]" : ""}`}
              >
                <FolderX size={12} /> No project
              </button>
              <div className="my-1 border-t border-[var(--color-border)]" />
              {projects.length === 0 && (
                <div className="px-3 py-1.5 text-xs text-[var(--color-text-muted)]">No projects yet.</div>
              )}
              {projects.map((p) => {
                const Icon = getZoneIcon(p.icon);
                const c = p.accentColor ?? "var(--color-accent)";
                return (
                  <button
                    key={p.id}
                    onClick={() => { onSetProject(p.id); setShowProjectPicker(false); }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)] ${p.id === projectId ? "text-[var(--color-accent)]" : ""}`}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded" style={{ background: c }}>
                      <Icon size={10} color="white" />
                    </span>
                    {p.name}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Project context toggle (only meaningful when a project is set) */}
      {project && (
        <>
          <button
            onClick={() => onToggleProjectContext(!projectContextEnabled)}
            title={
              !projectHasSnippet
                ? "This project has no context snippet, so enabling does nothing. Add one in Manage Projects."
                : projectContextEnabled
                  ? "Project context ON — its snippet is added to the system prompt. Click to disable."
                  : "Project context OFF — click to enable and inject the project's snippet."
            }
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
              projectContextEnabled
                ? "border-transparent text-white"
                : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
            }`}
            style={projectContextEnabled ? { background: projectColor } : undefined}
          >
            <Zap size={9} />
            {projectContextEnabled ? "Context on" : "Context off"}
          </button>
          {projectContextEnabled && !projectHasSnippet && (
            <span className="text-[10px] italic text-[var(--color-text-muted)]">
              no context snippet set
            </span>
          )}
        </>
      )}

      <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

      {/* Tag chips */}
      {chatTags.map((ct) => (
        <div
          key={ct.tagId}
          className="group flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition"
          style={
            ct.contextEnabled
              ? { background: ct.color ?? "var(--color-accent)", borderColor: "transparent", color: "white" }
              : { borderColor: ct.color ?? "var(--color-border)" }
          }
        >
          <button
            onClick={() => onToggleTagContext(ct.tagId, !ct.contextEnabled)}
            title={ct.contextEnabled ? "Context ON — click to disable" : "Context OFF — click to enable"}
            className="flex items-center gap-1"
          >
            <span className="h-2 w-2 rounded-full" style={{ background: ct.contextEnabled ? "white" : (ct.color ?? "var(--color-text-muted)") }} />
            {ct.name}
          </button>
          <button
            onClick={() => onRemoveTag(ct.tagId)}
            className="ml-0.5 opacity-0 transition group-hover:opacity-70 hover:!opacity-100"
            title="Remove tag"
          >
            <X size={9} />
          </button>
        </div>
      ))}

      {/* Add tag */}
      {unassignedTags.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setShowTagPicker((v) => !v)}
            className="flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <TagIcon size={10} /> Add tag
          </button>
          {showTagPicker && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setShowTagPicker(false)} />
              <div className="absolute left-0 top-full z-40 mt-1 min-w-[160px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
                {unassignedTags.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { onAddTag(t.id); setShowTagPicker(false); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
                  >
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: t.color ?? "var(--color-text-muted)" }} />
                    {t.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {allTags.length === 0 && (
        <span className="text-[10px] italic text-[var(--color-text-muted)]">
          no tags yet — create them in Manage Projects
        </span>
      )}
    </div>
  );
}

function PerspectiveZonePicker({
  chatId,
  primaryZoneId,
  perspectiveZones,
  allZones,
  onAdd,
  onRemove,
}: {
  chatId: string;
  primaryZoneId: string | null;
  perspectiveZones: ChatZone[];
  allZones: Zone[];
  onAdd: (zoneId: string) => void;
  onRemove: (zoneId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const perspZoneIds = new Set(perspectiveZones.map((z) => z.zoneId));
  const addable = allZones.filter((z) => z.id !== primaryZoneId && !perspZoneIds.has(z.id));
  const count = perspectiveZones.length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Perspective zones — get responses from multiple zones simultaneously"
        className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition ${
          count > 0
            ? "border-[var(--color-accent)] text-[var(--color-accent)]"
            : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        }`}
      >
        <SplitSquareHorizontal size={12} />
        {count > 0 ? `${count} perspective${count > 1 ? "s" : ""}` : "Perspectives"}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 min-w-[220px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
            <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Active perspectives
            </div>
            {perspectiveZones.length === 0 && (
              <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
                No perspective zones yet.
              </div>
            )}
            {perspectiveZones.map((pz) => {
              const zone = allZones.find((z) => z.id === pz.zoneId);
              return (
                <div
                  key={pz.zoneId}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: zone?.accentColor ?? "var(--color-accent)" }}
                    />
                    <span className="truncate">{zone?.name ?? pz.zoneId}</span>
                  </div>
                  <button
                    onClick={() => onRemove(pz.zoneId)}
                    className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                    title="Remove perspective"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}

            {addable.length > 0 && (
              <>
                <div className="mx-2 my-1 border-t border-[var(--color-border)]" />
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Add perspective
                </div>
                {addable.map((z) => (
                  <button
                    key={z.id}
                    onClick={() => { onAdd(z.id); setOpen(false); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: z.accentColor ?? "var(--color-accent)" }}
                    />
                    <span className="flex-1 truncate">{z.name}</span>
                    <Plus size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  const { zones, openSettings, openZoneEditor } = useApp();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center text-[var(--color-text-muted)]">
      <div className="text-lg">Welcome to MultiZone</div>
      {zones.length === 0 ? (
        <>
          <div className="max-w-md text-sm">
            Add a provider in settings, then create a zone to start chatting.
          </div>
          <div className="flex gap-2">
            <button
              onClick={openSettings}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
            >
              Open settings
            </button>
            <button
              onClick={() => openZoneEditor(null)}
              className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--color-accent-hover)]"
            >
              Create zone
            </button>
          </div>
        </>
      ) : (
        <div className="text-sm">Select a chat or create a new one.</div>
      )}
    </div>
  );
}
