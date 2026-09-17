import { FileText, FolderPlus, MoveRight, Copy, Trash2 } from "lucide-react";
import { revealPath } from "@/lib/tauri";
import { Shaped } from "./Shaped";

/**
 * Family 2 — a file the tool touched, as a card (0.13.0/0.13.1).
 *
 * A read used to be its own content escaped inside a JSON string, which is the
 * worst way to look at a file: the newlines are `\n` and the quotes are
 * backslashed. Here the path is a real path (clickable, reveals in the OS file
 * manager), the size is stated, and the first lines are shown as text.
 */

const PREVIEW_LINES = 15;

export function FileVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  // Every card here is built around a path. Without one — an unfamiliar result
  // shape, or an image read that came back as content parts — the tab has
  // already been offered, so it owes the reader the result rather than nothing.
  if (!anyPath(name, args, result)) return <Shaped value={result} />;

  if (name === "move_file" || name === "copy_file") {
    return (
      <Card
        icon={name === "move_file" ? MoveRight : Copy}
        path={str(result.to) || str(args?.to)}
        facts={[
          name === "move_file" ? "moved" : "copied",
          typeof result.bytes_copied === "number" ? bytes(result.bytes_copied) : null,
        ]}
        from={str(result.from) || str(args?.from)}
      />
    );
  }

  if (name === "delete_file") {
    const path = str(result.deleted) || str(args?.path);
    return (
      <Card
        icon={Trash2}
        path={path}
        struck
        facts={[str(result.kind) || "deleted"]}
      />
    );
  }

  if (name === "create_folder") {
    return <Card icon={FolderPlus} path={str(result.path) || str(args?.path)} facts={["created"]} />;
  }

  // read
  const path = str(result.path) || str(result.source) || str(args?.path);
  const content = str(result.content);
  const note = str(result.note);
  const lines = content ? content.split("\n") : [];
  const shown = lines.slice(0, PREVIEW_LINES);
  // A windowed read (0.14.1) reports where it stopped. Saying "1200 lines" for a
  // window of a 4,000-line file describes the message rather than the file, and
  // this card is read as a statement about the file.
  const win = result.lines as { total?: number; from?: number; to?: number } | undefined;
  const lineFact =
    win && typeof win.total === "number"
      ? win.to && win.total > win.to - (win.from ?? 1) + 1
        ? `lines ${win.from}–${win.to} of ${win.total}`
        : `${win.total} line${win.total === 1 ? "" : "s"}`
      : lines.length
        ? `${lines.length} line${lines.length === 1 ? "" : "s"}`
        : null;

  return (
    <Card
      icon={FileText}
      path={path}
      facts={[
        // A PDF read is a selection, not the whole document — which pages came
        // back is the first thing you need to know about it, and the tool
        // already reports it.
        typeof result.page_count === "number"
          ? `${str(result.pages_read) || "pages"} of ${result.page_count}`
          : null,
        lineFact,
        content ? bytes(content.length) : null,
        language(path),
      ]}
    >
      {shown.length > 0 && (
        <div className="border-t border-[var(--color-border)]">
          <pre className="max-h-[240px] overflow-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {shown.join("\n")}
          </pre>
          {lines.length > shown.length && (
            <div className="px-2 pb-1.5 text-[10px] text-[var(--color-text-muted)]">
              + {lines.length - shown.length} more lines — full text on the Output tab
            </div>
          )}
        </div>
      )}
      {note && (
        <div className="border-t border-[var(--color-border)] px-2 py-1.5 text-[10px] text-[var(--color-text-muted)]">
          {note}
        </div>
      )}
    </Card>
  );
}

function Card({
  icon: Icon,
  path,
  facts,
  from,
  struck,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  path: string;
  facts: (string | null)[];
  from?: string;
  struck?: boolean;
  children?: React.ReactNode;
}) {
  if (!path) return null;
  const shown = facts.filter(Boolean) as string[];
  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
        <Icon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        {from && (
          <>
            <span className="truncate text-[var(--color-text-muted)]" title={from}>
              {base(from)}
            </span>
            <span className="text-[var(--color-text-muted)]">→</span>
          </>
        )}
        <button
          onClick={() => revealPath(path)}
          title={`${path}\nClick to show in folder`}
          className={`min-w-0 truncate text-left hover:underline ${
            struck ? "text-[var(--color-text-muted)] line-through" : "text-[var(--color-text)]"
          }`}
        >
          {base(path)}
        </button>
        {shown.length > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">
            {shown.join(" · ")}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function anyPath(name: string, args: any, result: Record<string, unknown>): boolean {
  const candidates =
    name === "move_file" || name === "copy_file"
      ? [result.to, args?.to]
      : name === "delete_file"
        ? [result.deleted, args?.path]
        : [result.path, result.source, args?.path];
  return candidates.some((c) => typeof c === "string" && c.length > 0);
}

function base(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function language(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext || ext === path.toLowerCase()) return null;
  return ext;
}
