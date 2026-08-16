import { useState } from "react";
import { Bot, ChevronRight, ChevronDown, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { SubchatTranscript } from "../StackTrace";
import { Shaped } from "./Shaped";

/**
 * Family 9 — a sub-agent as a card (0.13.2).
 *
 * The leader's step list is the least legible part of Multizone mode: a spawn
 * showed as a JSON object whose most useful field, the sub-agent's whole
 * answer, was a single escaped string. Here the zone is named, the task is
 * readable, the status says whether it is still working, and the transcript
 * opens from the step that caused it rather than only from the stack tracer.
 */

export function AgentVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  if (name === "list_subchats") {
    const subchats = Array.isArray(result.subchats) ? (result.subchats as any[]) : [];
    if (subchats.length === 0) {
      return <Empty>No sub-agents in this conversation yet.</Empty>;
    }
    return (
      <div className="space-y-1">
        {subchats.map((s, i) => (
          <AgentCard
            key={i}
            zone={str(s.zone)}
            subchatId={str(s.subchat_id)}
            task={str(s.task)}
            status={s.busy === true ? "still_running" : "ok"}
            facts={[
              typeof s.turns === "number" ? `${s.turns} turn${s.turns === 1 ? "" : "s"}` : null,
            ]}
          />
        ))}
      </div>
    );
  }

  if (name === "collect_subagents") {
    const collected = Array.isArray(result.collected) ? (result.collected as any[]) : [];
    if (collected.length === 0) {
      return <Empty>{str(result.note) || "Nothing collected."}</Empty>;
    }
    return (
      <div className="space-y-1">
        {collected.map((c, i) => (
          <AgentCard
            key={i}
            zone={str(c.zone)}
            subchatId={str(c.subchat_id)}
            body={str(c.response) || str(c.error)}
            status={str(c.status)}
            facts={[
              typeof c.running_for_seconds === "number"
                ? `${c.running_for_seconds}s so far`
                : null,
              str(c.note) || null,
            ]}
          />
        ))}
      </div>
    );
  }

  // spawn_subagent · send_subchat_message · read_subchat
  const subchatId = str(result.subchat_id) || str(args?.subchat_id);
  if (!subchatId) return <Shaped value={result} />;

  const zone =
    (result.zone && typeof result.zone === "object"
      ? str((result.zone as any).name)
      : str(result.zone)) || str(args?.zone_id);

  return (
    <AgentCard
      zone={zone}
      subchatId={subchatId}
      task={str(args?.initial_message) || str(args?.message)}
      body={str(result.response) || str(result.transcript)}
      status={str(result.status)}
      facts={[str(result.note) || null]}
    />
  );
}

function AgentCard({
  zone,
  subchatId,
  task,
  body,
  status,
  facts,
}: {
  zone: string;
  subchatId: string;
  task?: string;
  body?: string;
  status: string;
  facts: (string | null)[];
}) {
  const [openTranscript, setOpenTranscript] = useState(false);
  const shown = facts.filter(Boolean) as string[];
  const running = status === "running" || status === "still_running";
  const failed = status === "failed";

  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-[11px]">
        <Bot size={12} className="shrink-0 text-[var(--color-accent)]" />
        <span className="min-w-0 truncate font-medium text-[var(--color-text)]">
          {zone || "sub-agent"}
        </span>
        <StatusPill status={status} />
      </div>

      {task && (
        <div className="border-b border-[var(--color-border)] px-2 py-1.5">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            Task
          </div>
          <div className="line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {task}
          </div>
        </div>
      )}

      {body && (
        <div className="max-h-[220px] overflow-auto px-2 py-1.5">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            {failed ? "Error" : "Reply"}
          </div>
          <div
            className={`whitespace-pre-wrap break-words text-[11px] leading-relaxed ${
              failed ? "text-[var(--color-danger)]" : "text-[var(--color-text)]"
            }`}
          >
            {body}
          </div>
        </div>
      )}

      {running && !body && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">
          <Loader2 size={11} className="animate-spin" /> Working — collect_subagents picks the
          reply up.
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-2 py-1">
        <button
          onClick={() => setOpenTranscript((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {openTranscript ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          Transcript
        </button>
        {shown.length > 0 && (
          <span className="ml-auto min-w-0 truncate text-[10px] text-[var(--color-text-muted)]">
            {shown.join(" · ")}
          </span>
        )}
      </div>
      {openTranscript && (
        <div className="border-t border-[var(--color-border)] py-1">
          <SubchatTranscript subchatId={subchatId} />
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const [label, tone, Icon] =
    status === "running" || status === "still_running"
      ? (["running", "text-[var(--color-accent)]", Loader2] as const)
      : status === "failed"
        ? (["failed", "text-[var(--color-danger)]", AlertCircle] as const)
        : status === "unknown"
          ? (["no reply", "text-[var(--color-text-muted)]", AlertCircle] as const)
          : (["done", "text-emerald-400", CheckCircle2] as const);
  return (
    <span className={`ml-auto flex shrink-0 items-center gap-1 text-[10px] ${tone}`}>
      <Icon size={10} className={Icon === Loader2 ? "animate-spin" : undefined} />
      {label}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
