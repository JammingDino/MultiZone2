import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileText,
  List,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  SquareArrowOutUpRight,
  Target,
  Trash2,
  X,
} from "lucide-react";
import type { Plan, PlanStep } from "@/lib/types";
import { parsePlanSteps } from "@/lib/types";
import { Markdown } from "@/components/Renderers/Markdown";
import { openPath } from "@/lib/tauri";
import { CHROME_QUIET, PRIMARY_ACTION } from "@/lib/chrome";
import { usePersistentBool } from "@/lib/uiState";

/**
 * The plan the model filed, waiting on the user (0.12.0, rebuilt in 0.12.7).
 *
 * Every planning harness worth copying ends with prose and a yes/no. This one
 * ends with the plan as a list the user can actually rewrite — reorder a step,
 * strike one, fix the wording, add the step the model missed — because a plan
 * you can only accept or reject is still the model's plan. What is approved is
 * what gets executed: the steps below are written back to the plan row and fed
 * to the executing turn from there, so an edit here is binding rather than a
 * comment the model may or may not honour.
 *
 * Two things changed in 0.12.7, both because a plan is now a document rather
 * than a list of headings.
 *
 * **It is paged.** A step carries a specification — several paragraphs, often a
 * table — and eight of those stacked vertically is a page nobody reads. One
 * step at a time, with the rail above it for jumping and reordering, is the
 * shape that matches how the thing is actually reviewed: you read step 3,
 * decide about step 3, move on.
 *
 * **It is bounded.** The card used to grow to whatever the plan needed and
 * shove the transcript off the top of the window, taking the composer with it —
 * so the only way to object was the "Keep planning" button, and the wheel did
 * nothing anywhere near it because the region was not a scroll container at
 * all. It now has a ceiling and scrolls inside it, the detail pane scrolls
 * inside *that*, and the composer stays where it was: typing an objection is a
 * better answer than a button, and it was the one thing the layout forbade.
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
  // Which step is on screen. Held by id rather than index so reordering the
  // list keeps the reader on the step they were reading.
  const [cursorId, setCursorId] = useState<string | null>(original[0]?.id ?? null);
  const [onContext, setOnContext] = useState(false);
  // Paged or all-at-once. Persisted: someone who prefers the whole list should
  // not have to say so again on the next plan.
  const [listView, setListView] = usePersistentBool("planReviewList", false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const context = plan.context?.trim() || "";

  // A newer plan replacing this one (the model revised after a rejection)
  // resets the editor — otherwise the user would be editing the old proposal.
  useEffect(() => {
    setSteps(original);
    setEditingId(null);
    setCursorId(original[0]?.id ?? null);
    setOnContext(!!plan.context?.trim());
  }, [plan.id, plan.context, original]);

  const edited = useMemo(
    () => JSON.stringify(steps) !== JSON.stringify(original),
    [steps, original],
  );

  const index = Math.max(0, steps.findIndex((s) => s.id === cursorId));
  const current = steps[index] ?? null;

  function go(to: number) {
    if (to < 0) {
      if (context) setOnContext(true);
      return;
    }
    const clamped = Math.min(Math.max(to, 0), steps.length - 1);
    const next = steps[clamped];
    if (!next) return;
    setOnContext(false);
    setCursorId(next.id);
    // A long step scrolled halfway down should not leave the next one opening
    // mid-paragraph.
    scrollRef.current?.scrollTo({ top: 0 });
  }

  function move(i: number, delta: number) {
    const to = i + delta;
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    [next[i], next[to]] = [next[to], next[i]];
    setSteps(next);
  }
  function remove(id: string) {
    setSteps((s) => {
      const next = s.filter((x) => x.id !== id);
      if (id === cursorId) setCursorId(next[Math.min(index, next.length - 1)]?.id ?? null);
      return next;
    });
  }
  function patch(id: string, fields: Partial<PlanStep>) {
    setSteps((s) => s.map((x) => (x.id === id ? { ...x, ...fields } : x)));
  }
  function add() {
    // A locally-minted id is fine: the backend keeps whatever id it is given
    // and only ever uses it to match a step to its live status.
    const id = `new-${Date.now()}-${steps.length}`;
    setSteps((s) => [...s, { id, step: "", files: [], risk: "low", status: "pending" }]);
    setEditingId(id);
    setCursorId(id);
    setOnContext(false);
    if (listView) setListView(false);
  }

  const canApprove = steps.length > 0 && steps.every((s) => s.step.trim().length > 0);
  const thin = steps.filter((s) => (s.detail?.trim().length ?? 0) < 120).length;

  return (
    /* A floor as well as a ceiling: without one the card resizes on every page
       turn — tall for a step with three screens of specification, short for the
       next one — and the Approve button moves under the pointer between them. */
    <div className="flex max-h-[min(46vh,560px)] min-h-[15rem] flex-col overflow-hidden rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-panel)]">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-[var(--color-border)] px-3 pb-2 pt-2.5">
        <div className="flex items-start gap-2">
          <ClipboardList size={16} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{plan.title || "Plan"}</div>
            {plan.goal && (
              <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{plan.goal}</div>
            )}
          </div>
          {plan.docPath && (
            <button
              onClick={() => void openPath(plan.docPath!).catch(console.error)}
              title={`Open the plan document — ${plan.docPath}`}
              className={`shrink-0 rounded p-1 ${CHROME_QUIET}`}
              aria-label="Open the plan document"
            >
              <SquareArrowOutUpRight size={12} />
            </button>
          )}
          <button
            onClick={() => setListView(!listView)}
            title={listView ? "Read the steps one at a time" : "See every step at once"}
            className={`shrink-0 rounded p-1 ${CHROME_QUIET}`}
            aria-label={listView ? "Paged view" : "List view"}
          >
            {listView ? <BookOpen size={12} /> : <List size={12} />}
          </button>
        </div>

        {!listView && (
          <StepRail
            steps={steps}
            index={index}
            onContext={onContext}
            hasContext={!!context}
            onPick={(i) => go(i)}
            onPickContext={() => setOnContext(true)}
          />
        )}
      </div>

      {/* ── Body: bounded, and where all the scrolling happens ──────────
          `overflow-hidden` rather than `overflow-y-auto`, because the paged
          view wants its *detail pane* to take the leftover height and scroll
          there — so the step's heading, its risk chip and its move/edit/remove
          buttons stay pinned while you read three screens of specification.
          The other views scroll as a whole, which is right for them.

          A flex column, and every view below is a flex *item* of it — not a
          `h-full` block. `height: 100%` against a parent whose height came from
          the flex algorithm does not resolve here: it falls back to auto, the
          view grows past its container, and `overflow-hidden` clips the
          specification instead of scrolling it. A flex item's main size is
          definite, so `min-h-0 flex-1` gets the height `h-full` only appeared
          to. */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2.5">
        {listView ? (
          <ol className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
            {steps.map((s, i) => (
              <li key={s.id}>
                <CompactRow
                  step={s}
                  index={i}
                  count={steps.length}
                  onOpen={() => { setListView(false); go(i); }}
                  onMove={(d) => move(i, d)}
                  onRemove={() => remove(s.id)}
                />
              </li>
            ))}
            {steps.length === 0 && (
              <li className="py-4 text-center text-xs italic text-[var(--color-text-muted)]">
                Every step was removed — add one, or keep planning.
              </li>
            )}
          </ol>
        ) : onContext && context ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SectionLabel icon={<BookOpen size={11} />} text="Context, assumptions and open questions" />
            <Markdown source={context} className="mz-plan-prose" fontSize="0.78rem" />
          </div>
        ) : current ? (
          editingId === current.id ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <StepEditor
                step={current}
                index={index}
                onChange={(fields) => patch(current.id, fields)}
                onDone={() => setEditingId(null)}
              />
            </div>
          ) : (
            <StepPage
              step={current}
              index={index}
              count={steps.length}
              onEdit={() => setEditingId(current.id)}
              onMove={(d) => move(index, d)}
              onRemove={() => remove(current.id)}
            />
          )
        ) : (
          <div className="py-4 text-center text-xs italic text-[var(--color-text-muted)]">
            Every step was removed — add one, or keep planning.
          </div>
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-[var(--color-border)] px-3 py-2">
        {!listView && steps.length > 0 && (
          <div className="mb-2 flex items-center gap-2">
            <button
              onClick={() => (onContext ? undefined : go(index - 1))}
              disabled={onContext || (index === 0 && !context)}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${CHROME_QUIET} disabled:opacity-30`}
            >
              <ChevronLeft size={12} /> Back
            </button>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {onContext ? "Context" : `Step ${index + 1} of ${steps.length}`}
            </span>
            <button
              onClick={() => (onContext ? go(0) : go(index + 1))}
              disabled={!onContext && index >= steps.length - 1}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${CHROME_QUIET} disabled:opacity-30`}
            >
              Next <ChevronRight size={12} />
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={add}
            className={`flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs ${CHROME_QUIET}`}
          >
            <Plus size={11} /> Add step
          </button>
          {edited && (
            <button
              onClick={() => { setSteps(original); setEditingId(null); }}
              className={`flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs ${CHROME_QUIET}`}
            >
              <RotateCcw size={11} /> Reset to the proposal
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onReject}
              disabled={busy}
              className={`rounded border border-[var(--color-border)] px-2.5 py-1 text-xs ${CHROME_QUIET} disabled:opacity-50`}
            >
              Keep planning
            </button>
            <button
              onClick={() => onApprove(steps, edited)}
              disabled={busy || !canApprove}
              title={canApprove ? undefined : "Every step needs some text"}
              className={`flex items-center gap-1 rounded px-3 py-1 text-xs font-medium ${PRIMARY_ACTION}`}
            >
              <Check size={12} /> {edited ? "Approve my version" : "Approve & run"}
            </button>
          </div>
        </div>

        <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
          {edited
            ? "Approving runs your edited steps — the model is held to these, not to what it proposed."
            : thin > 0 && thin * 2 > steps.length
              ? "Most of these steps carry no detail. “Keep planning” — or just say what is missing in the box below — and the model fills them in."
              : "Approving runs these steps in order. Say what is wrong in the box below, or press “Keep planning”, and the model revises."}
        </p>
      </div>
    </div>
  );
}

/**
 * The numbered rail. Doubles as the overview a paged view otherwise loses: how
 * many steps there are, which ones are risky, and where you are among them.
 */
function StepRail({
  steps,
  index,
  onContext,
  hasContext,
  onPick,
  onPickContext,
}: {
  steps: PlanStep[];
  index: number;
  onContext: boolean;
  hasContext: boolean;
  onPick: (index: number) => void;
  onPickContext: () => void;
}) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-0.5">
      {hasContext && (
        <button
          onClick={onPickContext}
          title="Context, assumptions and open questions"
          className={`flex h-5 shrink-0 items-center rounded px-1.5 text-[10px] transition ${
            onContext
              ? "bg-[var(--color-accent)] text-white"
              : `border border-[var(--color-border)] ${CHROME_QUIET}`
          }`}
        >
          Context
        </button>
      )}
      {steps.map((s, i) => {
        const active = !onContext && i === index;
        const risky = s.risk === "high" || s.risk === "medium";
        return (
          <button
            key={s.id}
            onClick={() => onPick(i)}
            title={s.step || "empty step"}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] transition ${
              active
                ? "bg-[var(--color-accent)] font-medium text-white"
                : risky
                  ? `border ${s.risk === "high" ? "border-[var(--color-danger)]/60" : "border-amber-400/60"} ${CHROME_QUIET}`
                  : `border border-[var(--color-border)] ${CHROME_QUIET}`
            }`}
          >
            {i + 1}
          </button>
        );
      })}
    </div>
  );
}

/** One step, read in full: the heading, then the specification under it. */
function StepPage({
  step,
  index,
  count,
  onEdit,
  onMove,
  onRemove,
}: {
  step: PlanStep;
  index: number;
  count: number;
  onEdit: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const detail = step.detail?.trim() || "";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-start gap-2">
        <span className="mt-[3px] shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">
          {index + 1}.
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--color-text)]">
            {step.step || <span className="italic text-[var(--color-text-muted)]">empty step</span>}
          </div>
          {step.intent && (
            <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{step.intent}</div>
          )}
        </div>
        <RiskChip risk={step.risk} />
        <div className="flex shrink-0 items-center gap-0.5">
          <IconBtn label="Move up" onClick={() => onMove(-1)} disabled={index === 0}>
            <ArrowUp size={11} />
          </IconBtn>
          <IconBtn label="Move down" onClick={() => onMove(1)} disabled={index === count - 1}>
            <ArrowDown size={11} />
          </IconBtn>
          <IconBtn label="Edit" onClick={onEdit}>
            <Pencil size={11} />
          </IconBtn>
          <IconBtn label="Remove" onClick={onRemove}>
            <Trash2 size={11} />
          </IconBtn>
        </div>
      </div>

      {/* Everything except the heading scrolls together in what is left of the
          card. Only the heading and its buttons are pinned, because those are
          the navigation — pinning the acceptance line and the file chips too
          looked tidier and left the specification about 90px to live in, which
          is the one thing on this card anybody came to read. */}
      <div className="flex min-h-[4rem] flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
        {detail ? (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2.5 py-2">
            <Markdown source={detail} className="mz-plan-prose" fontSize="0.78rem" />
          </div>
        ) : (
          <div className="rounded border border-dashed border-[var(--color-border)] px-2.5 py-2 text-[11px] italic text-[var(--color-text-muted)]">
            No detail — the model gave this step a heading and nothing else.
          </div>
        )}

        {step.acceptance && (
          <div className="flex shrink-0 items-start gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2.5 py-1.5">
            <Target size={11} className="mt-[3px] shrink-0 text-[var(--color-accent)]" />
            <div className="min-w-0 text-[11px] text-[var(--color-text-muted)]">
              <span className="font-medium text-[var(--color-text)]">Done when </span>
              {step.acceptance}
            </div>
          </div>
        )}

        {(step.files?.length ?? 0) > 0 && (
          <div className="flex shrink-0 flex-wrap gap-1">
            {step.files.map((f) => (
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
    </div>
  );
}

/** The whole plan at a glance — for reordering and striking, not for reading. */
function CompactRow({
  step,
  index,
  count,
  onOpen,
  onMove,
  onRemove,
}: {
  step: PlanStep;
  index: number;
  count: number;
  onOpen: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const detailLen = step.detail?.trim().length ?? 0;
  return (
    <div className="group flex items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2.5 py-1.5">
      <span className="mt-0.5 w-4 shrink-0 text-right text-[11px] tabular-nums text-[var(--color-text-muted)]">
        {index + 1}
      </span>
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="truncate text-xs text-[var(--color-text)]">
          {step.step || <span className="italic text-[var(--color-text-muted)]">empty step</span>}
        </div>
        <div className="truncate text-[10px] text-[var(--color-text-muted)]">
          {detailLen > 0 ? `${step.intent ? `${step.intent} · ` : ""}${detailLen} characters of detail` : "no detail"}
        </div>
      </button>
      <RiskChip risk={step.risk} />
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        <IconBtn label="Move up" onClick={() => onMove(-1)} disabled={index === 0}>
          <ArrowUp size={11} />
        </IconBtn>
        <IconBtn label="Move down" onClick={() => onMove(1)} disabled={index === count - 1}>
          <ArrowDown size={11} />
        </IconBtn>
        <IconBtn label="Remove" onClick={onRemove}>
          <Trash2 size={11} />
        </IconBtn>
      </div>
    </div>
  );
}

function SectionLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {icon}
      {text}
    </div>
  );
}

function StepEditor({
  step,
  index,
  onChange,
  onDone,
}: {
  step: PlanStep;
  index: number;
  onChange: (fields: Partial<PlanStep>) => void;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">{index + 1}.</span>
        <input
          autoFocus
          value={step.step}
          placeholder="What is done in this step"
          onChange={(e) => onChange({ step: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") onDone();
          }}
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <button
          onClick={onDone}
          className={`rounded p-1 ${CHROME_QUIET}`}
          aria-label="Done editing"
          title="Done editing"
        >
          <X size={12} />
        </button>
      </div>
      <input
        value={step.intent ?? ""}
        placeholder="Why this step exists (one line)"
        onChange={(e) => onChange({ intent: e.target.value })}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
      />
      <textarea
        value={step.detail ?? ""}
        placeholder="The specification — approach, alternatives rejected, concrete parameters. Markdown."
        onChange={(e) => onChange({ detail: e.target.value })}
        rows={8}
        className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
      />
      <input
        value={step.acceptance ?? ""}
        placeholder="Done when… (how anyone tells this step is actually finished)"
        onChange={(e) => onChange({ acceptance: e.target.value })}
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
      className={`rounded p-1 ${CHROME_QUIET} disabled:opacity-30`}
    >
      {children}
    </button>
  );
}
