import { useEffect, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Wrench,
  Brain,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  HelpCircle,
  Send,
} from "lucide-react";
import type { Step, ToolStep, ThinkingStep } from "@/lib/grouping";
import type { ContentPart, InputPart } from "@/lib/types";
import { MathPlotBlock, type MathPlotData } from "@/components/Renderers/MathPlotBlock";
import { MermaidBlock } from "@/components/Renderers/MermaidBlock";
import { HtmlReportBlock } from "@/components/Renderers/HtmlReportBlock";
import { SavedFileChip } from "@/components/Renderers/SavedFileChip";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function extractToolResultText(json: string): string {
  try {
    const parts = JSON.parse(json) as ContentPart[];
    if (Array.isArray(parts)) {
      return parts
        .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  } catch {}
  return json;
}

function parseArgs(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function StepBlock({
  step,
  index,
  chatId,
}: {
  step: Step;
  index: number;
  chatId: string;
}) {
  if (step.kind === "thinking") {
    return <ThinkingStepView step={step} index={index} />;
  }
  return <ToolStepView step={step} index={index} chatId={chatId} />;
}

function ThinkingStepView({ step, index }: { step: ThinkingStep; index: number }) {
  const expandByDefault = useApp((s) => s.appSettings.expandThinkingByDefault);
  // Open while streaming, or if the user has opted into default-expanded.
  const [open, setOpen] = useState(step.streaming || expandByDefault);

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
              {step.text}
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
}: {
  step: ToolStep;
  index: number;
  chatId: string;
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
  const name = toolCall.function.name;

  const resultText = toolResult ? extractToolResultText(toolResult.content) : null;
  const parsedResult: any = (() => {
    if (!resultText) return null;
    try {
      return JSON.parse(resultText);
    } catch {
      return null;
    }
  })();
  const isError =
    parsedResult && typeof parsedResult === "object" && "error" in parsedResult;
  const errorKind: string | null = isError
    ? (parsedResult.error_kind as string | undefined) ?? null
    : null;
  // Environment / configuration / timeout errors aren't the model's fault.
  // Treat them as warnings so the user reads them as "something on your machine,
  // not the AI screwed up."
  const isSetupIssue =
    errorKind === "environment" ||
    errorKind === "configuration" ||
    errorKind === "timeout";

  const args = parseArgs(toolCall.function.arguments);
  const renderedView = toolResult
    ? renderToolOutput(name, args, resultText, chatId, () => setMermaidFailed(true))
    : null;

  let status: "running" | "done" | "error" | "warning" | "pending";
  if (pending) status = "pending";
  else if (!toolResult) status = "running";
  else if (isError) status = isSetupIssue ? "warning" : "error";
  else if (mermaidFailed) status = "error";
  else status = "done";

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
        <Wrench
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
        <div className="space-y-2 border-t border-[var(--color-border)] p-2 text-xs">
          <Section label="Arguments">
            <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap text-[var(--color-text-muted)]">
              {toolCall.function.arguments
                ? prettyJson(toolCall.function.arguments)
                : "(none)"}
            </pre>
          </Section>
          {resultText !== null && (
            <Section
              label={isError ? (isSetupIssue ? "Details" : "Error") : "Output"}
            >
              <pre
                className={`max-h-[280px] overflow-auto whitespace-pre-wrap ${
                  isError && !isSetupIssue
                    ? "text-[var(--color-danger)]"
                    : "text-[var(--color-text-muted)]"
                }`}
              >
                {prettyJson(resultText)}
              </pre>
            </Section>
          )}
        </div>
      )}
    </div>
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
        <MermaidBlock source={source} onRenderError={onMermaidError} />
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

  function setAnswer(val: string) {
    setAnswers((prev) => prev.map((a, i) => (i === idx ? val : a)));
  }

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

      {/* Free text input */}
      {allowFreeText && (
        <input
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
          className="mb-3 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
          autoFocus
        />
      )}

      {/* Navigation row */}
      {!sent && (
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setIdx((v) => v - 1)}
            disabled={idx === 0 || submitting || isStreaming}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-panel-hover)] disabled:cursor-not-allowed disabled:opacity-30"
          >
            ← Back
          </button>

          {isLast ? (
            <button
              onClick={submit}
              disabled={!currentAnswer.trim() || submitting || isStreaming}
              className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
              {total > 1 ? "Submit all" : "Submit"}
            </button>
          ) : (
            <button
              onClick={() => setIdx((v) => v + 1)}
              disabled={!currentAnswer.trim() || submitting || isStreaming}
              className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
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

function toMathPlotData(raw: any): MathPlotData | null {
  if (!raw || typeof raw !== "object") return null;
  const xRange = raw.x_range ?? raw.xRange;
  const yRange = raw.y_range ?? raw.yRange;
  const fns = raw.functions;
  if (!Array.isArray(xRange) || xRange.length !== 2) return null;
  if (!Array.isArray(yRange) || yRange.length !== 2) return null;
  if (!Array.isArray(fns) || fns.length === 0) return null;
  return {
    title: raw.title,
    xRange: [Number(xRange[0]), Number(xRange[1])],
    yRange: [Number(yRange[0]), Number(yRange[1])],
    xLabel: raw.x_label ?? raw.xLabel,
    yLabel: raw.y_label ?? raw.yLabel,
    functions: fns
      .map((f: any) =>
        typeof f === "string"
          ? { fn: f }
          : f && typeof f === "object" && typeof f.fn === "string"
            ? { fn: f.fn, color: f.color }
            : null,
      )
      .filter((f: any) => f !== null) as { fn: string; color?: string }[],
  };
}
