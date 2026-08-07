import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, Check, X, Loader2, TriangleAlert } from "lucide-react";
import * as api from "@/lib/tauri";
import type { ApplyOutcome, StagedEdit } from "@/lib/types";
import { DiffView } from "@/components/common/DiffView";

/**
 * The review queue (0.10.2).
 *
 * With review mode on, a zone's file writes stage instead of landing, and this
 * is where the user reads the batch and decides. Nothing here is a preference
 * the app records and ignores: applying writes the file (checkpointed, so it is
 * still revertible), discarding throws the proposal away, and unticking hunks
 * applies only what was ticked.
 *
 * Renders nothing when the queue is empty, which is every chat in the default
 * configuration — the panel exists only when there is something to review.
 */
export function ReviewQueue({ chatId }: { chatId: string }) {
  const [edits, setEdits] = useState<StagedEdit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Per-edit hunk selection; absent means "all of it". */
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});

  const refresh = useCallback(async () => {
    try {
      setEdits(await api.listStagedEdits(chatId));
    } catch (e) {
      console.error(e);
    }
  }, [chatId]);

  useEffect(() => {
    setNote(null);
    setSelection({});
    void refresh();
  }, [chatId, refresh]);

  // A staged edit arrives mid-turn, so the queue has to notice without the user
  // navigating away and back. Polling rather than a new event: the queue is off
  // for most people, the cost is one indexed query, and it also catches an edit
  // staged by a background sub-agent in another chat of the same session.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  if (edits.length === 0) return null;

  function summarise(outcomes: ApplyOutcome[]): string {
    const counts = new Map<string, number>();
    for (const o of outcomes) counts.set(o.outcome, (counts.get(o.outcome) ?? 0) + 1);
    return [...counts].map(([outcome, n]) => `${n} ${outcome}`).join(", ");
  }

  async function applyOne(edit: StagedEdit, force: boolean) {
    setBusy(edit.id);
    setNote(null);
    try {
      const chosen = selection[edit.id];
      const hunks =
        chosen && chosen.size < edit.diff.hunks.length
          ? [...chosen].sort((a, b) => a - b)
          : undefined;
      const outcome = await api.applyStagedEdit(edit.id, hunks, force);
      setNote(
        outcome.outcome === "applied"
          ? `Applied ${outcome.displayPath}.`
          : `${outcome.displayPath}: ${outcome.detail ?? outcome.outcome}`,
      );
      await refresh();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function discardOne(edit: StagedEdit) {
    setBusy(edit.id);
    try {
      await api.discardStagedEdit(edit.id);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function applyAll() {
    setBusy("__all__");
    setNote(null);
    try {
      setNote(summarise(await api.applyAllStagedEdits(chatId)));
      await refresh();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function discardAll() {
    setBusy("__all__");
    try {
      await api.discardAllStagedEdits(chatId);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  function toggleHunk(editId: string, hunkCount: number, index: number) {
    setSelection((s) => {
      const current = s[editId] ?? new Set(Array.from({ length: hunkCount }, (_, i) => i));
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { ...s, [editId]: next };
    });
  }

  const diverged = edits.filter((e) => e.diverged).length;

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex items-center gap-2">
          <ClipboardCheck size={14} className="shrink-0 text-[var(--color-accent)]" />
          <span className="text-sm font-medium">
            {edits.length} change{edits.length === 1 ? "" : "s"} waiting for review
          </span>
          {diverged > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-amber-500">
              <TriangleAlert size={12} />
              {diverged} edited on disk since
            </span>
          )}
          <div className="ml-auto flex gap-1.5">
            <button
              onClick={applyAll}
              disabled={busy !== null}
              className="flex items-center gap-1 rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy === "__all__" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Apply all
            </button>
            <button
              onClick={discardAll}
              disabled={busy !== null}
              className="rounded border border-[var(--color-border)] px-2.5 py-1 text-xs hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50"
            >
              Discard all
            </button>
          </div>
        </div>

        <div className="flex max-h-[46vh] flex-col gap-2 overflow-y-auto">
          {edits.map((edit) => {
            const chosen = selection[edit.id];
            const many = edit.diff.hunks.length > 1;
            return (
              <div key={edit.id}>
                <DiffView
                  diff={edit.diff}
                  selected={
                    many
                      ? chosen ?? new Set(edit.diff.hunks.map((h) => h.index))
                      : undefined
                  }
                  onToggleHunk={
                    many ? (i) => toggleHunk(edit.id, edit.diff.hunks.length, i) : undefined
                  }
                  maxHeight="max-h-[240px]"
                />
                <div className="mt-1 flex items-center gap-2 text-[11px]">
                  {edit.diverged && (
                    <span className="flex items-center gap-1 text-amber-500">
                      <TriangleAlert size={12} />
                      changed on disk since this was queued
                    </span>
                  )}
                  <div className="ml-auto flex gap-1.5">
                    <button
                      onClick={() => applyOne(edit, edit.diverged)}
                      disabled={busy !== null}
                      className={`flex items-center gap-1 rounded border px-2 py-0.5 disabled:opacity-50 ${
                        edit.diverged
                          ? "border-amber-500/50 text-amber-500"
                          : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                      }`}
                    >
                      {busy === edit.id ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Check size={11} />
                      )}
                      {edit.diverged ? "Apply anyway" : "Apply"}
                    </button>
                    <button
                      onClick={() => discardOne(edit)}
                      disabled={busy !== null}
                      className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50"
                    >
                      <X size={11} />
                      Discard
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {note && <p className="text-[11px] text-[var(--color-text-muted)]">{note}</p>}
      </div>
    </div>
  );
}
