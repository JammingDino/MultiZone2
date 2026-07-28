import { useMemo, useState } from "react";
import { Activity, AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { Step } from "@/lib/grouping";
import { stepLabel, summarizeRun } from "@/lib/stepSummary";
import { StepBlock, ToolStepVisual } from "./StepBlock";

/**
 * One run of consecutive thinking/tool steps, collapsed into a single
 * horizontal strip — the counterpart to the vertical accent line beside a
 * response. While the model is working the strip names the step it is on
 * ("Reading file · notes.md"); once done it reports the run as a whole. Click
 * expands the full per-step cards, which is the same view compact mode off
 * shows all the time.
 *
 * Anything the run produced that the user actually asked for — a plan, a
 * diagram, a plot, a presented file — is rendered beneath the strip and is
 * never hidden by collapsing it.
 */
export function ActivityRail({
  steps,
  startIndex,
  chatId,
}: {
  steps: Step[];
  /** Step number of the first step in this run, so numbering spans the turn. */
  startIndex: number;
  chatId: string;
}) {
  const [open, setOpen] = useState(false);
  const { current, errors, warnings, toolCount, active, visualSteps } = useMemo(
    () => summarizeRun(steps),
    [steps],
  );

  const issues = errors + warnings;
  const label = active
    ? stepLabel(current)
    : steps.length === 1
      ? stepLabel(current)
      : `Worked through ${steps.length} steps`;

  /**
   * One failed step out of twenty-seven is not a failed run — the model usually
   * reads the error and carries on, and painting the whole strip red reports a
   * working turn as a broken one. So the alarm is reserved for a run where every
   * tool failed; anything short of that is a count against the run's total
   * steps, and the strip stays neutral.
   *
   * The count is out of *steps*, matching the "N steps" the strip already
   * reports, rather than out of tool calls alone — two denominators for the same
   * strip would just invite the reader to work out why they disagree.
   */
  const allFailed = toolCount > 0 && errors === toolCount;
  const issueText =
    errors > 0
      ? `${errors}/${steps.length} steps failed`
      : `${warnings}/${steps.length} steps needed setup`;

  const icon = active ? (
    <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
  ) : allFailed ? (
    <AlertCircle size={12} className="text-[var(--color-danger)]" />
  ) : issues > 0 ? (
    <AlertTriangle size={12} className="text-amber-400" />
  ) : (
    <Activity size={12} className="text-[var(--color-text-muted)]" />
  );

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide the step-by-step trace" : "Show the step-by-step trace"}
        className="group flex w-full items-center gap-2 py-1 text-left text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        <span className="flex-shrink-0">{icon}</span>
        <span className={`min-w-0 truncate ${active ? "text-[var(--color-text)]" : ""}`}>
          {label}
        </span>
        {/* The horizontal rule that gives the strip its rail look. */}
        <span
          aria-hidden
          className="h-px min-w-4 flex-1 bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-text-muted)]"
        />
        {issues > 0 && (
          <span
            className={`flex-shrink-0 tabular-nums ${allFailed ? "text-[var(--color-danger)]" : "text-amber-400"}`}
          >
            {issueText}
          </span>
        )}
        {/* The issue count already names the total, so a second "N steps" here
            would just repeat it. */}
        {issues === 0 && steps.length > 1 && (
          <span className="flex-shrink-0 tabular-nums">{steps.length} steps</span>
        )}
        <span className="flex-shrink-0">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-l border-[var(--color-border)] pl-3">
          {steps.map((step, i) => (
            <StepBlock
              key={step.key}
              step={step}
              index={startIndex + i}
              chatId={chatId}
              hideVisual
            />
          ))}
        </div>
      )}

      {visualSteps.map((step) => (
        <ToolStepVisual key={`visual-${step.key}`} step={step} chatId={chatId} />
      ))}
    </div>
  );
}
