import { useEffect, useLayoutEffect, useRef, useState } from "react";
import functionPlot, { EvalBuiltIn } from "function-plot";
import { useSettledValue } from "@/lib/useSettledValue";
import { readChartTheme, seriesColor, type ChartTheme } from "@/lib/chart";
import { useChartTheme } from "@/components/Renderers/ChartBlock";

/** One curve. `fn` for linear and implicit, `x`/`y` for parametric, `r` for polar. */
export interface PlotCurve {
  type: "linear" | "parametric" | "polar" | "implicit";
  fn?: string;
  x?: string;
  y?: string;
  r?: string;
  range?: [number, number];
  label?: string;
  color?: string;
}

export interface MathPlotData {
  title?: string;
  /** Omitted: [-10, 10] for y = f(x), fitted for the other curve types. */
  xRange?: [number, number];
  /** Omitted: fitted to the curves. */
  yRange?: [number, number];
  xLabel?: string;
  yLabel?: string;
  functions: PlotCurve[];
}

interface SpecProps {
  /** Legacy text spec used by ```mathplot fenced code blocks. */
  spec: string;
}

interface DataProps {
  data: MathPlotData;
}

const PLOT_HEIGHT = 300;

/** What a curve is called in the legend: its label, or the expression. */
function curveName(c: PlotCurve): string {
  if (c.label) return c.label;
  if (c.type === "parametric") return `(${c.x}, ${c.y})`;
  if (c.type === "polar") return `r = ${c.r}`;
  if (c.type === "implicit") return `${c.fn} = 0`;
  return `y = ${c.fn}`;
}

/** function-plot's datum for a curve, coloured from the app's chart palette. */
function toDatum(c: PlotCurve, color: string): any {
  const base = { color, attr: { "stroke-width": 2 } };
  switch (c.type) {
    case "parametric":
      return { ...base, fnType: "parametric", x: c.x, y: c.y, graphType: "polyline", range: c.range ?? [0, 2 * Math.PI] };
    case "polar":
      return { ...base, fnType: "polar", r: c.r, graphType: "polyline", range: c.range ?? [0, 2 * Math.PI] };
    case "implicit":
      return { ...base, fnType: "implicit", fn: c.fn };
    default:
      // Sampled as a line rather than interval boxes, which drew a smooth
      // curve as a staircase; the sampler still breaks at asymptotes.
      return { ...base, fn: c.fn, graphType: "polyline", sampler: "builtIn", nSamples: 600 };
  }
}

/** Sampled points of a curve, for fitting the axes. Evaluation errors are gaps. */
function samplePoints(c: PlotCurve, xRange: [number, number]): [number, number][] {
  const pts: [number, number][] = [];
  const N = 240;
  const at = (datum: any, prop: string, scope: object): number => {
    try {
      const v = EvalBuiltIn(datum, prop, scope);
      return typeof v === "number" ? v : NaN;
    } catch {
      return NaN;
    }
  };
  if (c.type === "linear" || !c.type) {
    const d = { fn: c.fn };
    for (let i = 0; i <= N; i++) {
      const x = xRange[0] + ((xRange[1] - xRange[0]) * i) / N;
      pts.push([x, at(d, "fn", { x })]);
    }
  } else if (c.type === "parametric" || c.type === "polar") {
    const [a, b] = c.range ?? [0, 2 * Math.PI];
    const d = { x: c.x, y: c.y, r: c.r };
    for (let i = 0; i <= N; i++) {
      const t = a + ((b - a) * i) / N;
      if (c.type === "parametric") pts.push([at(d, "x", { t }), at(d, "y", { t })]);
      else {
        const r = at(d, "r", { theta: t });
        pts.push([r * Math.cos(t), r * Math.sin(t)]);
      }
    }
  }
  return pts.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

/**
 * A domain that shows the curve rather than its asymptote: the 2nd–98th
 * percentile of the sampled values, padded. `tan(x)` otherwise fits to ±10¹⁶
 * and draws a flat line.
 */
export function fitDomain(values: number[]): [number, number] | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  let lo = q(0.02);
  let hi = q(0.98);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
}

/**
 * The axes a plot is drawn on: given ranges kept, missing ones fitted. A
 * geometric plot (anything but y = f(x)) with both axes fitted gets equal
 * scales, so a circle is drawn as a circle.
 */
export function resolveDomains(data: MathPlotData, aspect = 2): { x: [number, number]; y: [number, number] } {
  const allLinear = data.functions.every((c) => c.type === "linear" || !c.type);
  let x = data.xRange;
  if (!x && allLinear) x = [-10, 10];
  const pts = data.functions.flatMap((c) => samplePoints(c, x ?? [-10, 10]));
  const fitX = !x;
  if (!x) x = fitDomain(pts.map((p) => p[0])) ?? [-10, 10];
  let y = data.yRange ?? fitDomain(pts.map((p) => p[1])) ?? x;
  if (!allLinear && fitX && !data.yRange) {
    // `aspect` is width / height of the plot area; grow whichever span is short.
    const [xs, ys] = [x[1] - x[0], y[1] - y[0]];
    if (xs / ys < aspect) {
      const grow = (ys * aspect - xs) / 2;
      x = [x[0] - grow, x[1] + grow];
    } else {
      const grow = (xs / aspect - ys) / 2;
      y = [y[0] - grow, y[1] + grow];
    }
  }
  return { x, y };
}

function drawPlot(target: HTMLElement, data: MathPlotData, theme: ChartTheme, width: number) {
  // function-plot's margins are ~30px left/right and ~20px top/bottom.
  const { x, y } = resolveDomains(data, Math.max(1, width - 60) / (PLOT_HEIGHT - 40));
  functionPlot({
    target,
    width,
    height: PLOT_HEIGHT,
    grid: true,
    // The wheel scrolls the chat. A plot that zoomed under it stopped the
    // transcript dead whenever the pointer crossed one.
    disableZoom: true,
    title: data.title,
    xAxis: { domain: x, label: data.xLabel },
    yAxis: { domain: y, label: data.yLabel },
    data: data.functions.map((c, i) => toDatum(c, seriesColor(theme, i, c.color))),
  });
}

export function MathPlotBlock(props: SpecProps | DataProps) {
  // The legacy fenced form streams in a character at a time, and function-plot
  // is not cheap enough to run per token — see `useSettledValue` (0.16.1). A
  // `data` prop comes from a completed tool call and is passed straight
  // through, so nothing about the tool path changes.
  const settledSpec = useSettledValue("data" in props ? "" : props.spec);
  const parsed: MathPlotData | { error: string } =
    "data" in props ? props.data : parseSpec(settledSpec);
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const isError = "error" in parsed;
  const data = isError ? null : parsed;
  const theme = useChartTheme();

  // Drawn at the column's width and redrawn when it changes, like the charts.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setWidth(Math.round(el.clientWidth));
    apply();
    const obs = new ResizeObserver(apply);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!ref.current || !data || width <= 0) return;
    setError(null);
    ref.current.innerHTML = "";
    try {
      drawPlot(ref.current, data, theme, width);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [JSON.stringify(data), theme, width]);

  if (isError || error) {
    const msg = isError ? parsed.error : error;
    return (
      <div className="my-2 rounded border border-[var(--color-danger)] bg-[var(--color-panel)] p-3 text-xs">
        <div className="mb-1 text-[var(--color-danger)]">This plot couldn't be drawn — its definition has a mistake</div>
        <details>
          <summary className="cursor-pointer text-[var(--color-text-muted)]">Details</summary>
          <pre className="mt-1 whitespace-pre-wrap">{msg}</pre>
        </details>
      </div>
    );
  }

  return (
    <div className="math-plot-wrapper my-2 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel)]">
      <div ref={ref} className="w-full px-2 pt-2" />
      {data && data.functions.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-border)] px-3 py-1.5 text-xs">
          {data.functions.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1.5">
              <span className="h-0.5 w-4 shrink-0 rounded" style={{ background: seriesColor(theme, i, c.color) }} />
              <span className="truncate font-mono text-[var(--color-text-muted)]">{curveName(c)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Normalize a `plot_function` tool call's result (or, for calls saved before
 *  0.18.1, its arguments) into plot props. Null when there is nothing to draw. */
export function toMathPlotData(raw: any): MathPlotData | null {
  if (!raw || typeof raw !== "object") return null;
  const range = (v: any): [number, number] | undefined =>
    Array.isArray(v) && v.length === 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))
      ? [Number(v[0]), Number(v[1])]
      : undefined;
  const fns = raw.functions;
  if (!Array.isArray(fns) || fns.length === 0) return null;
  const functions = fns
    .map((f: any): PlotCurve | null => {
      if (typeof f === "string") return { type: "linear", fn: f };
      if (!f || typeof f !== "object") return null;
      const type = ["parametric", "polar", "implicit"].includes(f.type) ? f.type : "linear";
      const curve: PlotCurve = { type, fn: f.fn, x: f.x, y: f.y, r: f.r, range: range(f.range), label: f.label, color: f.color };
      const ok =
        type === "parametric" ? typeof f.x === "string" && typeof f.y === "string"
        : type === "polar" ? typeof f.r === "string"
        : typeof f.fn === "string";
      return ok ? curve : null;
    })
    .filter((f: PlotCurve | null): f is PlotCurve => f !== null);
  if (functions.length === 0) return null;
  return {
    title: raw.title ?? undefined,
    xRange: range(raw.x_range ?? raw.xRange),
    yRange: range(raw.y_range ?? raw.yRange),
    xLabel: raw.x_label ?? raw.xLabel ?? undefined,
    yLabel: raw.y_label ?? raw.yLabel ?? undefined,
    functions,
  };
}

/**
 * Render plot data to a standalone SVG string outside React — used by the PDF
 * export so plots appear as plots. Draws into a detached, off-screen host
 * (function-plot measures its target), then lifts the SVG out.
 */
export function renderPlotSvg(data: MathPlotData): string | null {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:620px;";
  document.body.appendChild(host);
  try {
    drawPlot(host, data, readChartTheme(), 600);
    return host.querySelector("svg")?.outerHTML ?? null;
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

/** Parse YAML-ish spec used by legacy ```mathplot fenced code blocks. */
function parseSpec(text: string): MathPlotData | { error: string } {
  const lines = text.split(/\r?\n/);
  const out: Partial<MathPlotData> & { functions: PlotCurve[] } = {
    functions: [],
  };
  let inFunctions = false;
  let current: { fn?: string; color?: string } | null = null;

  function pushCurrent() {
    if (current && current.fn) {
      out.functions.push({ type: "linear", fn: current.fn, color: current.color });
    }
    current = null;
  }

  function parseRange(raw: string): [number, number] | null {
    const m = raw.match(/\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/);
    if (!m) return null;
    return [parseFloat(m[1]), parseFloat(m[2])];
  }

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (!inFunctions) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const [, key, value] = m;
      if (key === "title") out.title = value.replace(/^["']|["']$/g, "");
      else if (key === "xLabel") out.xLabel = value;
      else if (key === "yLabel") out.yLabel = value;
      else if (key === "xRange") {
        const r = parseRange(value);
        if (r) out.xRange = r;
      } else if (key === "yRange") {
        const r = parseRange(value);
        if (r) out.yRange = r;
      } else if (key === "functions") {
        inFunctions = true;
      }
    } else {
      const item = line.match(/^\s*-\s*fn:\s*(.+)$/);
      const cont = line.match(/^\s+(\w+):\s*(.+)$/);
      if (item) {
        pushCurrent();
        current = { fn: item[1].replace(/^["']|["']$/g, "") };
      } else if (cont && current) {
        const [, key, value] = cont;
        const clean = value.replace(/^["']|["']$/g, "");
        if (key === "fn") current.fn = clean;
        else if (key === "color") current.color = clean;
      }
    }
  }
  pushCurrent();

  if (!out.xRange || !out.yRange) {
    return { error: "mathplot requires xRange and yRange" };
  }
  if (out.functions.length === 0) {
    return { error: "mathplot requires at least one function" };
  }
  return out as MathPlotData;
}
