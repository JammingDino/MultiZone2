import { useEffect, useRef, useState, type ReactNode } from "react";
import { ClipboardList, FolderTree, Gauge, MessageSquare, PanelRightClose, TerminalSquare } from "lucide-react";
import { useApp, type WorkspaceSection } from "@/store/app";
import * as api from "@/lib/tauri";
import { useIsNarrow } from "@/lib/useIsNarrow";
import { ResizeHandle, usePanelWidth } from "@/components/common/ResizeHandle";
import { useBackDismiss } from "@/lib/useBackDismiss";
import { usePersistentChoice } from "@/lib/uiState";
import { PLAN_APPROVED, systemTurnParts } from "@/lib/systemTurn";
import { TaskPanel } from "@/components/Chat/TaskPanel";
import { PlanReview } from "@/components/Chat/PlanReview";
import { ReviewQueue } from "@/components/Chat/ReviewQueue";
import { TerminalPanel } from "@/components/Chat/TerminalPanel";
import { ContextPanel } from "./ContextPanel";
import { FilesPanel } from "./FilesPanel";
import { ChatSection } from "./ChatSection";

/**
 * The workspace panel (0.17.9): everything that used to pile up between the
 * transcript and the composer, in a column of its own on the right.
 *
 * A plan being drafted, a task list ticking off, a terminal following a build,
 * staged edits waiting for review — each of these earned its place in the chat
 * column one release at a time, and together they left the conversation a
 * strip a few lines high. They are not messages; they are the state of the
 * work, and the state of the work wants a place you can glance at without it
 * scrolling the transcript away. Approvals and `ask_user` stay with the
 * composer: those are questions blocking the turn, and the answer is typed or
 * clicked right there.
 *
 * The panel opens itself when something arrives that needs the user (a filed
 * plan), and otherwise remembers whether it was left open. On a phone it is a
 * drawer over the chat, like the sidebar, rather than a third column.
 */
export function WorkspacePanel() {
  const chatId = useApp((s) => s.activeChatId);
  const open = useApp((s) => s.workspaceOpen);
  const setOpen = useApp((s) => s.setWorkspaceOpen);
  const narrow = useIsNarrow();
  useBackDismiss(narrow && open, () => setOpen(false));
  // The column's width is the user's (0.17.10); a file open in the viewer wants
  // more than the 340px it started at.
  const size = usePanelWidth("ui.workspaceWidth", 360, 260, 720);

  if (!chatId || !open) return null;

  const body = <PanelBody chatId={chatId} onClose={() => setOpen(false)} />;

  if (narrow) {
    return (
      <>
        <div className="absolute inset-0 z-30 bg-black/40" onClick={() => setOpen(false)} />
        <aside className="absolute inset-y-0 right-0 z-40 flex w-[min(92vw,380px)] flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)] shadow-xl">
          {body}
        </aside>
      </>
    );
  }
  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)]"
      style={{ width: size.width }}
    >
      <ResizeHandle
        side="left"
        width={size.width}
        onResize={size.set}
        onDragging={size.setDragging}
        onReset={size.reset}
        label="Resize workspace panel"
      />
      {body}
    </aside>
  );
}

const TABS: { id: WorkspaceSection; label: string; title: string; icon: ReactNode }[] = [
  { id: "chat", label: "Chat", title: "This chat: project, tags, perspectives", icon: <MessageSquare size={13} /> },
  { id: "plan", label: "Plan", title: "Plans and the task list", icon: <ClipboardList size={13} /> },
  { id: "terminals", label: "Term", title: "Terminals", icon: <TerminalSquare size={13} /> },
  { id: "files", label: "Files", title: "The chat's working directory", icon: <FolderTree size={13} /> },
  { id: "context", label: "Ctx", title: "What is in the context window", icon: <Gauge size={13} /> },
];

function PanelBody({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const isStreaming = useApp(
    (s) => Boolean(s.streamingByChat[chatId]) || Object.keys(s.perspectiveStreamsByChat[chatId] ?? {}).length > 0,
  );
  const pendingPlan = useApp((s) => s.pendingPlanByChat[chatId] ?? null);
  const plans = useApp((s) => s.planTreeByChat[chatId]);
  const approvePlan = useApp((s) => s.approvePlan);
  const rejectPlan = useApp((s) => s.rejectPlan);
  const focusWorkspace = useApp((s) => s.focusWorkspace);
  const [planBusy, setPlanBusy] = useState(false);

  // A newly filed plan is a decision waiting: switch to its tab.
  const seenPlan = useRef<string | null>(null);
  useEffect(() => {
    if (pendingPlan && pendingPlan.id !== seenPlan.current) {
      seenPlan.current = pendingPlan.id;
      focusWorkspace("plan");
    }
  }, [pendingPlan, focusWorkspace]);

  const livePlans = (plans ?? []).filter((p) => ["approved", "executing", "stopped"].includes(p.status));

  // The five sections were a stack of collapsible bands, all in one scroller
  // (0.18). Every one started closed, so reaching the tree meant opening it
  // past three other headers — and once a file was open the tree had about a
  // quarter of the panel left. They are tabs now: one at a time, at full
  // height. `focusWorkspace(id)` switches tab instead of scrolling.
  const [tab, setTab] = usePersistentChoice<WorkspaceSection>("workspace.tab", "files", TABS.map((t) => t.id));
  const focus = useApp((s) => s.workspaceFocus);
  useEffect(() => {
    if (!focus) return;
    setTab(focus);
    focusWorkspace(null);
  }, [focus, setTab, focusWorkspace]);

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <span className="text-xs font-medium text-[var(--color-text)]">Workspace</span>
        <button
          onClick={onClose}
          title="Hide the workspace panel"
          className="ml-auto rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          aria-label="Hide the workspace panel"
        >
          <PanelRightClose size={16} />
        </button>
      </div>
      {/* The tab strip. Short labels because the panel is 360px by default and
          five tabs have to fit; the icon carries the rest. A dot marks a tab
          with something waiting — a filed plan is the case that matters. */}
      <div className="flex shrink-0 border-b border-[var(--color-border)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            title={t.title}
            className={`relative flex h-9 flex-1 items-center justify-center gap-1.5 border-b-2 text-[11px] ${
              tab === t.id
                ? "border-[var(--color-accent)] font-medium text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
            {t.id === "plan" && pendingPlan && (
              <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
            )}
          </button>
        ))}
      </div>

      {/* One tab's worth of panel, and the whole panel's height to put it in.
          Files takes the height directly (its tree is its own scroller); the
          rest keep the scrolling column they were written for. */}
      {tab === "files" ? (
        <FilesPanel chatId={chatId} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-2.5 text-xs">
          {tab === "chat" && <ChatSection chatId={chatId} />}
          {tab === "plan" && (
            <>
              {pendingPlan ? (
                <PlanReview
                  plan={pendingPlan}
                  busy={planBusy}
                  onApprove={async (steps, edited) => {
                    setPlanBusy(true);
                    try {
                      await approvePlan(chatId, pendingPlan.id, steps, edited);
                      // Approval is a decision, not a message: the turn that
                      // executes it starts here rather than waiting for the user
                      // to also type "go". Sent as a system turn so the model is
                      // told to proceed without the transcript claiming the user
                      // typed the sentence.
                      await api.sendMessage(chatId, systemTurnParts(PLAN_APPROVED));
                    } finally {
                      setPlanBusy(false);
                    }
                  }}
                  onReject={async () => {
                    setPlanBusy(true);
                    try {
                      await rejectPlan(chatId, pendingPlan.id);
                    } finally {
                      setPlanBusy(false);
                    }
                  }}
                />
              ) : null}
              <div className={pendingPlan ? "mt-2" : ""}>
                <TaskPanel chatId={chatId} streaming={isStreaming} full />
              </div>
              <ReviewQueue chatId={chatId} embedded />
              {!pendingPlan && livePlans.length === 0 && (
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  No plan in progress. Ask for one, or type <span className="font-mono">/plan</span>.
                </p>
              )}
            </>
          )}
          {tab === "terminals" && <TerminalPanel chatId={chatId} embedded />}
          {tab === "context" && <ContextPanel chatId={chatId} />}
        </div>
      )}
    </>
  );
}
