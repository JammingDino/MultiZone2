import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Ban,
  BookOpen,
  CheckCircle2,
  FileText,
  Flag,
  MessageSquare,
  Pause,
  Play,
  User,
  Wrench,
  Users,
} from "lucide-react";
import { Modal, ModalTitle } from "@/components/common/Modal";
import * as api from "@/lib/tauri";
import { buildTrace } from "@/lib/exportTrace";
import { CHROME_ACTIVE, CHROME_OUTLINED } from "@/lib/chrome";
import type { Message, SessionEvent } from "@/lib/types";
import { ToolVisual, hasToolVisual } from "@/components/Message/visuals/ToolVisual";

/**
 * Replay (0.12.2) — stepping through a past session at your own pace.
 *
 * Distinct from re-reading the transcript, which is the answer's account of
 * itself: this is the record of what actually happened and in what order,
 * including the parts the transcript never had — an approval you declined, a
 * zone that switched mid-turn, a tool that failed, a plan you edited before
 * approving. The clock on the left is elapsed time from the first event, which
 * is the axis that makes a run legible ("it spent four minutes on that search").
 *
 * It is *also* the transcript, from 0.12.3. The event log alone said a tool ran
 * and not what it came back with, which made the one question a replay is opened
 * to answer — "where did that number come from?" — the one it could not answer.
 * The conversation is already stored, so weaving it into the same timeline costs
 * nothing on disk: what the user asked, what each zone answered, and every tool
 * call with its arguments and its output now sit in order alongside the log's own
 * approvals and failures.
 *
 * Play is deliberately a fixed cadence rather than the original timings: a
 * faithful replay of a nine-minute turn takes nine minutes. Stepping is what
 * this is for; play is for skimming.
 */
export function ReplayView({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void api
      .listSessionEvents(chatId)
      .then((e) => alive && setEvents(e))
      .catch(() => alive && setEvents([]));
    // The transcript is fetched rather than read from the store so a replay opened
    // on a chat whose messages were never loaded (a subchat, say) is complete.
    void api
      .getMessages(chatId)
      .then((m) => alive && setMessages(m))
      .catch(() => alive && setMessages([]));
    return () => {
      alive = false;
    };
  }, [chatId]);

  const entries = useMemo(
    () => mergeTimeline(events ?? [], messages),
    [events, messages],
  );

  const shown = useMemo(
    () => entries.filter((e) => kinds.size === 0 || kinds.has(e.kind)),
    [entries, kinds],
  );

  // Auto-advance, stopping of its own accord at the end rather than looping —
  // a replay that starts again from the top is indistinguishable from one that
  // never finished.
  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => {
      setIndex((i) => {
        if (i >= shown.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 700);
    return () => window.clearInterval(t);
  }, [playing, shown.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const start = entries[0]?.at ?? 0;
  const current = shown[Math.min(index, Math.max(0, shown.length - 1))];
  const allKinds = useMemo(() => [...new Set(entries.map((e) => e.kind))], [entries]);

  return (
    <Modal
      onClose={onClose}
      header={<ModalTitle>Replay this session</ModalTitle>}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, shown.length - 1));
          if (e.key === "ArrowUp" || e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
        }}
        tabIndex={0}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 text-xs">
          <button
            onClick={() => setPlaying((p) => !p)}
            disabled={shown.length === 0}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            {playing ? <Pause size={11} /> : <Play size={11} />}
            {playing ? "Pause" : "Play"}
          </button>
          <button
            onClick={() => { setPlaying(false); setIndex((i) => Math.max(0, i - 1)); }}
            className={`rounded p-1 ${CHROME_OUTLINED}`}
            aria-label="Previous event"
          >
            <ChevronLeft size={12} />
          </button>
          <button
            onClick={() => { setPlaying(false); setIndex((i) => Math.min(shown.length - 1, i + 1)); }}
            className={`rounded p-1 ${CHROME_OUTLINED}`}
            aria-label="Next event"
          >
            <ChevronRight size={12} />
          </button>
          <span className="text-[var(--color-text-muted)]">
            {shown.length === 0 ? "no events" : `${Math.min(index + 1, shown.length)} of ${shown.length}`}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {allKinds.map((k) => (
              <button
                key={k}
                onClick={() =>
                  setKinds((s) => {
                    const next = new Set(s);
                    next.has(k) ? next.delete(k) : next.add(k);
                    return next;
                  })
                }
                className={`rounded-full px-2 py-0.5 text-[10px] ${kinds.has(k) ? CHROME_ACTIVE : CHROME_OUTLINED}`}
              >
                {kindLabel(k)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div ref={listRef} className="w-[46%] overflow-y-auto border-r border-[var(--color-border)] p-2">
            {events === null ? (
              <div className="p-4 text-xs text-[var(--color-text-muted)]">Loading…</div>
            ) : shown.length === 0 ? (
              <div className="p-4 text-xs text-[var(--color-text-muted)]">
                Nothing recorded for this chat yet. The log starts with the next turn — it
                records what happens as it happens rather than reconstructing it afterwards.
              </div>
            ) : (
              shown.map((e, i) => (
                <button
                  key={e.id}
                  data-idx={i}
                  onClick={() => { setPlaying(false); setIndex(i); }}
                  className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs ${
                    i === index ? "bg-[var(--color-panel-hover)]" : "hover:bg-[var(--color-panel-hover)]"
                  } ${i > index ? "opacity-45" : ""}`}
                >
                  <span
                    className="w-9 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-[var(--color-text-muted)]"
                    /* Elapsed is the axis you read a run by; the wall clock is what
                       you cross-reference against anything outside the app, so both
                       are here rather than one behind a click. */
                    title={new Date(e.at).toLocaleString()}
                  >
                    {elapsed(e.at - start)}
                  </span>
                  <KindIcon kind={e.kind} />
                  <span className="min-w-0 flex-1 text-[var(--color-text)]">{e.label}</span>
                  <span className="shrink-0 pt-0.5 text-[10px] tabular-nums text-[var(--color-text-muted)]/70">
                    {clock(e.at)}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {current ? (
              <>
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <KindIcon kind={current.kind} />
                  <span className="font-medium">{current.label}</span>
                </div>
                <div className="mb-3 text-[11px] text-[var(--color-text-muted)]">
                  {new Date(current.at).toLocaleString()} · {kindLabel(current.kind)}
                  {current.meta ? ` · ${current.meta}` : ""}
                  {current.turnId ? ` · turn ${current.turnId.slice(0, 8)}` : ""}
                </div>
                {current.tool &&
                  hasToolVisual(current.tool.name, current.tool.parsed, current.tool.isError) && (
                    <div className="mb-3">
                      <ToolVisual
                        name={current.tool.name}
                        args={current.tool.args}
                        parsed={current.tool.parsed}
                        isError={current.tool.isError}
                      />
                    </div>
                  )}
                {current.body && (
                  <>
                    {current.tool && (
                      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                        Output
                      </div>
                    )}
                    <div className="mb-3 whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-2 text-[12px] leading-relaxed text-[var(--color-text)]">
                      {clamp(current.body)}
                    </div>
                  </>
                )}
                {current.detail && (
                  <>
                    {current.body && (
                      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                        {current.detailLabel ?? "Detail"}
                      </div>
                    )}
                    <pre className="whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-2 text-[11px] text-[var(--color-text-muted)]">
                      {clamp(pretty(current.detail))}
                    </pre>
                  </>
                )}
                {!current.body && !current.detail && (
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    Nothing further recorded for this event.
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-[var(--color-text-muted)]">
                Select an event to see what it carried.
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * One line of the replay. The event log and the transcript describe the same run
 * from two sides, so both are reduced to this before being interleaved.
 */
interface ReplayEntry {
  id: string;
  /** Epoch ms this happened at. */
  at: number;
  kind: string;
  /** The one-line summary shown in the list. */
  label: string;
  /** Prose — a question, an answer, a tool's output. Shown as written. */
  body?: string | null;
  /** A structured blob (tool arguments, an event's payload), pretty-printed. */
  detail?: string | null;
  /** Names what `detail` is, when it sits under a body. */
  detailLabel?: string;
  /** Extra facts for the header line, e.g. "1.4s · error". */
  meta?: string | null;
  turnId?: string | null;
  /**
   * A tool call, so the replay can draw the same visual the transcript does
   * (0.13.1). Replay is read precisely when something went wrong, so showing a
   * worse view of the call here than in the chat would be the wrong way round.
   */
  tool?: { name: string; args: unknown; parsed: unknown; isError: boolean };
}

/** How much of a long body/detail is rendered. Past this, a replay pane becomes a
 *  document viewer, and the whole thing is in the transcript and the export. */
const CLAMP_CHARS = 20_000;

function clamp(text: string): string {
  if (text.length <= CLAMP_CHARS) return text;
  return `${text.slice(0, CLAMP_CHARS)}\n\n… ${text.length - CLAMP_CHARS} more characters (see the chat itself, or export it)`;
}

/**
 * The log and the transcript, in one ordered list.
 *
 * Ties go to the log: a `tool_call` row is written when the call is issued and the
 * assistant message carrying it is saved in the same instant, and reading "ran
 * read_file" before "read_file → ok" is the order it happened in.
 */
function mergeTimeline(events: SessionEvent[], messages: Message[]): ReplayEntry[] {
  const fromLog: ReplayEntry[] = events.map((e) => ({
    id: e.id,
    at: e.createdAt,
    kind: e.kind,
    label: e.label,
    detail: e.detail,
    turnId: e.turnId,
  }));
  const fromChat = transcriptEntries(messages);
  return [...fromLog.map((e, i) => ({ e, rank: [e.at, 0, i] as const })),
          ...fromChat.map((e, i) => ({ e, rank: [e.at, 1, i] as const }))]
    .sort((a, b) =>
      a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
    .map(({ e }) => e);
}

/**
 * The conversation as replay entries.
 *
 * Built on `buildTrace`, the same reduction the PDF export uses — so a tool's
 * arguments, its output and how long it took are already matched up, and this
 * only has to decide how each piece reads as a single line.
 */
function transcriptEntries(messages: Message[]): ReplayEntry[] {
  const out: ReplayEntry[] = [];
  let n = 0;
  const id = () => `msg-${n++}`;

  for (const unit of buildTrace(messages)) {
    for (const item of unit.items) {
      if (item.kind === "text") {
        const you = unit.role === "user";
        out.push({
          id: id(),
          at: item.timestamp,
          kind: you ? "user_message" : "assistant_text",
          label: `${you ? "You: " : ""}${oneLine(item.text)}`,
          body: item.text,
        });
      } else if (item.kind === "thinking") {
        out.push({
          id: id(),
          at: item.timestamp,
          kind: "thinking",
          // The reasoning text itself is deliberately not carried through the
          // trace model, so this is a marker with a size, not a transcript of it.
          label: `Thought for ${item.durationMs != null ? secs(item.durationMs) : "a while"}`,
          meta: `${item.characters.toLocaleString()} characters of reasoning`,
        });
      } else if (item.kind === "images") {
        out.push({
          id: id(),
          at: item.timestamp,
          kind: "user_message",
          label: `You attached ${item.count} image${item.count === 1 ? "" : "s"}`,
        });
      } else if (item.kind === "attachments") {
        out.push({
          id: id(),
          at: item.timestamp,
          kind: "user_message",
          label: `You attached ${item.files.map((f) => f.fileName).join(", ")}`,
          detail: JSON.stringify(item.files, null, 2),
        });
      } else {
        // A tool. The call is already in the log; what was missing is what came
        // back, so the entry is placed at the moment the result landed.
        const name = item.call.function.name;
        const at = item.timestamp + (item.durationMs ?? 0);
        const outcome =
          item.status === "error" ? "failed" : item.status === "no-result" ? "no result" : "ok";
        out.push({
          id: id(),
          at,
          kind: item.status === "error" ? "tool_failed" : "tool_result",
          label: `${name} → ${outcome}${item.resultText ? `: ${oneLine(item.resultText, 60)}` : ""}`,
          body: item.resultText,
          detail: item.args ? JSON.stringify(item.args, null, 2) : null,
          detailLabel: "Arguments",
          tool: {
            name,
            args: item.args,
            parsed: parseResult(item.resultText),
            isError: item.status === "error",
          },
          meta: [outcome, item.durationMs != null ? secs(item.durationMs) : null]
            .filter(Boolean)
            .join(" · "),
        });
      }
    }
  }
  return out;
}

/** A single line for the list: no newlines, and short enough not to wrap twice. */
function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function secs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function pretty(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

/**
 * A tool result as a value, for the visual. Tools return JSON as a string; one
 * that returns prose (or nothing) has no visual and falls back to the body,
 * which is what was shown before this existed.
 */
function parseResult(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** mm:ss from the first event — the axis that makes a run legible. */
function elapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Wall clock, for cross-referencing anything outside the app. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    turn_start: "turn start",
    turn_end: "turn end",
    tool_call: "tool",
    tool_error: "failure",
    denial: "declined",
    approval: "approved",
    zone_switch: "zone",
    file_change: "file",
    plan_mode: "plan mode",
    plan_filed: "plan",
    plan_approved: "approved plan",
    plan_rejected: "rejected plan",
    plan_edit: "plan edit",
    plan_stop: "stop",
    error: "error",
    cancelled: "cancelled",
    user_message: "you",
    assistant_text: "answer",
    thinking: "thinking",
    tool_result: "tool output",
    tool_failed: "tool failed",
    runaway: "loop stopped",
    instructions: "directory rules",
    checks_passed: "checks passed",
    checks_failed: "checks failed",
  };
  return map[kind] ?? kind;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "mt-0.5 h-3 w-3 shrink-0";
  if (kind === "tool_error" || kind === "error" || kind === "tool_failed")
    return <AlertTriangle className={`${cls} text-[var(--color-danger)]`} />;
  if (kind === "denial" || kind === "cancelled" || kind === "runaway")
    return <Ban className={`${cls} text-amber-400`} />;
  if (kind === "file_change") return <FileText className={`${cls} text-[var(--color-accent)]`} />;
  if (kind === "instructions")
    return <BookOpen className={`${cls} text-[var(--color-text-muted)]`} />;
  if (kind === "checks_passed") return <CheckCircle2 className={`${cls} text-green-500`} />;
  if (kind === "checks_failed")
    return <AlertTriangle className={`${cls} text-[var(--color-danger)]`} />;
  if (kind.startsWith("plan")) return <ClipboardList className={`${cls} text-[var(--color-accent)]`} />;
  if (kind === "zone_switch") return <Users className={`${cls} text-[var(--color-text-muted)]`} />;
  if (kind === "turn_start" || kind === "turn_end")
    return <Flag className={`${cls} text-[var(--color-text-muted)]`} />;
  if (kind === "user_message") return <User className={`${cls} text-[var(--color-accent)]`} />;
  if (kind === "assistant_text") return <MessageSquare className={`${cls} text-[var(--color-text)]`} />;
  if (kind === "thinking") return <Brain className={`${cls} text-[var(--color-text-muted)]`} />;
  return <Wrench className={`${cls} text-[var(--color-text-muted)]`} />;
}
