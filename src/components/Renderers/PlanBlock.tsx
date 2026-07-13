import { Check, Circle, CircleDot, Minus } from "lucide-react";

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
