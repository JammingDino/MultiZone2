import { FilePlus2, FilePen, FileX2, Check } from "lucide-react";
import type { FileDiff, Hunk } from "@/lib/types";

/**
 * A file change as a reviewable diff (0.10.2).
 *
 * Shared by the approval prompt (before a tool runs) and the review queue
 * (after a zone staged its writes), because both are asking the same question
 * and should not answer it in two different visual languages.
 *
 * When `selected` is provided the hunks become individually takeable — the
 * caller then applies only those, so a checkbox here is a real outcome rather
 * than a note about intent.
 */

const CHANGE_ICON = {
  create: FilePlus2,
  modify: FilePen,
  delete: FileX2,
  rename: FilePen,
} as const;

export function DiffView({
  diff,
  selected,
  onToggleHunk,
  maxHeight = "max-h-[320px]",
}: {
  diff: FileDiff;
  /** Indices of the hunks currently taken. Omit for a read-only diff. */
  selected?: Set<number>;
  onToggleHunk?: (index: number) => void;
  maxHeight?: string;
}) {
  const Icon = CHANGE_ICON[diff.change] ?? FilePen;
  const selectable = selected !== undefined && onToggleHunk !== undefined;

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5">
        <Icon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="truncate font-mono text-[var(--color-text)]" title={diff.path}>
          {diff.displayPath}
        </span>
        <span className="shrink-0 text-[var(--color-text-muted)]">
          {diff.change === "create" ? "new file" : diff.change}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          <span className="text-emerald-500">+{diff.added}</span>{" "}
          <span className="text-red-500">−{diff.removed}</span>
        </span>
      </div>

      {diff.note ? (
        <p className="px-2 py-1.5 text-[var(--color-text-muted)]">{diff.note}</p>
      ) : (
        <div className={`${maxHeight} overflow-auto`}>
          {diff.hunks.map((hunk) => (
            <HunkView
              key={hunk.index}
              hunk={hunk}
              // Without a selection every hunk is simply part of the change.
              taken={selectable ? selected.has(hunk.index) : true}
              onToggle={selectable ? () => onToggleHunk(hunk.index) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HunkView({
  hunk,
  taken,
  onToggle,
}: {
  hunk: Hunk;
  taken: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className={onToggle && !taken ? "opacity-45" : undefined}>
      <div className="flex items-center gap-2 border-y border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 first:border-t-0">
        {onToggle && (
          <button
            onClick={onToggle}
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
              taken
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                : "border-[var(--color-border)]"
            }`}
            title={taken ? "This hunk will be applied" : "This hunk will be left out"}
          >
            {taken && <Check size={10} />}
          </button>
        )}
        <span className="font-mono text-[var(--color-text-muted)]">
          @@ −{hunk.oldStart + 1},{hunk.oldLen} +{hunk.newStart + 1},{hunk.newLen} @@
        </span>
        <span className="ml-auto tabular-nums text-[var(--color-text-muted)]">
          +{hunk.added} −{hunk.removed}
        </span>
      </div>
      <pre className="overflow-x-auto font-mono leading-[1.45]">
        {hunk.lines.map((line, i) => (
          <div
            key={i}
            className={
              line.kind === "add"
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : line.kind === "remove"
                  ? "bg-red-500/10 text-red-600 dark:text-red-400"
                  : "text-[var(--color-text-muted)]"
            }
          >
            <span className="inline-block w-10 select-none pr-2 text-right opacity-50">
              {line.kind === "add" ? line.newLine : line.oldLine}
            </span>
            <span className="select-none pr-1">
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
            </span>
            {line.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
