import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Tag as TagIcon, X, Zap, Folder, FolderX, ChevronDown, ChevronRight, SplitSquareHorizontal, Plus, ShieldAlert, Eye, Database, History } from "lucide-react";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import * as api from "@/lib/tauri";
import { MessageThread } from "./MessageThread";
import { InputBar, type InputBarHandle } from "./InputBar";
import { ZonePicker } from "./ZonePicker";
import { ExportMenu } from "./ExportMenu";
import { ConversationIndicator } from "./ConversationIndicator";
import { ContextMeter } from "./ContextMeter";
import { ReviewQueue } from "./ReviewQueue";
import { DiffView } from "@/components/common/DiffView";
import { HomeScreen } from "./HomeScreen";
import { SettingsModal } from "@/components/Settings/SettingsModal";
import { ZoneLibrary } from "@/components/Zones/ZoneLibrary";
import { ProjectsPanel } from "@/components/Projects/ProjectsPanel";
import { getZoneIcon } from "@/lib/zoneIcons";
import { AskUserCard } from "@/components/Message/StepBlock";
import { PlanReview } from "@/components/Chat/PlanReview";
import { TaskPanel } from "@/components/Chat/TaskPanel";
import { ReplayView } from "@/components/Chat/ReplayView";
import { resolveBaseModel } from "@/lib/baseZone";
import { CHROME_ACTIVE, CHROME_OUTLINED, CHROME_QUIET, HEADER_ICON, PRIMARY_ACTION } from "@/lib/chrome";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { usePersistentBool } from "@/lib/uiState";
import type { FileDiff, StreamEnvelope } from "@/lib/types";

/** How long stream events are collected before being applied as one batch. */
const STREAM_DRAIN_MS = 16;

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
    zoneLibraryOpen,
    projectsPanelOpen,
    applyStreamEvent,
    setChatTitle,
    refreshChats,
    loadMessages,
    refreshTags,
    loadChatTags,
    loadChatZones,
    setChatProject,
    toggleProjectContext,
    toggleKnowledge,
    addChatTag,
    removeChatTag,
    toggleChatTagContext,
    addPerspectiveZone,
    removePerspectiveZone,
    setChatPerspectiveMode,
    respondApproval,
    openZoneEditor,
  } = useApp(
    useShallow((s) => ({
      activeChatId: s.activeChatId,
      chats: s.chats,
      zones: s.zones,
      projects: s.projects,
      tags: s.tags,
      tagsByChat: s.tagsByChat,
      chatZonesByChat: s.chatZonesByChat,
      settingsOpen: s.settingsOpen,
      zoneLibraryOpen: s.zoneLibraryOpen,
      projectsPanelOpen: s.projectsPanelOpen,
      applyStreamEvent: s.applyStreamEvent,
      setChatTitle: s.setChatTitle,
      refreshChats: s.refreshChats,
      loadMessages: s.loadMessages,
      refreshTags: s.refreshTags,
      loadChatTags: s.loadChatTags,
      loadChatZones: s.loadChatZones,
      setChatProject: s.setChatProject,
      toggleProjectContext: s.toggleProjectContext,
      toggleKnowledge: s.toggleKnowledge,
      addChatTag: s.addChatTag,
      removeChatTag: s.removeChatTag,
      toggleChatTagContext: s.toggleChatTagContext,
      addPerspectiveZone: s.addPerspectiveZone,
      removePerspectiveZone: s.removePerspectiveZone,
      setChatPerspectiveMode: s.setChatPerspectiveMode,
      respondApproval: s.respondApproval,
      openZoneEditor: s.openZoneEditor,
    })),
  );
  const globalPerspectiveMode = useApp((s) => s.appSettings.perspectiveMode);
  const providers = useApp((s) => s.providers);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);

  const pendingApprovalByChat = useApp((s) => s.pendingApprovalByChat);
  const setActiveChat = useApp((s) => s.setActiveChat);
  const routingByChat = useApp((s) => s.routingByChat);
  const stageImport = useApp((s) => s.stageImport);
  const pendingApprovals = activeChatId ? (pendingApprovalByChat[activeChatId] ?? []) : [];

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const activeZone = activeChat ? zones.find((z) => z.id === activeChat.zoneId) : null;

  // A subchat is a conversation another zone started. It used to be read-only
  // on the theory that it belongs to its owner, but that made the sub-agent's
  // work a dead end: the interesting finding is often *in* the subchat, and the
  // only way to follow it up was to go back to the leader and ask it to relay.
  // It is an ordinary chat bound to the answering zone, so it now takes messages
  // like any other — the banner names who else is driving it.
  const isSubchat = !!activeChat?.initiatedByZoneId;
  const subchatZone =
    isSubchat && activeChat
      ? zones.find((z) => z.id === activeChat.initiatedByZoneId) ?? null
      : null;

  // Approvals waiting in a chat the user is *not* looking at — almost always a
  // background sub-agent (0.9.10 let a leader fan out to a whole panel at once).
  // The store already holds them: the stream listener routes every event by its
  // own chat id, so a subchat's approval lands correctly whether or not it is on
  // screen. Nothing surfaced it, though, so the request sat until the ~5-minute
  // approval timeout auto-denied it and the sub-agent stalled with no visible
  // cause. Surfacing it here — in the leader's chat, where the user is actually
  // sitting while the panel works — is what closes that loop.
  const elsewhereApprovals = useMemo(() => {
    const out: { chatId: string; title: string; count: number }[] = [];
    for (const [cid, list] of Object.entries(pendingApprovalByChat)) {
      if (!list?.length || cid === activeChatId) continue;
      const chat = chats.find((c) => c.id === cid);
      if (!chat) continue;
      out.push({ chatId: cid, title: chat.title || "Untitled chat", count: list.length });
    }
    return out;
  }, [pendingApprovalByChat, activeChatId, chats]);

  // A chat with no zone (Quick) or smart routing enabled runs the base zone, or
  // the first provider's default model. Zone chats need their zone configured.
  const quickAvailable = !!resolveBaseModel(providers, zones, baseZoneId);
  const isSmartChat = !!activeChat?.smartRouting;
  const isSimpleChat = !!activeChat && activeChat.zoneId == null && !isSmartChat;
  const inputDisabled = isSmartChat || isSimpleChat ? !quickAvailable : !activeZone;
  const messagesByChat = useApp((s) => s.messagesByChat);

  // Detect a pending ask_user that hasn't been answered yet.
  // Walk the tail of the message list: if the most recent non-user messages
  // include a tool result with rendered === "ask_user" before hitting a user
  // message, the question is still waiting.
  const pendingAskUser = useMemo(() => {
    if (!activeChatId) return null;
    // Only the primary conversation surfaces an ask_user widget; perspective
    // tool messages (zone_id set) are ignored so they don't trip the scan.
    const msgs = (messagesByChat[activeChatId] ?? []).filter((m) => !m.zoneId);
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

  // The plan waiting on the user in this chat (0.12.0). Read from the store
  // rather than scanned out of the transcript like `ask_user` above: a plan
  // outlives the turn that filed it — close the chat, come back tomorrow, it is
  // still the thing standing between you and the work happening.
  const pendingPlan = useApp((s) => (activeChatId ? s.pendingPlanByChat[activeChatId] : null));
  const loadPendingPlan = useApp((s) => s.loadPendingPlan);
  const approvePlan = useApp((s) => s.approvePlan);
  const rejectPlan = useApp((s) => s.rejectPlan);
  const [planBusy, setPlanBusy] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  // Whether the project/tag strip is showing. Persisted per install rather than
  // per chat: someone who files every conversation wants the row up permanently,
  // and someone who never does should not have to close it again tomorrow.
  const [metaOpen, setMetaOpen] = usePersistentBool("chatMetaStrip", false);

  useEffect(() => {
    if (activeChatId) void loadPendingPlan(activeChatId);
  }, [activeChatId, loadPendingPlan]);

  // A turn that files a plan ends on that tool result, so the arrival of one in
  // the transcript is the signal to go and fetch the row it wrote.
  const planFiledMarker = useMemo(() => {
    if (!activeChatId) return null;
    const msgs = (messagesByChat[activeChatId] ?? []).filter((m) => !m.zoneId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "user") return null;
      if (m.role !== "tool") continue;
      try {
        const parts = JSON.parse(m.content) as Array<{ type: string; text?: string }>;
        const text = parts.find((p) => p.type === "text")?.text;
        if (!text) continue;
        const parsed = JSON.parse(text);
        if (parsed?.rendered === "plan_proposal" && parsed?.planId) return String(parsed.planId);
      } catch {}
    }
    return null;
  }, [activeChatId, messagesByChat]);

  useEffect(() => {
    if (activeChatId && planFiledMarker && pendingPlan?.id !== planFiledMarker) {
      void loadPendingPlan(activeChatId);
    }
  }, [activeChatId, planFiledMarker, pendingPlan?.id, loadPendingPlan]);

  // Live task state (0.12.1). The plan tree is reloaded when the transcript
  // grows a tool result, which is exactly when a step can have changed status —
  // cheaper and more truthful than polling, since `update_plan` writing the row
  // is the only thing that moves it.
  const loadPlanTree = useApp((s) => s.loadPlanTree);
  const isStreaming = useApp(
    (s) =>
      !!activeChatId &&
      (Boolean(s.streamingByChat[activeChatId]) ||
        Object.keys(s.perspectiveStreamsByChat[activeChatId] ?? {}).length > 0),
  );
  const toolResultCount = useMemo(() => {
    if (!activeChatId) return 0;
    return (messagesByChat[activeChatId] ?? []).filter((m) => m.role === "tool").length;
  }, [activeChatId, messagesByChat]);

  useEffect(() => {
    if (activeChatId) void loadPlanTree(activeChatId);
  }, [activeChatId, toolResultCount, loadPlanTree]);

  const inputRef = useRef<InputBarHandle>(null);
  const dragDepth = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);

  // Rendered inside whichever composer-row is showing (input, approval, or
  // ask-user) rather than as a strip of its own above them — see SubchatBanner.
  const subchatNotice = isSubchat ? <SubchatBanner zone={subchatZone} /> : null;

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
    // Copy out of the event before awaiting — `dataTransfer` is cleared once
    // the handler returns.
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    // A dropped settings export is an import, not an attachment.
    void claimSettingsDrop(files, stageImport).then((claimed) => {
      if (!claimed) inputRef.current?.addFiles(files);
    });
  }

  // Mirror the latest store actions in refs so the listener-setup effect below
  // can run exactly once (empty deps) without ever tearing down and
  // re-attaching the "stream" listener mid-session — a re-attach would open a
  // window between the old unlisten() and the new listen() resolving where any
  // in-flight token would be silently dropped.
  const actionsRef = useRef({
    applyStreamEvent, setChatTitle, refreshChats, refreshTags, loadChatTags, loadMessages,
  });
  actionsRef.current = {
    applyStreamEvent, setChatTitle, refreshChats, refreshTags, loadChatTags, loadMessages,
  };

  useEffect(() => {
    let cancelled = false;
    let unlistenStream: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;
    let unlistenTags: (() => void) | undefined;
    let unlistenZone: (() => void) | undefined;
    let unlistenChats: (() => void) | undefined;
    let unlistenFileSync: (() => void) | undefined;
    // Stream events arrive one per token, and applying each on arrival meant a
    // store write and a React pass per token — with two zones answering at once
    // the app spent its whole frame budget re-rendering and visibly stuttered.
    // Buffer arrivals and drain the queue in one task instead: the same events
    // in the same order, but React coalesces the burst into a single render.
    // A timer rather than requestAnimationFrame, so a minimised window still
    // drains (rAF stops entirely when the window isn't painting).
    let queue: StreamEnvelope[] = [];
    let drainTimer: number | undefined;
    const drain = () => {
      drainTimer = undefined;
      const batch = queue;
      queue = [];
      for (const env of batch) {
        actionsRef.current.applyStreamEvent(env.chatId, env.event, env.perspectiveZoneId);
      }
    };
    api.onStream((env) => {
      queue.push(env);
      if (drainTimer === undefined) drainTimer = window.setTimeout(drain, STREAM_DRAIN_MS);
    }).then((u) => {
      if (cancelled) u();
      else unlistenStream = u;
    });
    api.onChatTitleUpdated(({ chatId, title }) => {
      actionsRef.current.setChatTitle(chatId, title);
      actionsRef.current.refreshChats();
    }).then((u) => {
      if (cancelled) u();
      else unlistenTitle = u;
    });
    api.onChatTagsUpdated(({ chatId }) => {
      // The model created/assigned a tag — refresh the global tag list and
      // this chat's tag chips so the strip updates live.
      actionsRef.current.refreshTags();
      actionsRef.current.loadChatTags(chatId);
    }).then((u) => {
      if (cancelled) u();
      else unlistenTags = u;
    });
    api.onChatZoneUpdated(() => {
      // The model switched the chat's primary zone mid-turn — re-pull chats so
      // the zone picker reflects the new zone live.
      actionsRef.current.refreshChats();
    }).then((u) => {
      if (cancelled) u();
      else unlistenZone = u;
    });
    api.onChatsChanged(() => {
      // A subchat was spawned (or the chat list otherwise changed) — refresh so
      // the sidebar shows it nested under its parent live.
      actionsRef.current.refreshChats();
    }).then((u) => {
      if (cancelled) u();
      else unlistenChats = u;
    });
    api.onChatFileSynced(({ chatId }) => {
      // An external edit to a mirrored `.md` was synced into the DB (0.7.2) —
      // refresh the sidebar (title) and reload this chat's messages.
      actionsRef.current.refreshChats();
      actionsRef.current.loadMessages(chatId);
    }).then((u) => {
      if (cancelled) u();
      else unlistenFileSync = u;
    });
    return () => {
      cancelled = true;
      // Apply anything still queued — the store outlives this component, and a
      // dropped batch would strand a chat mid-stream.
      if (drainTimer !== undefined) window.clearTimeout(drainTimer);
      drain();
      unlistenStream?.();
      unlistenTitle?.();
      unlistenTags?.();
      unlistenZone?.();
      unlistenChats?.();
      unlistenFileSync?.();
    };
    // Deliberately empty — see actionsRef comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main
      className="relative flex h-full flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {activeChat ? (
        <div key={activeChat.id} className="mz-view-in flex min-h-0 flex-1 flex-col">
          <header className="mz-drop-in flex min-h-12 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 sm:flex-nowrap sm:gap-3 sm:px-4">
            <div className="min-w-0 flex-1 truncate text-sm font-medium">{activeChat.title}</div>
            <ConversationIndicator chatId={activeChat.id} />
            <PerspectiveZoneChips
              zones={(chatZonesByChat[activeChat.id] ?? [])
                .map((cz) => zones.find((z) => z.id === cz.zoneId))
                .filter((z): z is Zone => !!z)}
              onOpen={(zoneId) => openZoneEditor(zoneId)}
            />
            <div className="flex shrink-0 items-center gap-2">
            <ContextMeter chatId={activeChat.id} />
            <MetaStripToggle
              open={metaOpen}
              onToggle={() => setMetaOpen(!metaOpen)}
              project={projects.find((p) => p.id === activeChat.projectId) ?? null}
              tagCount={(tagsByChat[activeChat.id] ?? []).length}
            />
            <button
              onClick={() => setReplayOpen(true)}
              title="Replay this session — every tool call, approval, failure and plan decision in order"
              className={`rounded p-1.5 ${CHROME_QUIET}`}
            >
              <History size={HEADER_ICON} />
            </button>
            <ExportMenu chatId={activeChat.id} />
            <PerspectiveZonePicker
              chatId={activeChat.id}
              primaryZoneId={activeChat.zoneId}
              perspectiveZones={chatZonesByChat[activeChat.id] ?? []}
              allZones={zones}
              mode={activeChat.perspectiveMode}
              globalMode={globalPerspectiveMode}
              onAdd={(zoneId) => addPerspectiveZone(activeChat.id, zoneId)}
              onRemove={(zoneId) => removePerspectiveZone(activeChat.id, zoneId)}
              onSetMode={(m) => setChatPerspectiveMode(activeChat.id, m)}
            />
            <ZonePicker
              chatId={activeChat.id}
              currentZoneId={activeChat.zoneId}
              smartRouting={activeChat.smartRouting ?? false}
              routingState={routingByChat[activeChat.id] ?? null}
            />
            {isSmartChat && zones.length === 0 && (
              <span className="text-xs text-[var(--color-text-muted)]">
                No zones — add one to enable routing
              </span>
            )}
            </div>
          </header>

          {/* Project + tag strip, on request rather than always (0.12.3).
              It was a permanent second bar under the header, and for the common
              case — no project, no tags — it said so in italics and cost a row of
              the window to do it. The sidebar already groups chats by project and
              filters by tag, so the strip is where you *change* those, not where
              you read them: the header chip above carries the state, and opening
              it is one click when the answer is "put this one somewhere". */}
          {metaOpen && (
          <ProjectTagStrip
            chatId={activeChat.id}
            projectId={activeChat.projectId}
            projectContextEnabled={activeChat.projectContextEnabled}
            knowledgeEnabled={activeChat.knowledgeEnabled}
            projects={projects}
            chatTags={tagsByChat[activeChat.id] ?? []}
            allTags={tags}
            onSetProject={(projectId) => setChatProject(activeChat.id, projectId)}
            onToggleProjectContext={(e) => toggleProjectContext(activeChat.id, e)}
            onToggleKnowledge={(e) => toggleKnowledge(activeChat.id, e)}
            onAddTag={(tagId) => addChatTag(activeChat.id, tagId)}
            onRemoveTag={(tagId) => removeChatTag(activeChat.id, tagId)}
            onToggleTagContext={(tagId, e) => toggleChatTagContext(activeChat.id, tagId, e)}
          />
          )}

          {/* Keyed by chat id so switching chats remounts the thread instead of
              reusing the previous chat's component instances. Turns and text
              blocks inside are keyed by index (a turn has no stable id until it
              persists), so without this a reused instance could carry the old
              chat's view state — collapsed rails, edit drafts, scroll position,
              and (before the `useThrottledStreaming` fix) the old answer text. */}
          <MessageThread key={activeChat.id} chatId={activeChat.id} />
          {elsewhereApprovals.length > 0 && (
            <div className="border-t border-amber-500/40 bg-amber-500/10 px-4 py-2">
              <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
                {elsewhereApprovals.map((e) => (
                  <div key={e.chatId} className="flex items-center gap-2 text-xs">
                    <ShieldAlert size={14} className="shrink-0 text-amber-500" />
                    <span className="text-[var(--color-text)]">
                      {e.count === 1
                        ? "A sub-agent is waiting for approval in"
                        : `${e.count} approvals are waiting in`}{" "}
                      <span className="font-medium">{e.title}</span>
                    </span>
                    <button
                      onClick={() => void setActiveChat(e.chatId)}
                      className="ml-auto shrink-0 rounded border border-amber-500/50 px-2 py-0.5 font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
                    >
                      Review
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Review queue (0.10.2): staged writes waiting to be read and
              applied. Renders nothing when nothing is queued, which is every
              chat unless review mode is on. */}
          {/* The approved plan while it runs — the only view of what is *about*
              to happen, and where a step can be struck or the run stopped
              without cancelling the turn (0.12.1). */}
          <div className="px-4">
            <div className="mx-auto max-w-3xl">
              <TaskPanel chatId={activeChat.id} streaming={isStreaming} />
            </div>
          </div>
          <ReviewQueue chatId={activeChat.id} />
          {pendingApprovals.length > 0 ? (
            <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
              <div className="mx-auto flex max-w-3xl flex-col gap-2">
                {subchatNotice}
                {pendingApprovals.map((pa) => (
                  <ToolApprovalBanner
                    key={pa.zoneId ?? "__primary__"}
                    toolName={pa.name}
                    toolArguments={pa.arguments}
                    diff={pa.diff}
                    zoneName={
                      pa.zoneId
                        ? zones.find((z) => z.id === pa.zoneId)?.name ?? "Perspective"
                        : null
                    }
                    onApprove={(hunks) => respondApproval(activeChatId!, pa.zoneId, true, hunks)}
                    onDeny={() => respondApproval(activeChatId!, pa.zoneId, false)}
                  />
                ))}
              </div>
            </div>
          ) : pendingPlan ? (
            <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
              <div className="mx-auto max-w-3xl">
                {subchatNotice}
                <PlanReview
                  plan={pendingPlan}
                  busy={planBusy}
                  onApprove={async (steps, edited) => {
                    setPlanBusy(true);
                    try {
                      await approvePlan(activeChat.id, pendingPlan.id, steps, edited);
                      // Approval is a decision, not a message: the turn that
                      // executes it starts here rather than waiting for the
                      // user to also type "go".
                      await api.sendMessage(activeChat.id, [
                        { type: "text", text: "Approved — carry out the plan." },
                      ]);
                    } finally {
                      setPlanBusy(false);
                    }
                  }}
                  onReject={async () => {
                    setPlanBusy(true);
                    try {
                      await rejectPlan(activeChat.id, pendingPlan.id);
                    } finally {
                      setPlanBusy(false);
                    }
                  }}
                />
              </div>
            </div>
          ) : pendingAskUser ? (
            <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
              <div className="mx-auto max-w-3xl">
                {subchatNotice}
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
            // The composer arrives a beat after the thread it belongs to, so the
            // eye finishes on the thing the user is about to type into.
            <div className="mz-view-in mz-delay-60 shrink-0">
              <InputBar
                chatId={activeChat.id}
                disabled={inputDisabled}
                ref={inputRef}
                notice={subchatNotice}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="mz-view-in flex min-h-0 flex-1 flex-col">
          <HomeScreen />
        </div>
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
      {replayOpen && activeChat && (
        <ReplayView chatId={activeChat.id} onClose={() => setReplayOpen(false)} />
      )}
      {settingsOpen && <SettingsModal />}
      {zoneLibraryOpen && <ZoneLibrary />}
      {projectsPanelOpen && <ProjectsPanel />}
    </main>
  );
}

import type { ChatTagEntry, ChatZone, Project, Tag, Zone } from "@/lib/types";
import { claimSettingsDrop } from "@/lib/importSettings";

/**
 * Notice above the composer in a subchat, naming the zone that started it.
 *
 * You can type here, but you are not the only one who can: the owning zone may
 * send to this same conversation in the middle of its own turn. Saying so is
 * the point of the banner — a reply that arrives out of nowhere is confusing in
 * a way that a reply you were told to expect is not.
 *
 * It renders as a pill centred over the composer's own column, the same shape as
 * the override / OCR-fallback notices. It used to be a full-width strip of its
 * own, which put a second horizontal rule a few pixels above the composer's and
 * left the text hanging off the left edge of the input box it belonged to.
 */
function SubchatBanner({ zone }: { zone: Zone | null }) {
  const Icon = zone ? getZoneIcon(zone.icon) : Eye;
  const color = zone?.accentColor ?? "var(--color-accent)";
  return (
    <div className="mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] py-1 pl-1 pr-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
        style={{ background: color }}
      >
        <Icon size={9} color="white" />
      </span>
      {zone ? (
        <span className="truncate">
          Sub-agent conversation ·{" "}
          <span className="font-medium text-[var(--color-text)]">{zone.name}</span> can also send
          here — you can reply directly.
        </span>
      ) : (
        <span className="truncate">Sub-agent conversation — you can reply here directly.</span>
      )}
    </div>
  );
}

/**
 * The header's stand-in for the project/tag strip (0.12.3).
 *
 * Carries the state the strip used to spend a whole row displaying — which
 * project this chat is filed under, and how many tags it has — and opens the
 * strip when the user wants to change it. Unfiled chats, which are most of them,
 * get a single muted folder glyph instead of a bar reading "no tags yet".
 */
function MetaStripToggle({
  open,
  onToggle,
  project,
  tagCount,
}: {
  open: boolean;
  onToggle: () => void;
  project: Project | null;
  tagCount: number;
}) {
  const Icon = project ? getZoneIcon(project.icon) : Folder;
  const color = project?.accentColor ?? "var(--color-accent)";
  return (
    <button
      onClick={onToggle}
      title={
        open
          ? "Hide the project and tag row"
          : `${project ? `Project: ${project.name}` : "No project"}${
              tagCount > 0 ? ` · ${tagCount} tag${tagCount === 1 ? "" : "s"}` : ""
            } — click to change`
      }
      className={`flex max-w-[180px] items-center gap-1.5 rounded px-1.5 py-1 text-xs ${
        open ? CHROME_ACTIVE : CHROME_QUIET
      }`}
    >
      {project ? (
        <span
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded"
          style={{ background: color }}
        >
          <Icon size={11} color="white" />
        </span>
      ) : (
        <Folder size={HEADER_ICON} className="shrink-0" />
      )}
      {project && <span className="truncate">{project.name}</span>}
      {tagCount > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          <TagIcon size={HEADER_ICON} />
          {tagCount}
        </span>
      )}
    </button>
  );
}

function ProjectTagStrip({
  chatId,
  projectId,
  projectContextEnabled,
  knowledgeEnabled,
  projects,
  chatTags,
  allTags,
  onSetProject,
  onToggleProjectContext,
  onToggleKnowledge,
  onAddTag,
  onRemoveTag,
  onToggleTagContext,
}: {
  chatId: string;
  projectId: string | null;
  projectContextEnabled: boolean;
  knowledgeEnabled: boolean;
  projects: Project[];
  chatTags: ChatTagEntry[];
  allTags: Tag[];
  onSetProject: (projectId: string | null) => void;
  onToggleProjectContext: (enabled: boolean) => void;
  onToggleKnowledge: (enabled: boolean) => void;
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
  onToggleTagContext: (tagId: string, enabled: boolean) => void;
}) {
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showContext, setShowContext] = useState(false);
  useDismissOnEscape(showTagPicker, () => setShowTagPicker(false));
  useDismissOnEscape(showProjectPicker, () => setShowProjectPicker(false));
  useDismissOnEscape(showContext, () => setShowContext(false));
  const project = projects.find((p) => p.id === projectId) ?? null;
  const ProjectIcon = project ? getZoneIcon(project.icon) : null;
  const projectColor = project?.accentColor ?? "var(--color-accent)";
  const unassignedTags = allTags.filter((t) => !chatTags.some((ct) => ct.tagId === t.id));
  const projectHasSnippet = !!project?.contextSnippet?.trim();
  // The project has a knowledge index built (set after a successful index run).
  // Only then is the search_local_files tool useful, so we only show the toggle then.
  const projectIndexed = !!project?.kbIndexedAt;

  // Everything currently being prepended to the system prompt for this chat:
  // the project snippet (when its context is on) and each enabled tag snippet.
  // Surfaced in an expandable panel so the user can see exactly what's injected.
  const injectedContext: { label: string; color: string; text: string }[] = [];
  if (projectContextEnabled && project?.contextSnippet?.trim()) {
    injectedContext.push({ label: project.name, color: projectColor, text: project.contextSnippet.trim() });
  }
  for (const ct of chatTags) {
    if (ct.contextEnabled && ct.contextSnippet?.trim()) {
      injectedContext.push({ label: ct.name, color: ct.color ?? "var(--color-accent)", text: ct.contextSnippet.trim() });
    }
  }

  return (
    <div className="border-b border-[var(--color-border)]">
    <div className="flex flex-wrap items-center gap-1.5 px-4 py-1.5">
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
          {projectIndexed && (
            <button
              onClick={() => onToggleKnowledge(!knowledgeEnabled)}
              title={
                knowledgeEnabled
                  ? "Knowledge ON — the assistant can search this project's indexed documents. Click to disable."
                  : "Knowledge OFF — click to let the assistant search this project's documents (the search_local_files tool)."
              }
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
                knowledgeEnabled
                  ? "border-transparent text-white"
                  : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
              }`}
              style={knowledgeEnabled ? { background: projectColor } : undefined}
            >
              <Database size={9} />
              {knowledgeEnabled ? "Knowledge on" : "Knowledge off"}
            </button>
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

      {/* Injected-context preview toggle */}
      {injectedContext.length > 0 && (
        <button
          onClick={() => setShowContext((v) => !v)}
          title="Show the context being prepended to this chat's system prompt"
          className="ml-auto flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          {showContext ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Eye size={11} />
          Context ({injectedContext.length})
        </button>
      )}
    </div>

    {showContext && injectedContext.length > 0 && (
      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2">
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Prepended to the system prompt
        </div>
        <div className="flex flex-col gap-2">
          {injectedContext.map((item, i) => (
            <div key={i} className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium" style={{ color: item.color }}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} />
                {item.label}
              </div>
              <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                {item.text}
              </div>
            </div>
          ))}
        </div>
      </div>
    )}
    </div>
  );
}

/** Avatar + name chips for the chat's active perspective zones. Clicking a chip
 * opens that zone's editor (its details). */
function PerspectiveZoneChips({
  zones,
  onOpen,
}: {
  zones: Zone[];
  onOpen: (zoneId: string) => void;
}) {
  if (zones.length === 0) return null;
  return (
    <div className="flex min-w-0 shrink items-center gap-1.5 overflow-x-auto">
      {zones.map((z) => {
        const Icon = getZoneIcon(z.icon);
        const color = z.accentColor ?? "var(--color-accent)";
        return (
          <button
            key={z.id}
            onClick={() => onOpen(z.id)}
            title={`${z.name} — open zone details`}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] py-0.5 pl-0.5 pr-2 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          >
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
              style={{ background: color }}
            >
              <Icon size={10} color="white" />
            </span>
            <span className="max-w-[120px] truncate">{z.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function PerspectiveZonePicker({
  chatId,
  primaryZoneId,
  perspectiveZones,
  allZones,
  mode,
  globalMode,
  onAdd,
  onRemove,
  onSetMode,
}: {
  chatId: string;
  primaryZoneId: string | null;
  perspectiveZones: ChatZone[];
  allZones: Zone[];
  mode: "sequential" | "parallel" | null;
  globalMode: "sequential" | "parallel";
  onAdd: (zoneId: string) => void;
  onRemove: (zoneId: string) => void;
  onSetMode: (mode: "sequential" | "parallel" | null) => void;
}) {
  const [open, setOpen] = useState(false);
  useDismissOnEscape(open, () => setOpen(false));
  const perspZoneIds = new Set(perspectiveZones.map((z) => z.zoneId));
  const addable = allZones.filter((z) => z.id !== primaryZoneId && !perspZoneIds.has(z.id));
  const count = perspectiveZones.length;
  // The toggle has three states: inherit (null) and the two explicit modes.
  const modeOptions: { value: "sequential" | "parallel" | null; label: string }[] = [
    { value: null, label: `Default (${globalMode})` },
    { value: "parallel", label: "Parallel" },
    { value: "sequential", label: "Sequential" },
  ];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Perspective zones — get responses from multiple zones simultaneously"
        className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
          count > 0 ? CHROME_ACTIVE : CHROME_OUTLINED
        }`}
      >
        <SplitSquareHorizontal size={HEADER_ICON} />
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

            <div className="mx-2 my-1 border-t border-[var(--color-border)]" />
            <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Run mode
            </div>
            <div className="flex gap-1 px-3 pb-2 pt-0.5">
              {modeOptions.map((opt) => {
                const active = mode === opt.value;
                return (
                  <button
                    key={opt.label}
                    onClick={() => onSetMode(opt.value)}
                    title={
                      opt.value === null
                        ? "Use the global default set in Settings → Chat"
                        : opt.value === "sequential"
                          ? "Run perspective zones one at a time (gentler on local model VRAM)"
                          : "Run all perspective zones at once"
                    }
                    className={`flex-1 whitespace-nowrap rounded border px-2 py-1 text-[11px] transition ${
                      active
                        ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)] text-[var(--color-text)]"
                        : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The approval prompt. For a file write it leads with the diff (0.10.2): the
 * question "may I write this" is unanswerable when what you are shown is a wall
 * of proposed content, and every reviewer in the world already reads changes as
 * added and removed lines. Hunks are individually takeable — the call still
 * runs, against exactly the content that was agreed to.
 */
function ToolApprovalBanner({
  toolName,
  toolArguments,
  diff,
  zoneName,
  onApprove,
  onDeny,
}: {
  toolName: string;
  toolArguments: string;
  diff: FileDiff | null;
  /** Perspective zone the approval belongs to, or null for the primary turn. */
  zoneName: string | null;
  /** `hunks` narrows the approval to a subset; omitted means the whole change. */
  onApprove: (hunks?: number[]) => void;
  onDeny: () => void;
}) {
  const [showArgs, setShowArgs] = useState(false);
  // Everything is taken by default: the prompt asks whether to run the model's
  // call, and starting with hunks deselected would quietly make "Approve" mean
  // something the user never chose.
  const [taken, setTaken] = useState<Set<number>>(
    () => new Set((diff?.hunks ?? []).map((h) => h.index)),
  );

  let argsDisplay = toolArguments;
  try {
    argsDisplay = JSON.stringify(JSON.parse(toolArguments), null, 2);
  } catch { /* leave as-is */ }

  const displayName = toolName.replace(/_/g, " ");
  const hunkCount = diff?.hunks.length ?? 0;
  const partial = hunkCount > 0 && taken.size < hunkCount;

  function toggle(index: number) {
    setTaken((s) => {
      const next = new Set(s);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <div className="rounded border border-[var(--color-accent)]/40 bg-[var(--color-panel)] p-3">
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert size={14} className="shrink-0 text-[var(--color-accent)]" />
            <span className="text-sm font-medium">Tool approval required</span>
            {zoneName && (
              <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                {zoneName}
              </span>
            )}
          </div>
          <p className="mb-2 text-xs text-[var(--color-text-muted)]">
            {zoneName ? `${zoneName} wants to run ` : "The model wants to run "}
            <span className="font-mono font-medium text-[var(--color-text)]">{displayName}</span>
          </p>
          {diff && (
            <div className="mb-2">
              <DiffView
                diff={diff}
                selected={hunkCount > 1 ? taken : undefined}
                onToggleHunk={hunkCount > 1 ? toggle : undefined}
              />
              {hunkCount > 1 && (
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  Untick a hunk to leave it out — the rest is written as proposed.
                </p>
              )}
            </div>
          )}
          <button
            onClick={() => setShowArgs((v) => !v)}
            className="mb-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            {showArgs ? "Hide" : "Show"} {diff ? "raw arguments" : "arguments"}
          </button>
          {showArgs && (
            <pre className="mb-3 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[11px] font-mono leading-relaxed text-[var(--color-text-muted)]">
              {argsDisplay}
            </pre>
          )}
          <div className="flex gap-2">
            <button
              // A narrowed approval sends the selection; an untouched one sends
              // nothing, so the call runs exactly as the model wrote it.
              onClick={() => onApprove(partial ? [...taken].sort((a, b) => a - b) : undefined)}
              disabled={partial && taken.size === 0}
              className={`rounded px-4 py-1.5 text-xs ${PRIMARY_ACTION}`}
            >
              {partial ? `Apply ${taken.size} of ${hunkCount} hunks` : "Approve"}
            </button>
            <button
              onClick={onDeny}
              className="rounded border border-[var(--color-border)] px-4 py-1.5 text-xs hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
            >
              Deny
            </button>
          </div>
    </div>
  );
}

