import { useState } from "react";
import { FilePlus2, FilePen, FileX2, Undo2, TriangleAlert, Loader2 } from "lucide-react";
import type { Checkpoint, CheckpointFile, RestoreReport } from "@/lib/types";
import { useApp } from "@/store/app";
import { revealPath } from "@/lib/tauri";
import { CHROME_QUIET } from "@/lib/chrome";

/**
 * What a turn did to the filesystem, and the way back (0.10.1).
 *
 * Rendered under any turn that changed files. The approval prompt asks before a
 * change and can only ever be answered on what the model said it would do; this
 * is the same decision offered after the fact, on what it actually did.
 *
 * A path the user has edited since the assistant wrote it is marked, and
 * reverting it is refused until they say so explicitly — an undo that silently
 * discards the user's own work would be worse than no undo at all.
 */

const CHANGE_ICON = {
  created: FilePlus2,
  changed: FilePen,
  deleted: FileX2,
} as const;

const CHANGE_LABEL = {
  created: "created",
  changed: "edited",
  deleted: "deleted",
} as const;

/** Everything after the last separator — the part the user recognises. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function outcomeSummary(report: RestoreReport): string {
  const counts = new Map<string, number>();
  for (const f of report.files) counts.set(f.outcome, (counts.get(f.outcome) ?? 0) + 1);
  return [...counts]
    .map(([outcome, n]) => `${n} ${outcome}`)
    .join(", ");
}

export function TurnChanges({ chatId, messageIds }: { chatId: string; messageIds: string[] }) {
  const checkpoint = useApp((s) =>
    (s.checkpointsByChat[chatId] ?? []).find(
      // A rewind mark is anchored to the message it was taken at so the way
      // forward can be offered there — it is not a turn, and must not read as
      // one turn's worth of file changes here.
      (c) => c.label !== "rewind" && c.messageId !== null && messageIds.includes(c.messageId),
    ),
  );
  const revert = useApp((s) => s.revertCheckpoint);

  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // Paths the user has been told diverged and has chosen to overwrite anyway.
  const [forced, setForced] = useState<Set<string>>(new Set());

  if (!checkpoint || checkpoint.files.length === 0) return null;

  async function run(label: string, paths?: string[], force?: boolean) {
    if (!checkpoint) return;
    setBusy(label);
    setResult(null);
    try {
      const report = await revert(chatId, checkpoint.id, paths, force);
      setResult(outcomeSummary(report));
      // A path that came back as a conflict is re-offered with the warning; one
      // that succeeded should not stay armed for a forced retry.
      setForced(new Set());
    } catch (e) {
      setResult(String(e));
    } finally {
      setBusy(null);
    }
  }

  const diverged = checkpoint.files.filter((f) => f.diverged);
  const restorable = checkpoint.files.filter((f) => !f.unstorable);

  return (
    <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] text-xs">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5">
        <span className="text-[var(--color-text-muted)]">
          Changed {checkpoint.files.length} file{checkpoint.files.length === 1 ? "" : "s"}
        </span>
        {checkpoint.restoredAt !== null && (
          <span className="text-[var(--color-text-muted)]">· reverted</span>
        )}
        <button
          onClick={() => run("all", undefined, diverged.length === 0 ? undefined : false)}
          disabled={busy !== null || restorable.length === 0}
          className={`ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 ${CHROME_QUIET} disabled:opacity-50`}
          title="Put every file this turn changed back the way it was"
        >
          {busy === "all" ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
          Revert turn
        </button>
      </div>

      <ul className="divide-y divide-[var(--color-border)]">
        {checkpoint.files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            busy={busy}
            forced={forced.has(file.path)}
            onArm={() => setForced((s) => new Set(s).add(file.path))}
            onRevert={(force) => run(file.path, [file.path], force)}
          />
        ))}
      </ul>

      {result && (
        <div className="border-t border-[var(--color-border)] px-3 py-1.5 text-[var(--color-text-muted)]">
          {result}
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  busy,
  forced,
  onArm,
  onRevert,
}: {
  file: CheckpointFile;
  busy: string | null;
  forced: boolean;
  onArm: () => void;
  onRevert: (force: boolean) => void;
}) {
  const Icon = CHANGE_ICON[file.change];
  return (
    <li className="flex items-center gap-2 px-3 py-1.5">
      <Icon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
      <button
        onClick={() => revealPath(file.path).catch((e) => console.error("revealPath failed", e))}
        className="truncate text-left hover:underline"
        title={file.displayPath}
      >
        {basename(file.displayPath)}
      </button>
      <span className="shrink-0 text-[var(--color-text-muted)]">{CHANGE_LABEL[file.change]}</span>

      {file.diverged && (
        <span
          className="flex shrink-0 items-center gap-1 text-amber-500"
          title="This file has been edited since the assistant wrote it — reverting would discard that edit"
        >
          <TriangleAlert size={12} />
          edited since
        </span>
      )}

      <div className="ml-auto shrink-0">
        {file.unstorable ? (
          <span className="text-[var(--color-text-muted)]" title={file.unstorable}>
            not captured
          </span>
        ) : file.diverged && !forced ? (
          <button
            onClick={onArm}
            className="rounded border border-transparent px-1.5 py-0.5 text-amber-500 transition hover:border-amber-500"
          >
            Revert anyway…
          </button>
        ) : (
          <button
            onClick={() => onRevert(forced)}
            disabled={busy !== null}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${CHROME_QUIET} disabled:opacity-50`}
          >
            {busy === file.path ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Undo2 size={12} />
            )}
            {forced ? "Confirm revert" : "Revert"}
          </button>
        )}
      </div>
    </li>
  );
}
