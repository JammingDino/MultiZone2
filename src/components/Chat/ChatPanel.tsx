import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, ShieldAlert, Eye, MessageSquare, X } from "lucide-react";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import * as api from "@/lib/tauri";
import { MessageThread } from "./MessageThread";
import { FileViewer } from "@/components/Workspace/FileViewer";
import { iconFor } from "@/components/Workspace/FilesPanel";
import { InputBar, type InputBarHandle } from "./InputBar";
import { ZonePicker } from "./ZonePicker";
import { WorkspaceToggle } from "@/components/Workspace/WorkspaceToggle";
import { ConversationIndicator } from "./ConversationIndicator";
import { ContextMeter } from "./ContextMeter";
import { DiffView } from "@/components/common/DiffView";
import {
  IntentVisual,
  editPathOf,
  pathRulePrefixes,
  rulePrefixes,
  shellCommandOf,
} from "@/components/Message/visuals/IntentVisual";
import { HomeScreen } from "./HomeScreen";
import { SettingsModal } from "@/components/Settings/SettingsModal";
import { ZoneLibrary } from "@/components/Zones/ZoneLibrary";
import { ProjectsPanel } from "@/components/Projects/ProjectsPanel";
import { getZoneIcon } from "@/lib/zoneIcons";
import { AskUserCard } from "@/components/Message/StepBlock";
import { ReplayView } from "@/components/Chat/ReplayView";
import { resolveBaseModel } from "@/lib/baseZone";
import { PRIMARY_ACTION } from "@/lib/chrome";
import type { FileDiff, StreamEnvelope } from "@/lib/types";

/**
 * The main column's tabs: the transcript, then one per open file (0.18).
 *
 * A file used to open in the workspace panel, in a box above the tree, both of
 * them sharing 360px — so an image was a postage stamp and an HTML report was
 * a letterbox. Here a file gets the column the transcript gets. The strip
 * hides itself when nothing is open, so a chat that never opens a file looks
 * exactly as it did.
 */
function DocumentTabs({ chatId }: { chatId: string }) {
  const open = useApp((s) => s.openFilesByChat[chatId]);
  const active = useApp((s) => s.activeFileByChat[chatId] ?? null);
  const openFile = useApp((s) => s.openWorkspaceFile);
  const closeFile = useApp((s) => s.closeWorkspaceFile);
  const showChat = useApp((s) => s.showChatTab);
  if (!open || open.length === 0) return null;

  return (
    // Scrolls sideways rather than squeezing: on a narrow window four open
    // files must not shrink the chat tab to an ellipsis.
    <div className="hide-scrollbar flex shrink-0 items-stretch overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-panel)]">
      <Tab active={active === null} onClick={showChat} icon={<MessageSquare size={12} />} label="Chat" />
      {open.map((path) => {
        const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
        const { Icon, color } = iconFor(name);
        return (
          <Tab
            key={path}
            active={active === path}
            onClick={() => openFile(path)}
            onClose={() => closeFile(path)}
            title={path}
            icon={<Icon size={12} style={{ color }} />}
            label={name}
          />
        );
      })}
    </div>
  );
}

function Tab({
  active,
  onClick,
  onClose,
  icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  onClose?: () => void;
  icon: React.ReactNode;
  label: string;
  title?: string;
}) {
  return (
    <div
      // Middle-click anywhere on the tab closes it, as it does everywhere else
      // that has tabs — including on the close button, so the aim does not
      // have to be good. `onMouseDown` only to stop Windows dropping into
      // autoscroll; the close is on `onAuxClick`, which is the event a
      // non-primary button actually completes on. The chat tab has no
      // `onClose`, so there it does nothing.
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={(e) => { if (e.button === 1) onClose?.(); }}
      className={`flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-r border-r-[var(--color-border)] pl-2.5 text-xs ${
        onClose ? "pr-1" : "pr-2.5"
      } ${
        active
          ? "border-b-[var(--color-accent)] bg-[var(--color-bg)] text-[var(--color-text)]"
          : "border-b-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
      }`}
    >
      <button onClick={onClick} title={title ?? label} className="flex min-w-0 items-center gap-1.5">
        <span className="flex shrink-0">{icon}</span>
        <span className="max-w-[10rem] truncate">{label}</span>
      </button>
      {onClose && (
        <button
          onClick={onClose}
          title="Close this tab"
          aria-label={`Close ${label}`}
          className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)]"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

/** How long stream events are collected before being applied as one batch. */
const STREAM_DRAIN_MS = 16;

export function ChatPanel() {
  const {
    activeChatId,
    chats,
    zones,
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
    respondApproval,
  } = useApp(
    useShallow((s) => ({
      activeChatId: s.activeChatId,
      chats: s.chats,
      zones: s.zones,
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
      respondApproval: s.respondApproval,
    })),
  );
  const providers = useApp((s) => s.providers);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);

  const pendingApprovalByChat = useApp((s) => s.pendingApprovalByChat);
  const setActiveChat = useApp((s) => s.setActiveChat);
  const routingByChat = useApp((s) => s.routingByChat);
  const stageImport = useApp((s) => s.stageImport);
  const pendingApprovals = activeChatId ? (pendingApprovalByChat[activeChatId] ?? []) : [];
  // The file tab this chat is showing, if any; null is the transcript (0.18).
  const activeFile = useApp((s) => (activeChatId ? s.activeFileByChat[activeChatId] ?? null : null));

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
  // Replay lives in the store because the sidebar's right-click menu can open
  // it for a chat that isn't the one on screen (#13).
  const replayChatId = useApp((s) => s.replayChatId);
  const closeReplay = useApp((s) => s.closeReplay);

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
      /* `min-w-0` is what keeps a narrow window usable (0.17.9). A flex item
         defaults to min-width:auto — its content's width — so the header's
         run of controls, which cannot shrink, used to make the whole panel
         wider than the window. Nothing overflowed visibly; the panel simply
         extended off the right edge, taking the composer's send button and
         every header control with it. Zero lets the panel be the window's
         width and the header sort out its own overflow below. */
      className="relative flex h-full min-w-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {activeChat ? (
        <div key={activeChat.id} className="mz-view-in flex min-h-0 flex-1 flex-col">
          <header className="mz-drop-in flex min-h-12 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 sm:flex-nowrap sm:gap-3 sm:px-4">
            {/* A floor on the title so the controls cannot squeeze it to
                nothing, and no ceiling: it takes whatever they leave. */}
            <div className="min-w-[5rem] flex-1 truncate text-sm font-medium" title={activeChat.title}>{activeChat.title}</div>
            <ConversationIndicator chatId={activeChat.id} />
            {/* The controls scroll sideways when there is not room for them
                all, rather than pushing the panel past the window. Each stays
                its natural size (`shrink-0` on the children) so nothing
                collapses into an unreadable sliver. Project, tags,
                perspectives and export live in the workspace panel now
                (0.17.9); what is left is what gets read every message. */}
            <div className="hide-scrollbar flex min-w-0 shrink items-center gap-2 overflow-x-auto [&>*]:shrink-0">
            <ContextMeter chatId={activeChat.id} />
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
            {/* Always the rightmost thing in the row: it opens the panel on
                the right, and a control for the edge belongs at the edge. */}
            <WorkspaceToggle />
          </header>

          {/* Keyed by chat id so switching chats remounts the thread instead of
              reusing the previous chat's component instances. Turns and text
              blocks inside are keyed by index (a turn has no stable id until it
              persists), so without this a reused instance could carry the old
              chat's view state — collapsed rails, edit drafts, scroll position,
              and (before the `useThrottledStreaming` fix) the old answer text. */}
          <DocumentTabs chatId={activeChat.id} />
          {activeFile ? (
            <FileViewer key={activeFile} path={activeFile} />
          ) : (
            <MessageThread key={activeChat.id} chatId={activeChat.id} />
          )}
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
          {/* The plan, task list, terminals and review queue that used to
              stack here live in the workspace panel on the right (0.17.9);
              only what blocks the turn — approvals, ask_user — stays with
              the composer. */}
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
      {replayChatId && (
        <ReplayView chatId={replayChatId} onClose={closeReplay} />
      )}
      {settingsOpen && <SettingsModal />}
      {zoneLibraryOpen && <ZoneLibrary />}
      {projectsPanelOpen && <ProjectsPanel />}
    </main>
  );
}

import type { Zone } from "@/lib/types";
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
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  // Everything is taken by default: the prompt asks whether to run the model's
  // call, and starting with hunks deselected would quietly make "Approve" mean
  // something the user never chose.
  const [taken, setTaken] = useState<Set<number>>(
    () => new Set((diff?.hunks ?? []).map((h) => h.index)),
  );

  let argsDisplay = toolArguments;
  let parsedArgs: any = null;
  try {
    parsedArgs = JSON.parse(toolArguments);
    argsDisplay = JSON.stringify(parsedArgs, null, 2);
  } catch { /* leave as-is */ }

  const hunkCount = diff?.hunks.length ?? 0;
  const partial = hunkCount > 0 && taken.size < hunkCount;

  // Shell calls can be answered *permanently* from here (0.14.3), and edits by
  // where they land (0.14.5). Walking to Settings to write a rule you have just
  // been asked about, while a turn sits blocked waiting for you, is a trip
  // nobody makes — so the rule gets written where the question is asked.
  const command = shellCommandOf(toolName, parsedArgs);
  const editPath = command ? null : editPathOf(toolName, parsedArgs);
  const prefixes = command
    ? rulePrefixes(command)
    : editPath
      ? pathRulePrefixes(editPath)
      : [];
  const [rulePrefix, setRulePrefix] = useState<string | null>(null);
  // A command list is broadest-last and a path list narrowest-first, and both
  // pre-select the *narrower* end: the default has to be the rule someone would
  // have written without thinking about it, not the largest one on offer.
  const chosenPrefix = rulePrefix ?? (command ? prefixes[prefixes.length - 1] : prefixes[0]) ?? null;
  const [allowList, denyList] = editPath
    ? (["editAllow", "editDeny"] as const)
    : (["shellAllow", "shellDeny"] as const);

  /** Add a prefix to the global allow or deny list, then answer this call. */
  function addRule(list: "shellAllow" | "shellDeny" | "editAllow" | "editDeny") {
    if (!chosenPrefix) return;
    const current = appSettings.approvals[list];
    if (!current.includes(chosenPrefix)) {
      setAppSettings({
        approvals: { ...appSettings.approvals, [list]: [...current, chosenPrefix] },
      });
    }
    if (list === "shellAllow" || list === "editAllow") {
      onApprove(partial ? [...taken].sort((a, b) => a - b) : undefined);
    } else onDeny();
  }

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
          {/* What the call will actually do, drawn the way the step card draws
              what it did (0.14.3). A diff, when the backend previewed one, is
              already the best possible answer to "what will this do"; anything
              else gets the intent visual. Raw JSON stays available, one click
              down, for the times the shaped view is not enough. */}
          <div className="mb-2">
            {diff ? (
              <>
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
              </>
            ) : (
              <IntentVisual name={toolName} args={parsedArgs} />
            )}
          </div>
          <button
            onClick={() => setShowArgs((v) => !v)}
            className="mb-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            {showArgs ? "Hide" : "Show"} raw arguments
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

          {/* Answer this one, or answer every command like it (0.14.3). The
              prefix is chosen rather than typed, and it is shown in full — a
              standing rule about every future command starting this way is not
              something to agree to by pressing a button labelled "always". */}
          {chosenPrefix && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--color-border)] pt-2 text-[11px]">
              <span className="text-[var(--color-text-muted)]">Rule for</span>
              {prefixes.length > 1 ? (
                <select
                  value={chosenPrefix}
                  onChange={(e) => setRulePrefix(e.target.value)}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {prefixes.map((p) => (
                    <option key={p} value={p}>
                      {p} …
                    </option>
                  ))}
                </select>
              ) : (
                <code className="rounded bg-[var(--color-bg)] px-1.5 py-0.5">{chosenPrefix} …</code>
              )}
              <button
                onClick={() => addRule(allowList)}
                title={
                  editPath
                    ? `Edit anything inside "${chosenPrefix}" without asking, from now on`
                    : `Run anything starting with "${chosenPrefix}" without asking, from now on`
                }
                className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Always allow
              </button>
              <button
                onClick={() => addRule(denyList)}
                title={
                  editPath
                    ? `Refuse every edit inside "${chosenPrefix}", from now on`
                    : `Refuse anything starting with "${chosenPrefix}", from now on`
                }
                className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
              >
                Never allow
              </button>
              <span className="text-[var(--color-text-muted)]">
                {editPath
                  ? "— saved to Settings → Chat → Where edits may land"
                  : "— saved to Settings → Chat → Command rules"}
              </span>
            </div>
          )}
    </div>
  );
}

