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
  const { current, errors, warnings, active, visualSteps } = useMemo(
    () => summarizeRun(steps),
    [steps],
  );

  const issues = errors + warnings;
  const label = active
    ? stepLabel(current)
    : steps.length === 1
      ? stepLabel(current)
      : `Worked through ${steps.length} steps`;

  const icon = active ? (
    <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
  ) : errors > 0 ? (
    <AlertCircle size={12} className="text-[var(--color-danger)]" />
  ) : warnings > 0 ? (
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
            className={`flex-shrink-0 ${errors > 0 ? "text-[var(--color-danger)]" : "text-amber-400"}`}
          >
            {issues} {issues === 1 ? "issue" : "issues"}
          </span>
        )}
        {steps.length > 1 && (
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
