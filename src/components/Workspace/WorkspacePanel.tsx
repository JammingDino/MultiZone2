import { useEffect, useRef, useState } from "react";
import { ClipboardList, FolderTree, Gauge, MessageSquare, PanelRightClose, TerminalSquare } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { useIsNarrow } from "@/lib/useIsNarrow";
import { useBackDismiss } from "@/lib/useBackDismiss";
import { PLAN_APPROVED, systemTurnParts } from "@/lib/systemTurn";
import { TaskPanel } from "@/components/Chat/TaskPanel";
import { PlanReview } from "@/components/Chat/PlanReview";
import { ReviewQueue } from "@/components/Chat/ReviewQueue";
import { TerminalPanel } from "@/components/Chat/TerminalPanel";
import { Section } from "./Section";
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
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)] xl:w-[380px]">
      {body}
    </aside>
  );
}

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

  // A newly filed plan is a decision waiting: bring its section into view.
  const seenPlan = useRef<string | null>(null);
  useEffect(() => {
    if (pendingPlan && pendingPlan.id !== seenPlan.current) {
      seenPlan.current = pendingPlan.id;
      focusWorkspace("plan");
    }
  }, [pendingPlan, focusWorkspace]);

  // What the collapsed Chat section says: where the chat is filed and how
  // many voices answer in it, so the row is worth reading closed.
  const chatBadge = useApp((s) => {
    const chat = s.chats.find((c) => c.id === chatId);
    const project = chat?.projectId ? s.projects.find((p) => p.id === chat.projectId) : null;
    const tags = s.tagsByChat[chatId]?.length ?? 0;
    const persp = s.chatZonesByChat[chatId]?.length ?? 0;
    return [
      project?.name,
      tags > 0 ? `${tags} tag${tags === 1 ? "" : "s"}` : null,
      persp > 0 ? `${persp} perspective${persp === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;
  });

  const livePlans = (plans ?? []).filter((p) => ["approved", "executing", "stopped"].includes(p.status));
  const planBadge = pendingPlan
    ? "waiting for you"
    : livePlans.length > 0
      ? `${livePlans.length} running`
      : undefined;

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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Section id="chat" title="Chat" icon={<MessageSquare size={12} />} badge={chatBadge} defaultOpen={false}>
          <ChatSection chatId={chatId} />
        </Section>
        <Section id="plan" title="Plan" icon={<ClipboardList size={12} />} badge={planBadge}>
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
        </Section>
        <Section id="terminals" title="Terminals" icon={<TerminalSquare size={12} />}>
          <TerminalPanel chatId={chatId} embedded />
        </Section>
        <Section id="files" title="Files" icon={<FolderTree size={12} />} defaultOpen={false}>
          <FilesPanel chatId={chatId} />
        </Section>
        <Section id="context" title="Context" icon={<Gauge size={12} />}>
          <ContextPanel chatId={chatId} />
        </Section>
      </div>
    </>
  );
}
