import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardList,
  FileText,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import type { Plan, PlanStep } from "@/lib/types";
import { parsePlanSteps } from "@/lib/types";

/**
 * The plan the model filed, waiting on the user (0.12.0).
 *
 * Every planning harness worth copying ends with prose and a yes/no. This one
 * ends with the plan as a list the user can actually rewrite — reorder a step,
 * strike one, fix the wording, add the step the model missed — because a plan
 * you can only accept or reject is still the model's plan. What is approved is
 * what gets executed: the steps below are written back to the plan row and fed
 * to the executing turn from there, so an edit here is binding rather than a
 * comment the model may or may not honour.
 *
 * Rejecting keeps the chat in plan mode: the next message is the objection and
 * the model revises, which is a far cheaper move than cancelling the turn and
 * starting the conversation again.
 */
export function PlanReview({
  plan,
  busy,
  onApprove,
  onReject,
}: {
  plan: Plan;
  busy?: boolean;
  onApprove: (steps: PlanStep[], edited: boolean) => void;
  onReject: () => void;
}) {
  const original = useMemo(() => parsePlanSteps(plan), [plan]);
  const [steps, setSteps] = useState<PlanStep[]>(original);
  const [editingId, setEditingId] = useState<string | null>(null);

  // A newer plan replacing this one (the model revised after a rejection)
  // resets the editor — otherwise the user would be editing the old proposal.
  useEffect(() => {
    setSteps(original);
    setEditingId(null);
  }, [plan.id, original]);

  const edited = useMemo(
    () => JSON.stringify(steps) !== JSON.stringify(original),
    [steps, original],
  );

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    [next[index], next[to]] = [next[to], next[index]];
    setSteps(next);
  }
  function remove(id: string) {
    setSteps((s) => s.filter((x) => x.id !== id));
  }
  function patch(id: string, fields: Partial<PlanStep>) {
    setSteps((s) => s.map((x) => (x.id === id ? { ...x, ...fields } : x)));
  }
  function add() {
    // A locally-minted id is fine: the backend keeps whatever id it is given
    // and only ever uses it to match a step to its live status.
    const id = `new-${Date.now()}-${steps.length}`;
    setSteps((s) => [
      ...s,
      { id, step: "", files: [], risk: "low", status: "pending" },
    ]);
    setEditingId(id);
  }

  const canApprove = steps.length > 0 && steps.every((s) => s.step.trim().length > 0);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-panel)] p-3">
      <div className="flex items-start gap-2">
        <ClipboardList size={16} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{plan.title || "Plan"}</div>
          {plan.goal && (
            <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{plan.goal}</div>
          )}
        </div>
        <div className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </div>
      </div>

      <ol className="flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li
            key={s.id}
            className="group rounded border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2.5 py-2"
          >
            {editingId === s.id ? (
              <StepEditor
                step={s}
                onChange={(fields) => patch(s.id, fields)}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <div className="flex items-start gap-2">
                <span className="mt-0.5 w-4 shrink-0 text-right text-[11px] text-[var(--color-text-muted)]">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-[var(--color-text)]">
                    {s.step || <span className="italic text-[var(--color-text-muted)]">empty step</span>}
                  </div>
                  {s.intent && (
                    <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{s.intent}</div>
                  )}
                  {(s.files?.length ?? 0) > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.files.map((f) => (
                        <span
                          key={f}
                          className="inline-flex items-center gap-1 rounded bg-[var(--color-panel-hover)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                        >
                          <FileText size={9} /> {f}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <RiskChip risk={s.risk} />
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                  <IconBtn label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                    <ArrowUp size={11} />
                  </IconBtn>
                  <IconBtn label="Move down" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>
                    <ArrowDown size={11} />
                  </IconBtn>
                  <IconBtn label="Edit" onClick={() => setEditingId(s.id)}>
                    <Pencil size={11} />
                  </IconBtn>
                  <IconBtn label="Remove" onClick={() => remove(s.id)}>
                    <Trash2 size={11} />
                  </IconBtn>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={add}
          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          <Plus size={11} /> Add step
        </button>
        {edited && (
          <button
            onClick={() => setSteps(original)}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <RotateCcw size={11} /> Reset to the proposal
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onReject}
            disabled={busy}
            className="rounded border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Keep planning
          </button>
          <button
            onClick={() => onApprove(steps, edited)}
            disabled={busy || !canApprove}
            title={canApprove ? undefined : "Every step needs some text"}
            className="flex items-center gap-1 rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            <Check size={12} /> {edited ? "Approve my version" : "Approve & run"}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-[var(--color-text-muted)]">
        {edited
          ? "Approving runs your edited steps — the model is held to these, not to what it proposed."
          : "Approving runs these steps in order. “Keep planning” stays in plan mode: say what is wrong and the model revises."}
      </p>
    </div>
  );
}

function StepEditor({
  step,
  onChange,
  onDone,
}: {
  step: PlanStep;
  onChange: (fields: Partial<PlanStep>) => void;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <input
        autoFocus
        value={step.step}
        placeholder="What is done in this step"
        onChange={(e) => onChange({ step: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") onDone();
        }}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
      />
      <input
        value={step.intent ?? ""}
        placeholder="Why (optional)"
        onChange={(e) => onChange({ intent: e.target.value })}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
      />
      <div className="flex items-center gap-2">
        <input
          value={step.files?.join(", ") ?? ""}
          placeholder="Files (comma separated)"
          onChange={(e) =>
            onChange({
              files: e.target.value
                .split(",")
                .map((f) => f.trim())
                .filter(Boolean),
            })
          }
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
        />
        <select
          value={step.risk}
          onChange={(e) => onChange({ risk: e.target.value as PlanStep["risk"] })}
          className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1.5 py-1 text-[11px] outline-none"
        >
          <option value="low">low risk</option>
          <option value="medium">medium risk</option>
          <option value="high">high risk</option>
        </select>
        <button
          onClick={onDone}
          className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          aria-label="Done editing"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

/** Risk is the column the user reads first, so it is a chip and not a word. */
export function RiskChip({ risk }: { risk: PlanStep["risk"] }) {
  if (risk === "low") return null;
  const high = risk === "high";
  return (
    <span
      title={high ? "High risk — getting this wrong is expensive" : "Medium risk"}
      className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
        high
          ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
          : "bg-amber-400/15 text-amber-400"
      }`}
    >
      <ShieldAlert size={9} /> {risk}
    </span>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}
