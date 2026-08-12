import { AlertTriangle, Check, Circle, CircleDot, ClipboardList, FileText, Minus } from "lucide-react";
import type { PlanStep as ArtifactStep } from "@/lib/types";

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "done" | "skipped";
}

/**
 * The model's own checklist for a multi-step task (0.9.3, `update_plan`).
 * Rendered inline in the tool step so the user can see the plan and its progress
 * rather than a raw JSON blob. Each call replaces the whole list, so the newest
 * plan block in a turn is the current one.
 */
export function PlanBlock({ steps, done, total }: { steps: PlanStep[]; done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text)]">Plan</span>
        <span>
          {done} of {total} done
        </span>
        <div className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-[var(--color-border)]">
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <ul className="flex flex-col gap-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <StatusIcon status={s.status} />
            <span
              className={
                s.status === "done"
                  ? "text-[var(--color-text-muted)] line-through"
                  : s.status === "skipped"
                    ? "text-[var(--color-text-muted)] line-through opacity-60"
                    : s.status === "in_progress"
                      ? "font-medium text-[var(--color-text)]"
                      : "text-[var(--color-text-muted)]"
              }
            >
              {s.step}
            </span>
          </li>
        ))}
      </ul>
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
    default:
      return <Circle className={`${cls} text-[var(--color-text-muted)]`} />;
  }
}

/** Parse an `update_plan` tool result into props, or null if it isn't one. */
export function toPlanData(parsed: any): { steps: PlanStep[]; done: number; total: number } | null {
  if (!parsed || !Array.isArray(parsed.steps)) return null;
  const steps: PlanStep[] = parsed.steps
    .filter((s: any) => s && typeof s.step === "string")
    .map((s: any) => ({
      step: s.step,
      status: ["pending", "in_progress", "done", "skipped"].includes(s.status) ? s.status : "pending",
    }));
  if (steps.length === 0) return null;
  return {
    steps,
    done: typeof parsed.done === "number" ? parsed.done : steps.filter((s) => s.status === "done").length,
    total: typeof parsed.total === "number" ? parsed.total : steps.length,
  };
}

/**
 * A filed plan, as it appears in the transcript (0.12.0, `exit_plan_mode`).
 *
 * Read-only on purpose: the editable copy is the card at the composer, which is
 * the one place a decision is being asked for. Once that decision is made this
 * block is the record of what was proposed — which is worth keeping visible
 * even (especially) when the user approved something different.
 */
export function PlanProposalBlock({
  title,
  goal,
  steps,
  awaiting,
}: {
  title?: string;
  goal?: string | null;
  steps: ArtifactStep[];
  awaiting?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <ClipboardList size={12} className="text-[var(--color-accent)]" />
        <span className="font-medium text-[var(--color-text)]">{title || "Plan"}</span>
        <span className="text-[var(--color-text-muted)]">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
        {awaiting && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--color-accent)]">
            waiting for you
          </span>
        )}
      </div>
      {goal && <div className="text-xs text-[var(--color-text-muted)]">{goal}</div>}
      <ol className="flex flex-col gap-1">
        {steps.map((s, i) => (
          <li key={s.id ?? i} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 w-4 shrink-0 text-right text-[11px] text-[var(--color-text-muted)]">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <span className="text-[var(--color-text)]">{s.step}</span>
              {s.intent && (
                <span className="text-[var(--color-text-muted)]"> — {s.intent}</span>
              )}
              {(s.files?.length ?? 0) > 0 && (
                <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
                  {s.files.map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center gap-1 rounded bg-[var(--color-panel-hover)] px-1 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                    >
                      <FileText size={8} /> {f}
                    </span>
                  ))}
                </span>
              )}
            </div>
            {s.risk && s.risk !== "low" && (
              <span
                className={`flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] ${
                  s.risk === "high"
                    ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                    : "bg-amber-400/15 text-amber-400"
                }`}
              >
                <AlertTriangle size={8} /> {s.risk}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Parse an `exit_plan_mode` tool result, or null if it isn't one. */
export function toPlanProposal(
  parsed: any,
): { title?: string; goal?: string | null; steps: ArtifactStep[]; awaiting: boolean } | null {
  if (!parsed || !Array.isArray(parsed.steps) || parsed.rendered !== "plan_proposal") return null;
  const steps = parsed.steps.filter((s: any) => s && typeof s.step === "string");
  if (steps.length === 0) return null;
  return {
    title: typeof parsed.title === "string" ? parsed.title : undefined,
    goal: typeof parsed.goal === "string" ? parsed.goal : null,
    steps,
    awaiting: parsed.status === "waiting_for_user",
  };
}
