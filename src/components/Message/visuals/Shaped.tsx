import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

/**
 * The shaped fallback (0.13.0) — what a tool result looks like when no family
 * claims it.
 *
 * This is the most-used renderer in the app once MCP tools are counted, because
 * their number is unbounded and none of them can be mapped in advance. It is
 * therefore built as the good default rather than the leftover: an array of
 * objects becomes a table, an object becomes a key/value list with nested
 * values collapsible, a long string becomes text rather than a quoted JSON
 * blob. Raw JSON stays available on the Output tab for anyone who wants it.
 */

const MAX_ROWS = 50;
const LONG_TEXT = 120;

export function Shaped({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) {
    return <span className="text-[var(--color-text-muted)]">—</span>;
  }
  if (typeof value === "boolean") {
    return <span className={value ? "text-emerald-400" : "text-[var(--color-text-muted)]"}>{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="tabular-nums text-[var(--color-text)]">{value}</span>;
  }
  if (typeof value === "string") {
    return <ShapedString text={value} />;
  }
  if (Array.isArray(value)) {
    return <ShapedArray items={value} depth={depth} />;
  }
  if (typeof value === "object") {
    return <ShapedObject obj={value as Record<string, unknown>} depth={depth} />;
  }
  return <span>{String(value)}</span>;
}

/**
 * A string that is itself JSON is shaped too — several tools return a JSON
 * document as a string field, and showing it escaped is the exact problem this
 * component exists to solve.
 */
function ShapedString({ text }: { text: string }) {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 2) {
    try {
      return <Shaped value={JSON.parse(trimmed)} depth={1} />;
    } catch {
      /* not JSON after all — fall through */
    }
  }
  if (text.length > LONG_TEXT || text.includes("\n")) {
    return (
      <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words text-[var(--color-text-muted)]">
        {text}
      </pre>
    );
  }
  return <span className="break-words text-[var(--color-text)]">{text}</span>;
}

/** Every element an object, and every object the same shape → a table. */
function isTabular(items: unknown[]): items is Record<string, unknown>[] {
  if (items.length < 2) return false;
  const first = items[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return false;
  const keys = Object.keys(first as object);
  if (keys.length === 0 || keys.length > 6) return false;
  return items.every(
    (it) =>
      !!it &&
      typeof it === "object" &&
      !Array.isArray(it) &&
      keys.every((k) => k in (it as object)) &&
      // Nested structure doesn't belong in a table cell.
      keys.every((k) => {
        const v = (it as Record<string, unknown>)[k];
        return v === null || typeof v !== "object";
      }),
  );
}

function ShapedArray({ items, depth }: { items: unknown[]; depth: number }) {
  if (items.length === 0) {
    return <span className="text-[var(--color-text-muted)]">(empty)</span>;
  }
  const shown = items.slice(0, MAX_ROWS);
  const rest = items.length - shown.length;

  if (isTabular(items)) {
    const keys = Object.keys(items[0]);
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr>
              {keys.map((k) => (
                <th
                  key={k}
                  className="border-b border-[var(--color-border)] px-2 py-1 text-left font-medium uppercase tracking-wide text-[10px] text-[var(--color-text-muted)]"
                >
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(shown as Record<string, unknown>[]).map((row, i) => (
              <tr key={i} className="border-b border-[var(--color-border)]/40 last:border-0">
                {keys.map((k) => (
                  <td key={k} className="px-2 py-1 align-top">
                    <Shaped value={row[k]} depth={depth + 1} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rest > 0 && <Truncation count={rest} />}
      </div>
    );
  }

  // Scalars read better as a list than as a one-column table.
  return (
    <div className="space-y-0.5">
      {shown.map((item, i) => (
        <div key={i} className="flex gap-2">
          <span className="select-none tabular-nums text-[10px] text-[var(--color-text-muted)]">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <Shaped value={item} depth={depth + 1} />
          </div>
        </div>
      ))}
      {rest > 0 && <Truncation count={rest} />}
    </div>
  );
}

function ShapedObject({ obj, depth }: { obj: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return <span className="text-[var(--color-text-muted)]">(empty)</span>;
  }
  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <Row key={k} label={k} value={v} depth={depth} />
      ))}
    </div>
  );
}

function Row({ label, value, depth }: { label: string; value: unknown; depth: number }) {
  const nested = !!value && typeof value === "object";
  // Nested structure below the first level starts folded — the point is to make
  // the shape readable, not to reproduce the whole document inline.
  const [open, setOpen] = useState(depth < 1);

  if (!nested) {
    return (
      <div className="flex gap-2">
        <span className="w-32 flex-shrink-0 truncate text-[var(--color-text-muted)]" title={label}>
          {label}
        </span>
        <div className="min-w-0 flex-1">
          <Shaped value={value} depth={depth + 1} />
        </div>
      </div>
    );
  }

  const count = Array.isArray(value)
    ? `${value.length} item${value.length === 1 ? "" : "s"}`
    : `${Object.keys(value as object).length} field${
        Object.keys(value as object).length === 1 ? "" : "s"
      }`;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-left hover:text-[var(--color-text)]"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className="text-[var(--color-text-muted)]">{label}</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">· {count}</span>
      </button>
      {open && (
        <div className="mt-1 border-l border-[var(--color-border)] pl-2">
          <Shaped value={value} depth={depth + 1} />
        </div>
      )}
    </div>
  );
}

function Truncation({ count }: { count: number }) {
  return (
    <div className="pt-1 text-[10px] text-[var(--color-text-muted)]">
      + {count} more — full result on the Output tab
    </div>
  );
}
