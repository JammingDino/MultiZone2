import { Folder, FileText } from "lucide-react";
import { Shaped } from "./Shaped";

/**
 * Family 3 — a directory listing as a tree (0.13.1).
 *
 * `read` returns a nested object where a folder maps to its children
 * and a file maps to its extension, which is compact to send and unreadable to
 * look at. `glob` returns a flat list, grouped here by folder so a
 * hundred matches read as a handful of places rather than a hundred lines.
 *
 * Truncation is always stated. A listing that silently stopped at the limit is
 * how someone concludes a file isn't there.
 */

const MAX_ROWS = 120;

export function TreeVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  if (name === "glob") {
    const files = Array.isArray(result.files) ? (result.files as unknown[]).map(String) : [];
    return (
      <Frame
        title={str(args?.pattern) || "matches"}
        count={`${files.length} file${files.length === 1 ? "" : "s"}`}
        truncated={result.truncated === true}
        note={str(result.note)}
      >
        <Grouped paths={files} />
      </Frame>
    );
  }

  // read: the whole result *is* the tree.
  const entries = Object.entries(result);
  if (entries.length === 0) {
    return (
      <Frame title={str(args?.path) || "."} count="empty" truncated={false} note="">
        <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">
          Nothing in this folder.
        </div>
      </Frame>
    );
  }
  const { folders, files } = split(result);
  return (
    <Frame
      title={str(args?.path) || "."}
      count={`${folders} folder${folders === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}`}
      truncated={false}
      note=""
    >
      <Branch node={result} depth={0} />
    </Frame>
  );
}

function Frame({
  title,
  count,
  truncated,
  note,
  children,
}: {
  title: string;
  count: string;
  truncated: boolean;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-[11px]">
        <Folder size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 truncate font-mono text-[var(--color-text)]" title={title}>
          {title}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">{count}</span>
      </div>
      <div className="max-h-[320px] overflow-auto py-1">{children}</div>
      {(truncated || note) && (
        <div className="border-t border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          {truncated ? "Truncated — more matched than are listed here. " : ""}
          {note}
        </div>
      )}
    </div>
  );
}

/** A folder maps to an object, a file to its extension. */
function Branch({ node, depth }: { node: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(node);
  return (
    <>
      {entries.map(([key, value]) => {
        const isFolder = !!value && typeof value === "object";
        // The backend marks "there is more below the depth limit" with a single
        // "…" child, which should read as an ellipsis rather than a file.
        if (key === "…") {
          return (
            <Row key="…" depth={depth} muted>
              …
            </Row>
          );
        }
        if (!isFolder) {
          return (
            <Row key={key} depth={depth} icon={<FileText size={11} />}>
              {key}
            </Row>
          );
        }
        const child = value as Record<string, unknown>;
        return (
          <div key={key}>
            <Row depth={depth} icon={<Folder size={11} />} bold>
              {key}
            </Row>
            <Branch node={child} depth={depth + 1} />
          </div>
        );
      })}
    </>
  );
}

function Row({
  depth,
  icon,
  bold,
  muted,
  children,
}: {
  depth: number;
  icon?: React.ReactNode;
  bold?: boolean;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-0.5 font-mono text-[11px] ${
        muted ? "text-[var(--color-text-muted)]" : bold ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"
      }`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      {icon && <span className="shrink-0 opacity-60">{icon}</span>}
      <span className="truncate">{children}</span>
    </div>
  );
}

/** Flat match lists read better grouped by the folder they sit in. */
function Grouped({ paths }: { paths: string[] }) {
  if (paths.length === 0) {
    return <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">No matches.</div>;
  }
  const groups = new Map<string, string[]>();
  for (const p of paths.slice(0, MAX_ROWS)) {
    const parts = p.split(/[\\/]/);
    const file = parts.pop() ?? p;
    const dir = parts.join("/") || ".";
    const list = groups.get(dir);
    if (list) list.push(file);
    else groups.set(dir, [file]);
  }
  const rest = paths.length - Math.min(paths.length, MAX_ROWS);

  return (
    <>
      {[...groups].map(([dir, files]) => (
        <div key={dir}>
          <Row depth={0} icon={<Folder size={11} />} bold>
            {dir}
          </Row>
          {files.map((f) => (
            <Row key={`${dir}/${f}`} depth={1} icon={<FileText size={11} />}>
              {f}
            </Row>
          ))}
        </div>
      ))}
      {rest > 0 && (
        <Row depth={0} muted>
          + {rest} more — full list on the Output tab
        </Row>
      )}
    </>
  );
}

function split(node: Record<string, unknown>): { folders: number; files: number } {
  let folders = 0;
  let files = 0;
  for (const [key, value] of Object.entries(node)) {
    if (key === "…") continue;
    if (value && typeof value === "object") {
      folders++;
      const inner = split(value as Record<string, unknown>);
      folders += inner.folders;
      files += inner.files;
    } else {
      files++;
    }
  }
  return { folders, files };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Re-exported so an unexpected shape still renders as something. */
export { Shaped };
