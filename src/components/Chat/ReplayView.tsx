import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Ban,
  FileText,
  Flag,
  Pause,
  Play,
  Wrench,
  Users,
} from "lucide-react";
import { Modal, ModalTitle } from "@/components/common/Modal";
import * as api from "@/lib/tauri";
import type { SessionEvent } from "@/lib/types";

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
 * Play is deliberately a fixed cadence rather than the original timings: a
 * faithful replay of a nine-minute turn takes nine minutes. Stepping is what
 * this is for; play is for skimming.
 */
export function ReplayView({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
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
    return () => {
      alive = false;
    };
  }, [chatId]);

  const shown = useMemo(
    () => (events ?? []).filter((e) => kinds.size === 0 || kinds.has(e.kind)),
    [events, kinds],
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

  const start = events?.[0]?.createdAt ?? 0;
  const current = shown[Math.min(index, Math.max(0, shown.length - 1))];
  const allKinds = useMemo(
    () => [...new Set((events ?? []).map((e) => e.kind))],
    [events],
  );

  return (
    <Modal
      onClose={onClose}
      className="h-[640px] w-[880px]"
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
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 hover:border-[var(--color-accent)] disabled:opacity-40"
          >
            {playing ? <Pause size={11} /> : <Play size={11} />}
            {playing ? "Pause" : "Play"}
          </button>
          <button
            onClick={() => { setPlaying(false); setIndex((i) => Math.max(0, i - 1)); }}
            className="rounded border border-[var(--color-border)] p-1 hover:border-[var(--color-accent)]"
            aria-label="Previous event"
          >
            <ChevronLeft size={12} />
          </button>
          <button
            onClick={() => { setPlaying(false); setIndex((i) => Math.min(shown.length - 1, i + 1)); }}
            className="rounded border border-[var(--color-border)] p-1 hover:border-[var(--color-accent)]"
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
                className={`rounded-full border px-2 py-0.5 text-[10px] ${
                  kinds.has(k)
                    ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                    : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {kindLabel(k)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div ref={listRef} className="w-1/2 overflow-y-auto border-r border-[var(--color-border)] p-2">
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
                  <span className="w-12 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-[var(--color-text-muted)]">
                    {elapsed(e.createdAt - start)}
                  </span>
                  <KindIcon kind={e.kind} />
                  <span className="min-w-0 flex-1 text-[var(--color-text)]">{e.label}</span>
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
                  {new Date(current.createdAt).toLocaleString()} · {kindLabel(current.kind)}
                  {current.turnId ? ` · turn ${current.turnId.slice(0, 8)}` : ""}
                </div>
                {current.detail ? (
                  <pre className="whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-2 text-[11px] text-[var(--color-text-muted)]">
                    {pretty(current.detail)}
                  </pre>
                ) : (
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

function pretty(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
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
  };
  return map[kind] ?? kind;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "mt-0.5 h-3 w-3 shrink-0";
  if (kind === "tool_error" || kind === "error")
    return <AlertTriangle className={`${cls} text-[var(--color-danger)]`} />;
  if (kind === "denial" || kind === "cancelled")
    return <Ban className={`${cls} text-amber-400`} />;
  if (kind === "file_change") return <FileText className={`${cls} text-[var(--color-accent)]`} />;
  if (kind.startsWith("plan")) return <ClipboardList className={`${cls} text-[var(--color-accent)]`} />;
  if (kind === "zone_switch") return <Users className={`${cls} text-[var(--color-text-muted)]`} />;
  if (kind === "turn_start" || kind === "turn_end")
    return <Flag className={`${cls} text-[var(--color-text-muted)]`} />;
  return <Wrench className={`${cls} text-[var(--color-text-muted)]`} />;
}
