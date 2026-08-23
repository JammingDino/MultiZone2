import { Children, cloneElement, isValidElement, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { ArrowDown, ArrowUp, BarChart3, Check, Copy, Search, X } from "lucide-react";
import { ChartBlock } from "./ChartBlock";
import { type ChartData, type ChartType, toChartData } from "@/lib/chart";
import { CHROME_QUIET } from "@/lib/chrome";

/**
 * Interactive tables (0.16.1) and "chart this" (0.16.0).
 *
 * A markdown table in an answer is usually the *end* of some work — the model
 * has already done the extraction and the arithmetic — and the two things a
 * reader then wants are to reorder it and to see it as a picture. Both were
 * previously a copy-paste into something else.
 *
 * The rows are rendered from the markdown's own React children rather than from
 * extracted text, so a cell keeps its links, code spans and emphasis; the plain
 * text pulled off the parallel hast node is used only for the parts that need
 * to compare, match or arithmetic on values. Reordering is then a permutation
 * of children, and a cell renders identically sorted or not.
 */

// ─── Reading the table ───────────────────────────────────────────────────────

interface Matrix {
  headers: string[];
  rows: string[][];
}

/** All the text under a hast node, joined — the sort key and the filter target. */
function hastText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return String(node.value ?? "");
  if (!Array.isArray(node.children)) return "";
  return node.children.map(hastText).join("");
}

function hastChildren(node: any, tag: string): any[] {
  if (!node || !Array.isArray(node.children)) return [];
  return node.children.filter((c: any) => c?.type === "element" && c.tagName === tag);
}

/** The table's text, or null when it is not the shape GFM produces. */
function matrixFromHast(node: any): Matrix | null {
  const head = hastChildren(node, "thead")[0];
  const body = hastChildren(node, "tbody")[0];
  if (!head || !body) return null;
  const headerRow = hastChildren(head, "tr")[0];
  if (!headerRow) return null;
  const headers = hastChildren(headerRow, "th").map(hastText);
  const rows = hastChildren(body, "tr").map((tr) =>
    hastChildren(tr, "td").map((td) => hastText(td).trim()),
  );
  if (headers.length === 0 || rows.length === 0) return null;
  return { headers, rows };
}

/**
 * A cell as a number, if it is one. Models write money, percentages and
 * thousands separators into tables constantly, and a column of "$1,240" that
 * sorts as text puts $99 above $1,240 — which is worse than not sorting.
 * Accounting negatives — "(320)" — are the other common one.
 */
function parseCell(raw: string): number | null {
  let s = raw.trim();
  if (isBlankCell(s)) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  s = s.replace(/[,\s_]/g, "").replace(/^[$£€¥]/, "").replace(/%$/, "");
  // A bare unit suffix ("120ms", "4.2GB") is a number for sorting purposes.
  const m = /^-?\d*\.?\d+(?:e[+-]?\d+)?/i.exec(s);
  if (!m || m[0] === "") return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? sign * n : null;
}

/**
 * A cell that says "nothing here". Kept apart from "this is not a number",
 * because a column of measurements with two `n/a`s in it is still a column of
 * measurements — counting those against it is what stops it being chartable.
 */
function isBlankCell(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t === "" || t === "—" || t === "-" || t === "–" || t === "n/a" || t === "null" || t === "none";
}

/** Columns where most of the filled cells are numbers — the chartable ones. */
function numericColumns(matrix: Matrix): number[] {
  const out: number[] = [];
  for (let c = 0; c < matrix.headers.length; c += 1) {
    let filled = 0;
    let numeric = 0;
    for (const row of matrix.rows) {
      const cell = row[c] ?? "";
      if (isBlankCell(cell)) continue;
      filled += 1;
      if (parseCell(cell) !== null) numeric += 1;
    }
    if (filled > 0 && numeric / filled >= 0.8) out.push(c);
  }
  return out;
}

/** "%" or a currency, when a whole column agrees on one — carried into the chart. */
function columnUnit(matrix: Matrix, col: number): string | undefined {
  const cells = matrix.rows.map((r) => (r[col] ?? "").trim()).filter((c) => !isBlankCell(c));
  if (cells.length === 0) return undefined;
  if (cells.every((c) => c.endsWith("%"))) return "%";
  return undefined;
}

/**
 * The table as a chart. The first non-numeric column names the rows and every
 * numeric column becomes a series.
 *
 * When *every* column is numeric the first one is the labels rather than a
 * series — a "Year | Revenue" table is the ordinary case, and charting the year
 * as a quantity beside the revenue is never what was meant. Only a
 * single-column table falls back to row numbers.
 */
export function chartFromTable(matrix: Matrix, type: ChartType): ChartData | null {
  let numeric = numericColumns(matrix);
  if (numeric.length === 0) return null;
  let labelCol = matrix.headers.findIndex((_, i) => !numeric.includes(i));
  if (labelCol < 0 && matrix.headers.length > 1) {
    labelCol = 0;
    numeric = numeric.filter((c) => c !== 0);
    if (numeric.length === 0) return null;
  }
  const labels =
    labelCol >= 0
      ? matrix.rows.map((r) => r[labelCol] ?? "")
      : matrix.rows.map((_, i) => String(i + 1));

  // A pie shows one quantity; given several, the first numeric column is the
  // only honest reading of "chart this as a pie".
  const cols = type === "pie" ? numeric.slice(0, 1) : numeric;

  return toChartData({
    type,
    labels,
    unit: columnUnit(matrix, cols[0]),
    // Long or numerous labels read down the side; this is the same rule the
    // tool's description gives the model.
    horizontal:
      type === "bar" && (labels.length > 8 || labels.some((l) => l.length > 14)),
    series: cols.map((c) => ({
      name: matrix.headers[c] || `Column ${c + 1}`,
      values: matrix.rows.map((r) => parseCell(r[c] ?? "")),
    })),
  });
}

// ─── The component ───────────────────────────────────────────────────────────

type SortDir = "asc" | "desc";

/** Elements only: react-markdown leaves whitespace text nodes between them. */
function elementsOf(children: ReactNode): ReactElement<any>[] {
  return Children.toArray(children).filter(isValidElement) as ReactElement<any>[];
}

function findTag(children: ReactNode, tag: string): ReactElement<any> | null {
  return elementsOf(children).find((el) => el.type === tag) ?? null;
}

const CHART_CHOICES: ChartType[] = ["bar", "line", "area", "pie"];
/** Below this a filter box is chrome around a table you can already read. */
const FILTER_THRESHOLD = 8;

export function MarkdownTable({ node, children, ...rest }: any) {
  const matrix = useMemo(() => matrixFromHast(node), [node]);
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const [filter, setFilter] = useState("");
  const [chartType, setChartType] = useState<ChartType | null>(null);
  const [copied, setCopied] = useState(false);

  const thead = findTag(children, "thead");
  const tbody = findTag(children, "tbody");
  const headerCells = thead ? elementsOf(elementsOf(thead.props.children)[0]?.props.children) : [];
  const bodyRows = tbody ? elementsOf(tbody.props.children) : [];

  // Anything that isn't the table GFM produces is left exactly as it was.
  const usable = matrix !== null && bodyRows.length === matrix.rows.length && headerCells.length > 0;

  const numeric = useMemo(() => (matrix ? numericColumns(matrix) : []), [matrix]);

  /** Row indices in display order: filtered, then sorted. */
  const order = useMemo(() => {
    if (!matrix) return [];
    const needle = filter.trim().toLowerCase();
    let idx = matrix.rows.map((_, i) => i);
    if (needle !== "") {
      idx = idx.filter((i) => matrix.rows[i].join(" ").toLowerCase().includes(needle));
    }
    if (sort) {
      const { col, dir } = sort;
      const sign = dir === "asc" ? 1 : -1;
      idx = [...idx].sort((a, b) => {
        const av = matrix.rows[a][col] ?? "";
        const bv = matrix.rows[b][col] ?? "";
        const an = parseCell(av);
        const bn = parseCell(bv);
        // Blanks sort last in both directions: a missing value is not a small one.
        if (an === null && bn === null) return av.localeCompare(bv) * sign;
        if (an === null) return 1;
        if (bn === null) return -1;
        return (an - bn) * sign;
      });
    }
    return idx;
  }, [matrix, filter, sort]);

  const chart = useMemo(
    () => (matrix && chartType ? chartFromTable(matrix, chartType) : null),
    [matrix, chartType],
  );

  if (!usable || !matrix) {
    return (
      <div className="my-2 overflow-x-auto">
        <table {...rest}>{children}</table>
      </div>
    );
  }

  function toggleSort(col: number) {
    setSort((cur) =>
      cur?.col !== col ? { col, dir: "asc" } : cur.dir === "asc" ? { col, dir: "desc" } : null,
    );
  }

  async function onCopy() {
    // What is on screen, not what was written: someone who has just filtered a
    // table to four rows is copying those four rows.
    const lines = [matrix!.headers, ...order.map((i) => matrix!.rows[i])];
    await navigator.clipboard.writeText(lines.map((r) => r.join("\t")).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const hidden = matrix.rows.length - order.length;

  return (
    <div className="my-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
        {matrix.rows.length >= FILTER_THRESHOLD && (
          <div className="relative flex items-center">
            <Search size={11} className="pointer-events-none absolute left-1.5 opacity-70" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter"
              className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-bg)] py-0.5 pl-6 pr-1.5 text-[11px] outline-none focus:border-[var(--color-accent)]"
            />
            {filter !== "" && (
              <button onClick={() => setFilter("")} className="absolute right-1 opacity-70 hover:opacity-100">
                <X size={11} />
              </button>
            )}
          </div>
        )}
        {hidden > 0 && <span>{hidden} hidden</span>}
        <div className="flex-1" />
        {numeric.length > 0 && (
          <div className="flex items-center gap-0.5">
            {chartType === null ? (
              <button
                onClick={() => setChartType(CHART_CHOICES[0])}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${CHROME_QUIET}`}
              >
                <BarChart3 size={11} /> chart this
              </button>
            ) : (
              <>
                {CHART_CHOICES.map((t) => (
                  <button
                    key={t}
                    onClick={() => setChartType(t)}
                    className={`rounded px-1.5 py-0.5 ${CHROME_QUIET} ${
                      t === chartType ? "!text-[var(--color-accent)]" : ""
                    }`}
                  >
                    {t}
                  </button>
                ))}
                <button onClick={() => setChartType(null)} className={`rounded px-1 py-0.5 ${CHROME_QUIET}`}>
                  <X size={11} />
                </button>
              </>
            )}
          </div>
        )}
        <button onClick={onCopy} className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${CHROME_QUIET}`}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "copied" : "copy"}
        </button>
      </div>

      {chart && <ChartBlock data={chart} />}

      <div className="overflow-x-auto">
        <table {...rest}>
          <thead>
            <tr>
              {headerCells.map((th, i) =>
                cloneElement(
                  th,
                  { key: i },
                  <button
                    onClick={() => toggleSort(i)}
                    title="Sort by this column"
                    className="inline-flex items-center gap-1 hover:text-[var(--color-text)]"
                  >
                    {th.props.children}
                    {sort?.col === i &&
                      (sort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </button>,
                ),
              )}
            </tr>
          </thead>
          <tbody>{order.map((i) => cloneElement(bodyRows[i], { key: i }))}</tbody>
        </table>
      </div>

      {order.length === 0 && (
        <div className="py-2 text-center text-[11px] text-[var(--color-text-muted)]">
          No rows match “{filter}”.
        </div>
      )}
    </div>
  );
}
