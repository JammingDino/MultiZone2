import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  ChevronRight,
  ChevronDown,
  Brain,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  HelpCircle,
  Send,
  X,
} from "lucide-react";
import type { Step, ToolStep, ThinkingStep } from "@/lib/grouping";
import { analyzeToolStep } from "@/lib/stepSummary";
import { useThrottledStreaming } from "@/lib/useThrottledStreaming";
import { MathPlotBlock, toMathPlotData } from "@/components/Renderers/MathPlotBlock";
import { MermaidBlock, type MermaidAutoFix } from "@/components/Renderers/MermaidBlock";
import { HtmlReportBlock } from "@/components/Renderers/HtmlReportBlock";
import { SavedFileChip } from "@/components/Renderers/SavedFileChip";
import { PlanBlock, PlanProposalBlock, toPlanData, toPlanProposal } from "@/components/Renderers/PlanBlock";
import { ToolVisual, hasToolVisual } from "./visuals/ToolVisual";
import { familyIcon } from "./visuals/familyIcon";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { useDictation, MicButton, DictationMeter } from "@/components/Chat/useDictation";
import { CHROME_OUTLINED, PRIMARY_ACTION } from "@/lib/chrome";

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function StepBlock({
  step,
  index,
  chatId,
  hideVisual = false,
}: {
  step: Step;
  index: number;
  chatId: string;
  /**
   * Set when the turn already renders this step's visual output on its own
   * (compact mode lifts plans, diagrams, plots and files out of the rail), so
   * the expanded card doesn't show a second copy.
   */
  hideVisual?: boolean;
}) {
  if (step.kind === "thinking") {
    return <ThinkingStepView step={step} index={index} />;
  }
  return (
    <ToolStepView step={step} index={index} chatId={chatId} hideVisual={hideVisual} />
  );
}

/**
 * A tool step's rendered result on its own — the plan, diagram, plot or file
 * card — with no surrounding step chrome. Compact mode renders these beneath
 * the activity rail so the things the user asked to see never get collapsed
 * away with the mechanics that produced them.
 */
export function ToolStepVisual({ step, chatId }: { step: ToolStep; chatId: string }) {
  const [failed, setFailed] = useState(false);
  const { name, args, resultText } = analyzeToolStep(step);
  const view = renderToolOutput(name, args, resultText, chatId, () => setFailed(true), {
    chatId,
    messageId: step.messageId,
    toolCallId: step.toolCall.id,
  });
  if (!view) return null;
  return (
    <div
      className={
        failed
          ? "rounded-md border border-[var(--color-danger)]/40 p-2"
          : undefined
      }
    >
      {view}
    </div>
  );
}

function ThinkingStepView({ step, index }: { step: ThinkingStep; index: number }) {
  const expandByDefault = useApp((s) => s.appSettings.expandThinkingByDefault);
  // Open while streaming, or if the user has opted into default-expanded.
  const [open, setOpen] = useState(step.streaming || expandByDefault);
  // Reasoning arrives token by token like the answer does, and a long think
  // repainted per token is the same jitter for a cheaper node — throttle it
  // onto the shared stream tick so it repaints with everything else.
  const text = useThrottledStreaming(step.text, Boolean(step.streaming));

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-panel-hover)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} className="text-violet-400" />
        <span className="text-[var(--color-text-muted)]">
          Step {index} · <span className="text-[var(--color-text)]">Thinking</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          {step.streaming ? (
            <Loader2 size={12} className="animate-spin text-violet-400" />
          ) : (
            <CheckCircle2 size={12} className="text-emerald-400" />
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--color-border)] p-3">
          <div className="max-h-[280px] overflow-y-auto pr-1">
            <pre className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-text-muted)]">
              {text}
              {step.streaming && (
                <span className="animate-pulse text-violet-400">▌</span>
              )}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolStepView({
  step,
  index,
  chatId,
  hideVisual = false,
}: {
  step: ToolStep;
  index: number;
  chatId: string;
  hideVisual?: boolean;
}) {
  // Auto-expand while tool args are streaming so the user can see them build up.
  const [open, setOpen] = useState(step.pending);
  const [mermaidFailed, setMermaidFailed] = useState(false);
  const { toolCall, toolResult, pending } = step;

  // Keep open while running so the user sees the executing indicator.
  // Collapse once the result is in.
  useEffect(() => {
    if (!pending && !toolResult) {
      setOpen(true); // show executing state
    } else if (!pending && toolResult) {
      setOpen(false); // collapse when done
    }
  }, [pending, !!toolResult]);

  const {
    name,
    args,
    resultText,
    parsed: parsedResult,
    isError,
    errorKind,
    isSetupIssue,
    status: baseStatus,
  } = analyzeToolStep(step);

  const renderedView =
    toolResult && !hideVisual
      ? renderToolOutput(name, args, resultText, chatId, () => setMermaidFailed(true), {
          chatId,
          messageId: step.messageId,
          toolCallId: toolCall.id,
        })
      : null;

  const status = baseStatus === "done" && mermaidFailed ? "error" : baseStatus;
  // A run of twenty steps was a column of identical wrenches; the family glyph
  // is the one thing that makes a collapsed rail scannable.
  const StepIcon = familyIcon(name);

  const statusIcon =
    status === "running" || status === "pending" ? (
      <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
    ) : status === "error" ? (
      <AlertCircle size={12} className="text-[var(--color-danger)]" />
    ) : status === "warning" ? (
      <AlertTriangle size={12} className="text-amber-400" />
    ) : (
      <CheckCircle2 size={12} className="text-emerald-400" />
    );

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-panel-hover)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <StepIcon
          size={12}
          className={`text-[var(--color-accent)]${pending ? " animate-pulse" : ""}`}
        />
        <span className="text-[var(--color-text-muted)]">
          Step {index} ·{" "}
          <code className="text-[var(--color-text)]">{name}</code>
          {pending && (
            <span className="ml-1 text-[10px] uppercase tracking-wide text-[var(--color-accent)]">
              streaming
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-1">{statusIcon}</span>
      </button>

      {/* Live streaming args — visible while the model is still generating them */}
      {pending && open && (
        <div className="border-t border-[var(--color-border)] p-2 text-xs">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            Building arguments…
          </div>
          <pre className="max-h-[150px] overflow-y-auto whitespace-pre-wrap text-[var(--color-text-muted)]">
            {toolCall.function.arguments || ""}
            <span className="animate-pulse text-[var(--color-accent)]">▌</span>
          </pre>
        </div>
      )}

      {/* Executing indicator — shown while the tool is running (args done, no result yet) */}
      {status === "running" && (
        <div className="border-t border-[var(--color-border)] px-3 py-2.5 text-xs">
          <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
            <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
            <span>Executing <code className="text-[var(--color-text)]">{name}</code>…</span>
          </div>
        </div>
      )}

      {renderedView && (
        <div className="border-t border-[var(--color-border)] p-2">{renderedView}</div>
      )}

      {isSetupIssue && parsedResult && (
        <SetupIssueBanner
          kind={errorKind!}
          message={String(parsedResult.error ?? "")}
          hint={
            typeof parsedResult.hint === "string" ? parsedResult.hint : undefined
          }
          language={
            typeof parsedResult.language === "string"
              ? parsedResult.language
              : undefined
          }
        />
      )}

      {open && (
        <ToolTabs
          name={name}
          args={args}
          argumentsText={toolCall.function.arguments}
          resultText={resultText}
          parsedResult={parsedResult}
          isError={isError}
          isSetupIssue={isSetupIssue}
          /* Only a visual rendered *by this card* counts as already on screen.
             `hideVisual` must not be included: the activity rail sets it on
             every step, and the lifting it refers to only ever applies to the
             `existing` family (plans, diagrams, plots, saved files) — which
             `ToolVisual` returns nothing for anyway. Including it suppressed
             every family card in the rail, which is the whole chat. */
          hasOwnVisual={!!renderedView}
        />
      )}
    </div>
  );
}

/**
 * Visual · Input · Output (0.13.0).
 *
 * The expanded card used to be two `<pre>` blocks of escaped JSON, which is the
 * right thing to have available and the wrong thing to land on. The visual
 * leads; the exact arguments and the exact result string stay one click away,
 * because when something has gone wrong they are what you need — and on an
 * error the Input tab is where the answer usually is, so that is where the card
 * opens.
 */
function ToolTabs({
  name,
  args,
  argumentsText,
  resultText,
  parsedResult,
  isError,
  isSetupIssue,
  hasOwnVisual,
}: {
  name: string;
  args: any;
  argumentsText: string;
  resultText: string | null;
  parsedResult: any;
  isError: boolean;
  isSetupIssue: boolean;
  hasOwnVisual: boolean;
}) {
  const showVisual = !hasOwnVisual && hasToolVisual(name, parsedResult, isError);
  const visual = showVisual ? (
    <ToolVisual name={name} args={args} parsed={parsedResult} isError={isError} />
  ) : null;
  // Visual is the landing tab whenever there is one — expanding a step is a
  // request to see what the tool did, not to read its arguments back.
  const [tab, setTab] = useState<"visual" | "input" | "output">(visual ? "visual" : "input");
  const active = tab === "visual" && !visual ? "input" : tab;

  return (
    <div className="border-t border-[var(--color-border)] text-xs">
      <div className="flex items-center gap-1 px-2 pt-2">
        {visual && <Tab id="visual" active={active} onPick={setTab} label="Visual" />}
        <Tab id="input" active={active} onPick={setTab} label="Input" />
        {resultText !== null && (
          <Tab
            id="output"
            active={active}
            onPick={setTab}
            label={isError ? (isSetupIssue ? "Details" : "Error") : "Output"}
          />
        )}
      </div>
      <div className="p-2">
        {active === "visual" && visual}
        {active === "input" && (
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap text-[var(--color-text-muted)]">
            {argumentsText ? prettyJson(argumentsText) : "(none)"}
          </pre>
        )}
        {active === "output" && resultText !== null && (
          <pre
            className={`max-h-[320px] overflow-auto whitespace-pre-wrap ${
              isError && !isSetupIssue
                ? "text-[var(--color-danger)]"
                : "text-[var(--color-text-muted)]"
            }`}
          >
            {prettyJson(resultText)}
          </pre>
        )}
      </div>
    </div>
  );
}

function Tab({
  id,
  active,
  onPick,
  label,
}: {
  id: "visual" | "input" | "output";
  active: string;
  onPick: (t: "visual" | "input" | "output") => void;
  label: string;
}) {
  const on = active === id;
  return (
    <button
      onClick={() => onPick(id)}
      className={`rounded px-2 py-1 text-[11px] transition-colors ${
        on
          ? "bg-[var(--color-panel-hover)] text-[var(--color-text)]"
          : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {label}
    </button>
  );
}

function SetupIssueBanner({
  kind,
  message,
  hint,
  language,
}: {
  kind: string;
  message: string;
  hint?: string;
  language?: string;
}) {
  const title =
    kind === "environment"
      ? language
        ? `${capitalize(language)} isn't installed on this machine`
        : "Runtime not installed"
      : kind === "configuration"
        ? "Tool isn't configured for this zone"
        : kind === "timeout"
          ? "Execution timed out"
          : "Setup issue";

  return (
    <div className="flex items-start gap-2 border-t border-[var(--color-border)] bg-amber-500/5 p-3 text-xs">
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-400" />
      <div className="flex-1">
        <div className="font-medium text-[var(--color-text)]">{title}</div>
        <div className="mt-0.5 text-[var(--color-text-muted)]">
          This isn't the model's fault — it's a host setup issue.{" "}
          {hint || message}
        </div>
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function renderToolOutput(
  name: string,
  args: any,
  resultText: string | null,
  _chatId: string,
  onMermaidError?: () => void,
  mermaidAutoFix?: MermaidAutoFix,
): React.ReactNode {
  if (!resultText) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || "error" in parsed) return null;

  if (name === "plot_function") {
    const data = toMathPlotData(args ?? parsed);
    if (!data) return null;
    return (
      <>
        <MathPlotBlock data={data} />
        {parsed.caption && (
          <div className="mt-1 text-center text-xs text-[var(--color-text-muted)]">
            {parsed.caption}
          </div>
        )}
      </>
    );
  }
  if (name === "update_plan") {
    const data = toPlanData(parsed);
    return data ? <PlanBlock {...data} /> : null;
  }
  if (name === "exit_plan_mode") {
    const proposal = toPlanProposal(parsed);
    return proposal ? <PlanProposalBlock {...proposal} /> : null;
  }
  if (name === "present_file") {
    if (typeof parsed.path !== "string") return null;
    const output = {
      path: parsed.path as string,
      filename: typeof parsed.filename === "string" ? parsed.filename : undefined,
      format: typeof parsed.format === "string" ? parsed.format : undefined,
    };
    return output.format === "html" || output.format === "htm" ? (
      <HtmlReportBlock output={output} />
    ) : (
      <SavedFileChip output={output} />
    );
  }
  if (name === "draw_diagram") {
    const source =
      (args && typeof args.source === "string" && args.source) ||
      (typeof parsed.source === "string" && parsed.source) ||
      "";
    if (!source) return null;
    return (
      <>
        <MermaidBlock source={source} onRenderError={onMermaidError} autoFix={mermaidAutoFix} />
        {parsed.caption && (
          <div className="mt-1 text-center text-xs text-[var(--color-text-muted)]">
            {parsed.caption}
          </div>
        )}
      </>
    );
  }
  return null;
}

interface AskQuestion {
  question: string;
  options?: string[];
  allow_free_text?: boolean;
}

export function AskUserCard({
  chatId,
  questions,
}: {
  chatId: string;
  questions: AskQuestion[];
}) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [idx, setIdx] = useState(0);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const refreshChats = useApp((s) => s.refreshChats);
  const isStreaming = useApp((s) => Boolean(s.streamingByChat[chatId]));

  const total = questions.length;
  const isLast = idx === total - 1;
  const q = questions[idx];
  const allowFreeText = q.allow_free_text !== false;
  const opts = q.options ?? [];
  const currentAnswer = answers[idx] ?? "";

  // Shaped like a useState setter so `useDictation` can splice a transcript into
  // whatever is already typed. `idx` is the one from the render that stopped the
  // recording, so a transcript lands in the question that is on screen.
  const setAnswer: Dispatch<SetStateAction<string>> = (val) => {
    setAnswers((prev) =>
      prev.map((a, i) => (i === idx ? (typeof val === "function" ? val(a) : val) : a)),
    );
  };

  // Dictation (0.9.13): a question is asked mid-conversation, and the answer is
  // as speakable as anything typed in the composer — so the same mic lives here.
  const answerRef = useRef<HTMLInputElement>(null);
  const dictation = useDictation({ taRef: answerRef, setText: setAnswer, cancelKey: chatId });

  async function submit() {
    if (sent || submitting || isStreaming) return;
    setSubmitting(true);
    setSent(true);
    try {
      let text: string;
      if (total === 1) {
        text = answers[0].trim();
      } else {
        text = questions
          .map((q, i) => `Q: ${q.question}\nA: ${answers[i].trim()}`)
          .join("\n\n");
      }
      await api.sendMessage(chatId, [{ type: "text", text }]);
      refreshChats();
    } catch (e) {
      console.error(e);
      setSent(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function pickOption(opt: string) {
    if (sent || submitting || isStreaming) return;
    if (total === 1) {
      // Single question: selecting an option submits immediately.
      setAnswers([opt]);
      setSubmitting(true);
      setSent(true);
      try {
        await api.sendMessage(chatId, [{ type: "text", text: opt }]);
        refreshChats();
      } catch (e) {
        console.error(e);
        setSent(false);
      } finally {
        setSubmitting(false);
      }
    } else {
      // Multi-question: fill the slot and advance.
      setAnswers((prev) => prev.map((a, i) => (i === idx ? opt : a)));
      if (!isLast) setIdx((v) => v + 1);
    }
  }

  return (
    <div className="my-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-panel)] p-3">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
        <div className="flex items-center gap-2">
          <HelpCircle size={12} className="text-[var(--color-accent)]" />
          <span>
            {total > 1
              ? `The assistant has ${total} questions for you`
              : "The assistant is asking you a question"}
          </span>
        </div>
        {total > 1 && (
          <span className="tabular-nums">
            {idx + 1} / {total}
          </span>
        )}
      </div>

      {/* Question */}
      <div className="mb-3 text-sm font-medium">{q.question}</div>

      {/* Options */}
      {opts.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {opts.map((opt) => (
            <button
              key={opt}
              onClick={() => pickOption(opt)}
              disabled={sent || submitting || isStreaming}
              className={`rounded border px-2.5 py-1 text-xs transition
                ${currentAnswer === opt
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                  : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-hover)]"
                } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {/* Free text input — type it or say it */}
      {allowFreeText && (
        <>
          <DictationMeter dictation={dictation} />
          {dictation.voiceError && (
            <div className="mb-2 flex w-fit items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs text-red-600 dark:text-red-400">
              <span>{dictation.voiceError}</span>
              <button
                onClick={dictation.dismissVoiceError}
                className="hover:text-[var(--color-text)]"
                title="Dismiss"
              >
                <X size={11} />
              </button>
            </div>
          )}
          <div className="mb-3 flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] pr-1 focus-within:border-[var(--color-accent)]">
            <input
              ref={answerRef}
              value={currentAnswer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (total === 1) submit();
                  else if (isLast && currentAnswer.trim()) submit();
                  else if (currentAnswer.trim()) setIdx((v) => v + 1);
                }
              }}
              placeholder={sent ? "Answer sent…" : opts.length ? "Or type your own answer…" : "Type your answer…"}
              disabled={sent || submitting || isStreaming}
              className="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm outline-none disabled:opacity-50"
              autoFocus
            />
            <MicButton
              dictation={dictation}
              disabled={sent || submitting || isStreaming}
              size={14}
            />
          </div>
        </>
      )}

      {/* Navigation row */}
      {!sent && (
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setIdx((v) => v - 1)}
            disabled={idx === 0 || submitting || isStreaming}
            className={`rounded px-3 py-1.5 text-xs ${CHROME_OUTLINED} disabled:cursor-not-allowed disabled:opacity-30`}
          >
            ← Back
          </button>

          {isLast ? (
            <button
              onClick={submit}
              disabled={!currentAnswer.trim() || submitting || isStreaming}
              className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
            >
              {submitting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
              {total > 1 ? "Submit all" : "Submit"}
            </button>
          ) : (
            <button
              onClick={() => setIdx((v) => v + 1)}
              disabled={!currentAnswer.trim() || submitting || isStreaming}
              className={`rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
            >
              Next →
            </button>
          )}
        </div>
      )}

      {sent && (
        <div className="text-xs text-[var(--color-text-muted)]">Answers sent to the model.</div>
      )}
    </div>
  );
}

