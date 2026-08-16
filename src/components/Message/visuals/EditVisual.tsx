import { DiffView } from "@/components/common/DiffView";
import type { DiffLine, FileDiff } from "@/lib/types";
import { Shaped } from "./Shaped";

/**
 * Family 1 — a file write as the diff it is (0.13.0).
 *
 * `DiffView` was built for 0.10.2's approval prompt and the review queue, and
 * the step card has never called it: an edit that was approved and landed
 * showed up in the transcript as `{"path": "...", "ok": true}`. The diff is
 * built from the call's own arguments rather than from disk, which is the
 * honest thing to show — it is what this step did, not what the file looks like
 * now after four more edits.
 */

export function EditVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown> | null;
}) {
  const path =
    (typeof result?.path === "string" && result.path) ||
    (typeof args?.path === "string" && args.path) ||
    "";

  const diff = path
    ? name === "create_file"
      ? creationDiff(path, String(args?.content ?? ""))
      : editDiff(path, String(args?.old_text ?? ""), String(args?.new_text ?? ""))
    : null;

  // A write with no path, or an edit whose arguments never arrived, is a shape
  // this component cannot draw — but the tab has already been offered, so it
  // owes the reader something better than an empty pane.
  if (!diff) return <Shaped value={result ?? args} />;

  const note =
    result && result.matched === "whitespace-tolerant"
      ? "Anchor matched ignoring indentation and trailing whitespace"
      : typeof result?.replacements === "number" && (result.replacements as number) > 1
        ? `Applied to ${result.replacements} occurrences`
        : null;

  return (
    <div className="space-y-1">
      <DiffView diff={diff} maxHeight="max-h-[320px]" />
      {note && <div className="text-[10px] text-[var(--color-text-muted)]">{note}</div>}
    </div>
  );
}

function display(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function creationDiff(path: string, content: string): FileDiff {
  const lines = content.length ? content.split("\n") : [];
  const diffLines: DiffLine[] = lines.map((text, i) => ({
    kind: "add",
    oldLine: null,
    newLine: i + 1,
    text,
  }));
  return {
    path,
    displayPath: display(path),
    change: "create",
    added: lines.length,
    removed: 0,
    note: lines.length ? null : "empty file",
    hunks: lines.length
      ? [
          {
            index: 0,
            oldStart: 0,
            oldLen: 0,
            newStart: 1,
            newLen: lines.length,
            added: lines.length,
            removed: 0,
            lines: diffLines,
          },
        ]
      : [],
  };
}

/**
 * A line diff of just the replaced region. Common leading and trailing lines
 * are kept as context rather than shown as a change, so an edit that rewrites
 * one line inside a ten-line anchor reads as one line changed.
 */
function editDiff(path: string, oldText: string, newText: string): FileDiff | null {
  if (!oldText && !newText) return null;
  const before = oldText.split("\n");
  const after = newText.split("\n");

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }

  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  const lines: DiffLine[] = [];

  for (let i = 0; i < head; i++) {
    lines.push({ kind: "context", oldLine: i + 1, newLine: i + 1, text: before[i] });
  }
  removed.forEach((text, i) => {
    lines.push({ kind: "remove", oldLine: head + i + 1, newLine: null, text });
  });
  added.forEach((text, i) => {
    lines.push({ kind: "add", oldLine: null, newLine: head + i + 1, text });
  });
  for (let i = 0; i < tail; i++) {
    const oldLine = before.length - tail + i + 1;
    const newLine = after.length - tail + i + 1;
    lines.push({ kind: "context", oldLine, newLine, text: before[oldLine - 1] });
  }

  return {
    path,
    displayPath: display(path),
    change: "modify",
    added: added.length,
    removed: removed.length,
    note: added.length || removed.length ? null : "no lines changed",
    hunks: [
      {
        index: 0,
        oldStart: 1,
        oldLen: before.length,
        newStart: 1,
        newLen: after.length,
        added: added.length,
        removed: removed.length,
        lines,
      },
    ],
  };
}
