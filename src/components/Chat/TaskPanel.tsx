import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Minus,
  Plus,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { useApp } from "@/store/app";
import type { Plan, PlanStep, Zone } from "@/lib/types";
import { parsePlanSteps } from "@/lib/types";
import { getZoneIcon } from "@/lib/zoneIcons";

/**
 * The approved plan while it runs (0.12.1).
 *
 * Until now a long turn was a wall of tool steps scrolling past: you could see
 * what the agent had just done and never what it was going to do next. This is
 * the other view — the task list, ticking off, with the current step marked and
 * a failed one keeping its reason.
 *
 * It is also where the run can be steered without being killed. Cancelling was
 * the only control the app had, and it is the wrong one for "not that step":
 * everything in flight is lost to change one line. Here a step can be struck or
 * added while the turn runs (the list is re-read on every request, so the model
 * sees the change at its next step), and "stop after this step" lets the work in
 * progress finish and be reported rather than thrown away.
 *
 * In a Multizone run the leader's plan and each sub-agent's render in one tree,
 * because a sub-agent's checklist lived in a subchat nobody was watching.
 */
export function TaskPanel({ chatId, streaming }: { chatId: string; streaming: boolean }) {
  const plans = useApp((s) => s.planTreeByChat[chatId]);
  const zones = useApp((s) => s.zones);
  const setPlanSteps = useApp((s) => s.setPlanSteps);
  const requestPlanStop = useApp((s) => s.requestPlanStop);
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Only plans that are actually live are worth a panel; the finished ones stay
  // in the transcript where they happened.
  const live = useMemo(
    () =>
      (plans ?? []).filter((p) =>
        ["approved", "executing", "stopped"].includes(p.status),
      ),
    [plans],
  );
  const root = live.find((p) => !p.parentPlanId) ?? live[0];
  if (!root) return null;
  const children = live.filter((p) => p.parentPlanId === root.id && p.id !== root.id);

  async function strike(plan: Plan, step: PlanStep) {
    const steps = parsePlanSteps(plan).map((s) =>
      s.id === step.id
        ? { ...s, status: (s.status === "skipped" ? "pending" : "skipped") as PlanStep["status"] }
        : s,
    );
    await setPlanSteps(chatId, plan.id, steps);
  }

  async function addStep(plan: Plan) {
    const text = draft.trim();
    if (!text) {
      setAdding(null);
      return;
    }
    const steps = parsePlanSteps(plan);
    await setPlanSteps(chatId, plan.id, [
      ...steps,
      {
        id: `user-${Date.now()}`,
        step: text,
        files: [],
        risk: "low",
        status: "pending",
      },
    ]);
    setDraft("");
    setAdding(null);
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]">
      <PlanRows
        plan={root}
        zone={null}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        streaming={streaming}
        onStrike={strike}
        onStop={() => requestPlanStop(chatId, root.id)}
        adding={adding === root.id}
        draft={draft}
        setDraft={setDraft}
        onStartAdd={() => setAdding(root.id)}
        onCancelAdd={() => { setAdding(null); setDraft(""); }}
        onCommitAdd={() => addStep(root)}
      />
      {!collapsed &&
        children.map((child) => (
          <div key={child.id} className="border-t border-[var(--color-border)] pl-4">
            <PlanRows
              plan={child}
              zone={zones.find((z) => z.id === child.zoneId) ?? null}
              collapsed={false}
              streaming={streaming}
              onStrike={strike}
              onStop={() => requestPlanStop(chatId, child.id)}
              adding={adding === child.id}
              draft={draft}
              setDraft={setDraft}
              onStartAdd={() => setAdding(child.id)}
              onCancelAdd={() => { setAdding(null); setDraft(""); }}
              onCommitAdd={() => addStep(child)}
            />
          </div>
        ))}
    </div>
  );
}

function PlanRows({
  plan,
  zone,
  collapsed,
  onToggle,
  streaming,
  onStrike,
  onStop,
  adding,
  draft,
  setDraft,
  onStartAdd,
  onCancelAdd,
  onCommitAdd,
}: {
  plan: Plan;
  zone: Zone | null;
  collapsed: boolean;
  onToggle?: () => void;
  streaming: boolean;
  onStrike: (plan: Plan, step: PlanStep) => void;
  onStop: () => void;
  adding: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onCommitAdd: () => void;
}) {
  const steps = parsePlanSteps(plan);
  const done = steps.filter((s) => s.status === "done").length;
  const settled = steps.filter((s) =>
    ["done", "skipped", "failed"].includes(s.status),
  ).length;
  const pct = steps.length ? Math.round((settled / steps.length) * 100) : 0;
  const ZoneIcon = zone ? getZoneIcon(zone.icon) : null;

  return (
    <div className="flex flex-col gap-2 p-2.5">
      <div className="flex items-center gap-2 text-xs">
        {onToggle && (
          <button
            onClick={onToggle}
            className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label={collapsed ? "Show the task list" : "Hide the task list"}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        )}
        {ZoneIcon && zone && (
          <span
            className="flex h-4 w-4 items-center justify-center rounded"
            style={{ background: zone.accentColor ?? "var(--color-accent)" }}
            title={zone.name}
          >
            <ZoneIcon size={10} color="white" />
          </span>
        )}
        <span className="truncate font-medium text-[var(--color-text)]">
          {zone ? `${zone.name} · ` : ""}
          {plan.title || "Plan"}
        </span>
        <span className="shrink-0 text-[var(--color-text-muted)]">
          {done} of {steps.length} done
        </span>
        {plan.status === "stopped" && (
          <span className="shrink-0 rounded bg-[var(--color-panel-hover)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            stopped
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="h-1 w-20 overflow-hidden rounded-full bg-[var(--color-border)]">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          {streaming && plan.status !== "stopped" && (
            <button
              onClick={onStop}
              disabled={plan.stopRequested}
              title="Let the current step finish, then stop and report — rather than cancelling and losing it"
              className="flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              <Square size={8} />
              {plan.stopRequested ? "Stopping…" : "Stop after this step"}
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          <ul className="flex flex-col gap-1">
            {steps.map((s) => (
              <li key={s.id} className="group flex items-start gap-2 text-xs">
                <StatusIcon status={s.status} />
                <div className="min-w-0 flex-1">
                  <span
                    className={
                      s.status === "done"
                        ? "text-[var(--color-text-muted)] line-through"
                        : s.status === "skipped"
                          ? "text-[var(--color-text-muted)] line-through opacity-60"
                          : s.status === "in_progress"
                            ? "font-medium text-[var(--color-text)]"
                            : s.status === "failed"
                              ? "text-[var(--color-danger)]"
                              : "text-[var(--color-text-muted)]"
                    }
                  >
                    {s.step}
                  </span>
                  {(s.error || s.note) && (
                    <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                      {s.error ?? s.note}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => onStrike(plan, s)}
                  title={s.status === "skipped" ? "Put this step back" : "Strike this step"}
                  className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition hover:text-[var(--color-text)] group-hover:opacity-100"
                >
                  {s.status === "skipped" ? <Undo2 size={11} /> : <Minus size={11} />}
                </button>
              </li>
            ))}
          </ul>

          {adding ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={draft}
                placeholder="Add a step"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommitAdd();
                  if (e.key === "Escape") onCancelAdd();
                }}
                className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              <button onClick={onCommitAdd} className="rounded p-1 text-[var(--color-accent)]" aria-label="Add">
                <Check size={12} />
              </button>
              <button onClick={onCancelAdd} className="rounded p-1 text-[var(--color-text-muted)]" aria-label="Cancel">
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              onClick={onStartAdd}
              className="flex w-fit items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <Plus size={10} /> Add a step
            </button>
          )}
        </>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: PlanStep["status"] }) {
  const cls = "mt-0.5 h-3.5 w-3.5 shrink-0";
  switch (status) {
    case "done":
      return <Check className={`${cls} text-green-500`} />;
    case "in_progress":
      return <CircleDot className={`${cls} animate-pulse text-[var(--color-accent)]`} />;
    case "skipped":
      return <Minus className={`${cls} text-[var(--color-text-muted)]`} />;
    case "failed":
      return <AlertTriangle className={`${cls} text-[var(--color-danger)]`} />;
    default:
      return <Circle className={`${cls} text-[var(--color-text-muted)]`} />;
  }
}
