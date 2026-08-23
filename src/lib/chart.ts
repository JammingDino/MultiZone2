/**
 * Charts from data (0.16.0).
 *
 * `render_graph` could draw a diagram or plot a function, but not draw *data* —
 * so a model holding numbers either approximated them in Mermaid or hand-wrote
 * SVG. This module takes a data spec (labels, series, chart type) and returns an
 * SVG string.
 *
 * A string rather than a React tree, and no charting dependency, for three
 * reasons that turned out to be the same reason. Export has to render charts
 * rather than dropping to a placeholder, and a string is what the export
 * pipeline already knows how to embed (see `renderPlotSvg`). The palette has to
 * come from the *active* theme, which is a value we read once and pass in rather
 * than a stylesheet a library owns. And "never distinguishes series by colour
 * alone" is a property of how the marks are drawn — every series carries a dash
 * pattern, a marker shape and a fill texture as well as a hue — which is not
 * something a general-purpose library does for us.
 */

// ─── Theme ───────────────────────────────────────────────────────────────────

export interface ChartTheme {
  mode: "dark" | "light";
  bg: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
}

export const DARK_CHART_THEME: ChartTheme = {
  mode: "dark",
  bg: "#0b0d10",
  panel: "#14171c",
  border: "#2d333d",
  text: "#e4e6eb",
  muted: "#8b929e",
  accent: "#4f9cf9",
};

const LIGHT_CHART_THEME: ChartTheme = {
  mode: "light",
  bg: "#fafafa",
  panel: "#ffffff",
  border: "#d8dde4",
  text: "#1f2329",
  muted: "#5b6573",
  accent: "#2f80ed",
};

/**
 * The palette actually on screen. Reads the same custom properties the rest of
 * the app is painted with, so a user who has repainted their background gets
 * axes that are still readable against it.
 */
export function readChartTheme(): ChartTheme {
  if (typeof document === "undefined") return DARK_CHART_THEME;
  const root = document.documentElement;
  const base = root.classList.contains("light") ? LIGHT_CHART_THEME : DARK_CHART_THEME;
  const cs = getComputedStyle(root);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    mode: base.mode,
    bg: v("--color-bg", base.bg),
    panel: v("--color-panel", base.panel),
    border: v("--color-border", base.border),
    text: v("--color-text", base.text),
    muted: v("--color-text-muted", base.muted),
    accent: v("--color-accent", base.accent),
  };
}

/**
 * Series hues, chosen to stay distinguishable against both the light and the
 * dark surface. The theme accent leads, so a one-series chart looks like it
 * belongs to this app rather than to a charting library; the rest are fixed, so
 * a chart does not change meaning when the user changes their accent.
 */
const SERIES_HUES: Record<"dark" | "light", string[]> = {
  dark: ["#4f9cf9", "#f2994a", "#27ae60", "#eb5757", "#bb6bd9", "#f2c94c", "#56ccf2", "#a0aec0"],
  light: ["#2f80ed", "#d97706", "#159457", "#d63031", "#8e44ad", "#b7791f", "#0e7490", "#64748b"],
};

/** Stroke dash per series — the second channel after hue, for lines. */
const SERIES_DASH = ["", "7 3", "2 3", "10 3 2 3", "1 4", "14 4", "5 2 1 2", "3 3"];
/** Marker shape per series — the third channel, and the one that survives print. */
const SERIES_MARKER = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "cross",
  "triangle-down",
  "star",
  "hexagon",
] as const;
type MarkerShape = (typeof SERIES_MARKER)[number];

function seriesColor(theme: ChartTheme, index: number, override?: string): string {
  if (override) return override;
  if (index === 0) return theme.accent;
  return SERIES_HUES[theme.mode][index % SERIES_HUES[theme.mode].length];
}

function markerFor(index: number): MarkerShape {
  return SERIES_MARKER[index % SERIES_MARKER.length];
}

function dashFor(index: number): string {
  return SERIES_DASH[index % SERIES_DASH.length];
}

// ─── Spec ────────────────────────────────────────────────────────────────────

export const CHART_TYPES = ["bar", "line", "area", "scatter", "pie"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartSeries {
  name: string;
  /** One value per label. `null` is a gap, not a zero. */
  values: (number | null)[];
  /** Scatter and line may carry their own x — used in preference to `values`. */
  points?: ChartPoint[];
  color?: string;
}

export interface ChartData {
  type: ChartType;
  title?: string;
  labels: string[];
  series: ChartSeries[];
  stacked?: boolean;
  /** Bar only: categories run down the side rather than along the bottom. */
  horizontal?: boolean;
  xLabel?: string;
  yLabel?: string;
  /** Appended to values wherever they are printed, e.g. "%", " ms", " GB". */
  unit?: string;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[, _]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Normalize a `render_chart` call's arguments (or its echoed result) into chart
 * data. Accepts snake_case from the tool and camelCase from the fenced-block
 * form, and returns null when there is nothing chartable — the caller then
 * renders the raw call rather than an empty frame.
 */
export function toChartData(raw: any): ChartData | null {
  if (!raw || typeof raw !== "object") return null;

  const requested = String(raw.type ?? raw.chart_type ?? raw.chartType ?? "bar").toLowerCase();
  const chartType: ChartType | null = (CHART_TYPES as readonly string[]).includes(requested)
    ? (requested as ChartType)
    : requested === "column"
      ? "bar"
      : requested === "donut" || requested === "doughnut"
        ? "pie"
        : null;
  if (!chartType) return null;

  const rawSeries: any[] = Array.isArray(raw.series)
    ? raw.series
    : Array.isArray(raw.data)
      ? raw.data
      : [];
  if (rawSeries.length === 0) return null;

  let labels: string[] = Array.isArray(raw.labels)
    ? raw.labels.map((l: unknown) => String(l))
    : Array.isArray(raw.categories)
      ? raw.categories.map((l: unknown) => String(l))
      : [];

  const series: ChartSeries[] = [];
  for (let i = 0; i < rawSeries.length; i += 1) {
    const s = rawSeries[i];
    if (typeof s !== "object" || s === null) continue;
    const name = str(s.name) ?? str(s.label) ?? `Series ${i + 1}`;
    const points = Array.isArray(s.points)
      ? (s.points
          .map((p: any) => {
            const x = Array.isArray(p) ? num(p[0]) : num(p?.x);
            const y = Array.isArray(p) ? num(p[1]) : num(p?.y);
            return x === null || y === null ? null : { x, y };
          })
          .filter((p: ChartPoint | null): p is ChartPoint => p !== null) as ChartPoint[])
      : undefined;
    const values: (number | null)[] = Array.isArray(s.values)
      ? s.values.map(num)
      : Array.isArray(s.data)
        ? s.data.map(num)
        : num(s.value) !== null
          ? [num(s.value)]
          : [];
    if ((!points || points.length === 0) && values.length === 0) continue;
    series.push({ name, values, points, color: str(s.color) });
  }
  if (series.length === 0) return null;

  // A model that wants a pie of three named quantities often writes them as
  // three one-value series rather than one series of three values. Both are
  // fair readings of the schema; fold the first into the second.
  const allSingle = series.length > 1 && series.every((s) => s.values.length === 1 && !s.points);
  if (allSingle && labels.length === 0) {
    labels = series.map((s) => s.name);
    const folded: ChartSeries = {
      name: str(raw.value_label) ?? str(raw.valueLabel) ?? "Value",
      values: series.map((s) => s.values[0]),
    };
    series.length = 0;
    series.push(folded);
  }

  const longest = series.reduce((n, s) => Math.max(n, s.values.length), 0);
  for (let i = labels.length; i < longest; i += 1) labels.push(String(i + 1));

  return {
    type: chartType,
    title: str(raw.title),
    labels,
    series,
    stacked: raw.stacked === true,
    horizontal: raw.horizontal === true || raw.orientation === "horizontal",
    xLabel: str(raw.x_label) ?? str(raw.xLabel),
    yLabel: str(raw.y_label) ?? str(raw.yLabel),
    unit: str(raw.unit),
  };
}

// ─── Formatting and scales ───────────────────────────────────────────────────

function trim(v: number, places = 1): string {
  return String(Number(v.toFixed(places)));
}

export function formatValue(v: number, unit?: string): string {
  const abs = Math.abs(v);
  let out: string;
  if (abs >= 1e9) out = `${trim(v / 1e9)}B`;
  else if (abs >= 1e6) out = `${trim(v / 1e6)}M`;
  else if (abs >= 1e4) out = `${trim(v / 1e3)}k`;
  else if (Number.isInteger(v)) out = String(v);
  else if (abs >= 1) out = trim(v, 2);
  else out = trim(v, 4);
  return unit ? `${out}${unit}` : out;
}

/** Round `span / count` up to a 1/2/5 × 10ⁿ step, so ticks land on readable numbers. */
function niceStep(span: number, count: number): number {
  if (span <= 0) return 1;
  const rough = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

function niceScale(min: number, max: number, count = 5, zeroBased = false): Scale {
  let lo = zeroBased ? Math.min(0, min) : min;
  let hi = zeroBased ? Math.max(0, max) : max;
  if (lo === hi) {
    // A flat series still deserves an axis rather than a division by zero.
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.5 : 1;
    lo -= pad;
    hi += pad;
    if (zeroBased && min >= 0) lo = 0;
  }
  const step = niceStep(hi - lo, count);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  // Accumulate by multiplication rather than repeated addition: adding 0.1 five
  // times gives 0.5000000000000001, which then formats as a tick label.
  const steps = Math.round((hi - lo) / step);
  for (let i = 0; i <= steps; i += 1) ticks.push(Number((lo + i * step).toPrecision(12)));
  return { min: lo, max: hi, ticks };
}

/** Rough text width. Good enough to reserve gutters; no DOM measurement needed. */
function textWidth(s: string, size: number): number {
  return s.length * size * 0.58;
}

function clip(s: string, maxWidth: number, size: number): string {
  if (textWidth(s, size) <= maxWidth) return s;
  const chars = Math.max(1, Math.floor(maxWidth / (size * 0.58)) - 1);
  return `${s.slice(0, chars)}…`;
}

// ─── SVG primitives ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

interface TextOpts {
  anchor?: "start" | "middle" | "end";
  size?: number;
  fill?: string;
  weight?: number;
  transform?: string;
}

function text(x: number, y: number, s: string, o: TextOpts = {}): string {
  const attrs = [
    `x="${r(x)}"`,
    `y="${r(y)}"`,
    `font-size="${o.size ?? 11}"`,
    `fill="${o.fill ?? "currentColor"}"`,
    o.anchor ? `text-anchor="${o.anchor}"` : "",
    o.weight ? `font-weight="${o.weight}"` : "",
    o.transform ? `transform="${o.transform}"` : "",
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${esc(s)}</text>`;
}

function markerPath(shape: MarkerShape, cx: number, cy: number, size: number): string {
  const s = size;
  switch (shape) {
    case "square":
      return `<rect x="${r(cx - s)}" y="${r(cy - s)}" width="${r(s * 2)}" height="${r(s * 2)}"/>`;
    case "triangle":
      return `<path d="M${r(cx)} ${r(cy - s * 1.2)} L${r(cx + s * 1.1)} ${r(cy + s)} L${r(cx - s * 1.1)} ${r(cy + s)} Z"/>`;
    case "triangle-down":
      return `<path d="M${r(cx)} ${r(cy + s * 1.2)} L${r(cx + s * 1.1)} ${r(cy - s)} L${r(cx - s * 1.1)} ${r(cy - s)} Z"/>`;
    case "diamond":
      return `<path d="M${r(cx)} ${r(cy - s * 1.3)} L${r(cx + s * 1.3)} ${r(cy)} L${r(cx)} ${r(cy + s * 1.3)} L${r(cx - s * 1.3)} ${r(cy)} Z"/>`;
    case "cross": {
      const a = s * 0.45;
      const b = s * 1.3;
      return `<path d="M${r(cx - a)} ${r(cy - b)} h${r(a * 2)} v${r(b - a)} h${r(b - a)} v${r(a * 2)} h${r(-(b - a))} v${r(b - a)} h${r(-a * 2)} v${r(-(b - a))} h${r(-(b - a))} v${r(-a * 2)} h${r(b - a)} Z"/>`;
    }
    case "star": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const rad = i % 2 === 0 ? s * 1.4 : s * 0.6;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        pts.push(`${r(cx + Math.cos(a) * rad)} ${r(cy + Math.sin(a) * rad)}`);
      }
      return `<path d="M${pts.join(" L")} Z"/>`;
    }
    case "hexagon": {
      const pts: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        pts.push(`${r(cx + Math.cos(a) * s * 1.2)} ${r(cy + Math.sin(a) * s * 1.2)}`);
      }
      return `<path d="M${pts.join(" L")} Z"/>`;
    }
    default:
      return `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(s)}"/>`;
  }
}

/**
 * Fill textures for the shapes that have area — bars, stacked bands, pie
 * slices. Layered over the hue, so the chart still reads as coloured while
 * remaining separable in greyscale or with any colour vision. Index 0 is
 * deliberately plain: one texture on a single-series bar chart is noise.
 *
 * `ink` is the surface colour, not the series colour — hatching a bar in its
 * own hue is invisible, which is the whole point of the second channel. Drawing
 * in the colour *behind* the bar reads as the texture being cut out of it, and
 * works over any hue in either theme.
 */
function texturePattern(id: string, index: number, ink: string): string {
  const stroke = `stroke="${ink}" stroke-width="1.4" stroke-linecap="square" fill="none"`;
  const body = [
    "",
    `<path d="M-2 6 L6 -2 M0 8 L8 0 M2 10 L10 2" ${stroke}/>`,
    `<circle cx="2" cy="2" r="1.3" fill="${ink}"/><circle cx="6" cy="6" r="1.3" fill="${ink}"/>`,
    `<path d="M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6" ${stroke}/>`,
    `<path d="M0 2 H8 M0 6 H8" ${stroke}/>`,
    `<path d="M2 0 V8 M6 0 V8" ${stroke}/>`,
    `<path d="M0 0 L8 8 M8 0 L0 8" ${stroke}/>`,
    `<rect x="0" y="0" width="4" height="4" fill="${ink}"/><rect x="4" y="4" width="4" height="4" fill="${ink}"/>`,
  ][index % 8];
  if (!body) return "";
  return `<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse">${body}</pattern>`;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export interface ChartRenderOptions {
  width?: number;
  /** Plot height, before the legend is added below it. */
  height?: number;
  /** Draw the value above each bar. Auto (few enough bars to fit) when unset. */
  valueLabels?: boolean;
  /** Prefix for the SVG's internal ids, so two charts on a page cannot collide. */
  idPrefix?: string;
}

const TITLE_SIZE = 13;
const AXIS_SIZE = 10.5;
const LEGEND_SIZE = 11;

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Render chart data to a standalone SVG string. Self-contained: no external
 * stylesheet, no script, every colour resolved — which is what lets the same
 * function serve the chat, the PDF export and the Markdown export.
 */
export function renderChartSvg(
  data: ChartData,
  theme: ChartTheme = DARK_CHART_THEME,
  opts: ChartRenderOptions = {},
): string {
  const width = opts.width ?? 620;
  const prefix = opts.idPrefix ?? "mzc";
  const showLegend = data.series.length > 1 || data.type === "pie";
  const rows = showLegend ? legendRows(data, width) : 0;
  const legendHeight = rows > 0 ? rows * 18 + 8 : 0;
  const bodyHeight = opts.height ?? 300;
  const height = bodyHeight + legendHeight;

  // Pie textures key off the slice; every other type keys off the series.
  const textureCount = data.type === "pie" ? data.labels.length : data.series.length;
  const defs: string[] = [];
  for (let i = 0; i < textureCount; i += 1) {
    const pattern = texturePattern(`${prefix}-tex-${i}`, i, theme.panel);
    if (pattern) defs.push(pattern);
  }

  const top = data.title ? 26 : 10;
  const parts: string[] = [];

  if (data.title) {
    parts.push(
      text(width / 2, 17, data.title, {
        anchor: "middle",
        size: TITLE_SIZE,
        weight: 600,
        fill: theme.text,
      }),
    );
  }

  parts.push(
    data.type === "pie"
      ? renderPie(data, theme, width, top, bodyHeight, prefix)
      : renderCartesian(data, theme, width, top, bodyHeight, prefix, opts),
  );

  if (showLegend) parts.push(renderLegend(data, theme, width, bodyHeight, prefix));

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${r(height)}"`,
    ` width="${width}" height="${r(height)}" role="img" aria-label="${esc(describeChart(data))}"`,
    ` font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">`,
    defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "",
    parts.join(""),
    "</svg>",
  ].join("");
}

/** The chart in a sentence — the SVG's accessible name, and the export alt text. */
export function describeChart(data: ChartData): string {
  const kind = data.stacked ? `stacked ${data.type}` : data.type;
  const names = data.series.map((s) => s.name).join(", ");
  const head = data.title ? `${data.title}. ` : "";
  const n = data.labels.length;
  return `${head}${kind} chart of ${names} across ${n} ${n === 1 ? "category" : "categories"}.`;
}

// ─── Cartesian (bar / line / area / scatter) ─────────────────────────────────

function renderCartesian(
  data: ChartData,
  theme: ChartTheme,
  width: number,
  top: number,
  height: number,
  prefix: string,
  opts: ChartRenderOptions,
): string {
  const horizontal = data.type === "bar" && data.horizontal === true;
  const isScatter = data.type === "scatter";

  const { lo, hi } = valueExtent(data, isScatter);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return "";
  const zeroBased = data.type === "bar" || data.type === "area";
  const scale = niceScale(lo, hi, 5, zeroBased);

  const tickLabels = scale.ticks.map((t) => formatValue(t, data.unit));
  const gutter = Math.max(...tickLabels.map((t) => textWidth(t, AXIS_SIZE))) + 10;
  const catWidth = data.labels.length > 0 ? Math.max(...data.labels.map((l) => textWidth(l, AXIS_SIZE))) : 0;

  // Horizontal bars put categories down the left side, so the left gutter is
  // however wide the longest one is — capped, then ellipsized to fit.
  const left = horizontal
    ? Math.min(Math.max(catWidth + 18, 40), width * 0.36)
    : gutter + (data.yLabel ? 14 : 0);
  // Horizontal bars print their value past the tip of the bar, so the right
  // gutter has to hold a number rather than just a stroke width.
  const right = horizontal ? 44 : 14;
  const bottom = 26 + (data.xLabel ? 12 : 0);

  const plot: Plot = {
    x: left,
    y: top + 4,
    w: Math.max(20, width - left - right),
    h: Math.max(20, height - top - bottom),
  };

  const span = scale.max - scale.min;
  const vAt = (v: number) =>
    horizontal
      ? plot.x + ((v - scale.min) / span) * plot.w
      : plot.y + plot.h - ((v - scale.min) / span) * plot.h;

  const out: string[] = [];

  // Grid, and the value axis's own tick labels.
  scale.ticks.forEach((t, i) => {
    const p = vAt(t);
    const strong = t === 0 && scale.min < 0;
    const opacity = strong ? 0.9 : 0.5;
    const stroke = `stroke="${theme.border}" stroke-width="${strong ? 1.4 : 1}" opacity="${opacity}"`;
    if (horizontal) {
      out.push(
        `<line x1="${r(p)}" y1="${r(plot.y)}" x2="${r(p)}" y2="${r(plot.y + plot.h)}" ${stroke}/>`,
        text(p, plot.y + plot.h + 15, tickLabels[i], {
          anchor: "middle",
          size: AXIS_SIZE,
          fill: theme.muted,
        }),
      );
    } else {
      out.push(
        `<line x1="${r(plot.x)}" y1="${r(p)}" x2="${r(plot.x + plot.w)}" y2="${r(p)}" ${stroke}/>`,
        text(plot.x - 7, p + 3.5, tickLabels[i], {
          anchor: "end",
          size: AXIS_SIZE,
          fill: theme.muted,
        }),
      );
    }
  });

  const n = Math.max(1, data.labels.length);
  const band = horizontal ? plot.h / n : plot.w / n;

  // Category axis. Scatter draws a numeric x-axis of its own instead.
  if (!isScatter) {
    const stride = horizontal ? 1 : labelStride(data.labels, band);
    data.labels.forEach((label, i) => {
      if (i % stride !== 0) return;
      if (horizontal) {
        out.push(
          text(plot.x - 8, plot.y + band * (i + 0.5) + 3.5, clip(label, left - 12, AXIS_SIZE), {
            anchor: "end",
            size: AXIS_SIZE,
            fill: theme.muted,
          }),
        );
      } else {
        out.push(
          text(plot.x + band * (i + 0.5), plot.y + plot.h + 15, clip(label, band * stride - 2, AXIS_SIZE), {
            anchor: "middle",
            size: AXIS_SIZE,
            fill: theme.muted,
          }),
        );
      }
    });
  }

  if (data.xLabel) {
    out.push(
      text(plot.x + plot.w / 2, height - 2, data.xLabel, {
        anchor: "middle",
        size: AXIS_SIZE,
        fill: theme.muted,
      }),
    );
  }
  if (data.yLabel && !horizontal) {
    out.push(
      text(0, 0, data.yLabel, {
        anchor: "middle",
        size: AXIS_SIZE,
        fill: theme.muted,
        transform: `translate(11 ${r(plot.y + plot.h / 2)}) rotate(-90)`,
      }),
    );
  }

  if (data.type === "bar") {
    out.push(renderBars(data, theme, plot, band, vAt, scale, horizontal, prefix, opts));
  } else if (isScatter) {
    out.push(renderScatter(data, theme, plot, vAt));
  } else {
    out.push(renderLines(data, theme, plot, band, vAt, scale, prefix));
  }

  // Baseline last, so the marks do not paint over it.
  const zero = scale.min <= 0 && scale.max >= 0 ? vAt(0) : null;
  const axis = `stroke="${theme.muted}" stroke-width="1" opacity="0.7"`;
  out.push(
    horizontal
      ? `<line x1="${r(zero ?? plot.x)}" y1="${r(plot.y)}" x2="${r(zero ?? plot.x)}" y2="${r(plot.y + plot.h)}" ${axis}/>`
      : `<line x1="${r(plot.x)}" y1="${r(zero ?? plot.y + plot.h)}" x2="${r(plot.x + plot.w)}" y2="${r(zero ?? plot.y + plot.h)}" ${axis}/>`,
  );

  return out.join("");
}

function valueExtent(data: ChartData, isScatter: boolean): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  const see = (v: number) => {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  };

  if (isScatter) {
    for (const s of data.series) for (const p of seriesPoints(s, data.labels)) see(p.y);
  } else if (data.stacked) {
    for (let i = 0; i < data.labels.length; i += 1) {
      let pos = 0;
      let neg = 0;
      for (const s of data.series) {
        const v = s.values[i] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      see(pos);
      see(neg);
    }
  } else {
    for (const s of data.series) for (const v of s.values) if (v !== null) see(v);
  }
  return { lo, hi };
}

/** Show every nth category label, so a 40-bar chart does not print mush. */
function labelStride(labels: string[], band: number): number {
  if (labels.length === 0) return 1;
  // +6 for the gap between two labels: a stride that fits them exactly edge to
  // edge still ellipsizes every one of them.
  const longest = Math.max(...labels.map((l) => textWidth(l, AXIS_SIZE))) + 6;
  if (longest <= band) return 1;
  return Math.max(1, Math.ceil(longest / Math.max(1, band)));
}

function seriesPoints(s: ChartSeries, labels: string[]): ChartPoint[] {
  if (s.points && s.points.length > 0) return s.points;
  const out: ChartPoint[] = [];
  for (let i = 0; i < s.values.length; i += 1) {
    const y = s.values[i];
    if (y === null) continue;
    const parsed = Number(labels[i]);
    out.push({ x: Number.isFinite(parsed) ? parsed : i, y });
  }
  return out;
}

function renderBars(
  data: ChartData,
  theme: ChartTheme,
  plot: Plot,
  band: number,
  vAt: (v: number) => number,
  scale: Scale,
  horizontal: boolean,
  prefix: string,
  opts: ChartRenderOptions,
): string {
  const out: string[] = [];
  const groups = data.stacked ? 1 : data.series.length;
  const thickness = Math.max(1.5, (band * 0.76) / groups);
  const zero = vAt(Math.max(scale.min, Math.min(0, scale.max)));
  const totalBars = data.labels.length * groups;
  const withValues = opts.valueLabels ?? (totalBars <= 12 && !data.stacked);

  for (let i = 0; i < data.labels.length; i += 1) {
    const center = (horizontal ? plot.y : plot.x) + band * (i + 0.5);
    let posTop = 0;
    let negTop = 0;

    for (let sIdx = 0; sIdx < data.series.length; sIdx += 1) {
      const v = data.series[sIdx].values[i];
      if (v === null || v === undefined) continue;
      const color = seriesColor(theme, sIdx, data.series[sIdx].color);

      let from: number;
      let to: number;
      if (data.stacked) {
        const base = v >= 0 ? posTop : negTop;
        const tip = base + v;
        if (v >= 0) posTop = tip;
        else negTop = tip;
        from = vAt(base);
        to = vAt(tip);
      } else {
        from = zero;
        to = vAt(v);
      }

      const offset = data.stacked ? 0 : (sIdx - (groups - 1) / 2) * thickness;
      const near = Math.min(from, to);
      const size = Math.max(1, Math.abs(to - from));
      const box = horizontal
        ? { x: near, y: center + offset - thickness / 2, w: size, h: thickness }
        : { x: center + offset - thickness / 2, y: near, w: thickness, h: size };
      const geom = `x="${r(box.x)}" y="${r(box.y)}" width="${r(box.w)}" height="${r(box.h)}" rx="1.5"`;

      out.push(`<rect ${geom} fill="${color}"/>`);
      if (sIdx > 0) out.push(`<rect ${geom} fill="url(#${prefix}-tex-${sIdx})" opacity="0.55"/>`);

      if (withValues) {
        const label = formatValue(v, data.unit);
        out.push(
          horizontal
            ? text(to + (v >= 0 ? 5 : -5), box.y + thickness / 2 + 3.5, label, {
                anchor: v >= 0 ? "start" : "end",
                size: AXIS_SIZE,
                fill: theme.muted,
              })
            : text(box.x + thickness / 2, to + (v >= 0 ? -5 : 12), label, {
                anchor: "middle",
                size: AXIS_SIZE,
                fill: theme.muted,
              }),
        );
      }
    }
  }
  return out.join("");
}

interface LinePoint {
  x: number;
  y: number;
  base: number;
}

function renderLines(
  data: ChartData,
  theme: ChartTheme,
  plot: Plot,
  band: number,
  vAt: (v: number) => number,
  scale: Scale,
  prefix: string,
): string {
  const out: string[] = [];
  const count = data.labels.length;
  const xAt = (i: number) =>
    count <= 1 ? plot.x + plot.w / 2 : plot.x + band / 2 + (plot.w - band) * (i / (count - 1));
  const baseline = vAt(Math.max(scale.min, Math.min(0, scale.max)));
  const stackedArea = data.stacked === true && data.type === "area";

  // A stacked area rests each band on the running total of the ones below it.
  const running = new Array(count).fill(0);

  data.series.forEach((s, sIdx) => {
    const color = seriesColor(theme, sIdx, s.color);
    const dash = dashFor(sIdx);
    const runs: LinePoint[][] = [];
    let run: LinePoint[] = [];

    for (let i = 0; i < count; i += 1) {
      const v = s.values[i];
      if (v === null || v === undefined) {
        if (run.length > 0) runs.push(run);
        run = [];
        continue;
      }
      const base = stackedArea ? running[i] : 0;
      const tip = base + v;
      if (stackedArea) running[i] = tip;
      run.push({ x: xAt(i), y: vAt(tip), base: stackedArea ? vAt(base) : baseline });
    }
    if (run.length > 0) runs.push(run);

    for (const seg of runs) {
      const line = seg.map((p, k) => `${k === 0 ? "M" : "L"}${r(p.x)} ${r(p.y)}`).join(" ");
      if (data.type === "area") {
        const back = [...seg]
          .reverse()
          .map((p) => `L${r(p.x)} ${r(p.base)}`)
          .join(" ");
        out.push(`<path d="${line} ${back} Z" fill="${color}" opacity="${theme.mode === "dark" ? 0.3 : 0.22}"/>`);
        if (sIdx > 0) {
          out.push(`<path d="${line} ${back} Z" fill="url(#${prefix}-tex-${sIdx})" opacity="0.4"/>`);
        }
      }
      out.push(
        `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${
          dash ? ` stroke-dasharray="${dash}"` : ""
        }/>`,
      );
    }

    // Markers, thinned so a dense series does not become a solid band. A run of
    // one has no line to be seen as, so it always keeps its marker.
    const marks: string[] = [];
    for (const seg of runs) {
      if (seg.length === 1) marks.push(markerPath(markerFor(sIdx), seg[0].x, seg[0].y, 3.2));
    }
    const pts = runs.flat();
    const stride = Math.max(1, Math.ceil(pts.length / 24));
    pts.forEach((p, k) => {
      if (k % stride === 0) marks.push(markerPath(markerFor(sIdx), p.x, p.y, 3.2));
    });
    if (marks.length > 0) {
      out.push(`<g fill="${color}" stroke="${theme.panel}" stroke-width="1">${marks.join("")}</g>`);
    }
  });

  return out.join("");
}

function renderScatter(data: ChartData, theme: ChartTheme, plot: Plot, vAt: (v: number) => number): string {
  const all = data.series.map((s) => seriesPoints(s, data.labels));
  let xLo = Infinity;
  let xHi = -Infinity;
  for (const pts of all) {
    for (const p of pts) {
      xLo = Math.min(xLo, p.x);
      xHi = Math.max(xHi, p.x);
    }
  }
  if (!Number.isFinite(xLo)) return "";

  const xScale = niceScale(xLo, xHi, 5);
  const xAt = (v: number) => plot.x + ((v - xScale.min) / (xScale.max - xScale.min)) * plot.w;

  const out: string[] = [];
  for (const t of xScale.ticks) {
    out.push(
      `<line x1="${r(xAt(t))}" y1="${r(plot.y)}" x2="${r(xAt(t))}" y2="${r(plot.y + plot.h)}" stroke="${theme.border}" stroke-width="1" opacity="0.35"/>`,
      text(xAt(t), plot.y + plot.h + 15, formatValue(t), {
        anchor: "middle",
        size: AXIS_SIZE,
        fill: theme.muted,
      }),
    );
  }
  all.forEach((pts, sIdx) => {
    const color = seriesColor(theme, sIdx, data.series[sIdx].color);
    const marks = pts.map((p) => markerPath(markerFor(sIdx), xAt(p.x), vAt(p.y), 3.6)).join("");
    out.push(`<g fill="${color}" fill-opacity="0.85" stroke="${theme.panel}" stroke-width="0.8">${marks}</g>`);
  });
  return out.join("");
}

// ─── Pie ─────────────────────────────────────────────────────────────────────

function renderPie(
  data: ChartData,
  theme: ChartTheme,
  width: number,
  top: number,
  height: number,
  prefix: string,
): string {
  const values = data.series[0].values.map((v) => (v === null ? 0 : Math.max(0, v)));
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return text(width / 2, top + 40, "No positive values to chart", {
      anchor: "middle",
      fill: theme.muted,
    });
  }

  const cx = width / 2;
  const cy = top + (height - top) / 2;
  const radius = Math.max(20, Math.min((height - top) / 2 - 14, width / 2 - 90));
  const out: string[] = [];

  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    if (v <= 0) return;
    const sweep = (v / total) * Math.PI * 2;
    const end = angle + sweep;
    const color = seriesColor(theme, i);
    // A slice covering the whole circle has no two arc endpoints to draw between.
    const d =
      sweep >= Math.PI * 2 - 1e-6
        ? `M${r(cx)} ${r(cy - radius)} A${r(radius)} ${r(radius)} 0 1 1 ${r(cx - 0.01)} ${r(cy - radius)} Z`
        : [
            `M${r(cx)} ${r(cy)}`,
            `L${r(cx + Math.cos(angle) * radius)} ${r(cy + Math.sin(angle) * radius)}`,
            `A${r(radius)} ${r(radius)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${r(cx + Math.cos(end) * radius)} ${r(cy + Math.sin(end) * radius)}`,
            "Z",
          ].join(" ");
    out.push(`<path d="${d}" fill="${color}" stroke="${theme.panel}" stroke-width="1.5"/>`);
    if (i > 0) out.push(`<path d="${d}" fill="url(#${prefix}-tex-${i})" opacity="0.55" stroke="none"/>`);

    // The share, printed inside the slice — but only where it fits.
    const pct = (v / total) * 100;
    if (pct >= 6) {
      const mid = angle + sweep / 2;
      out.push(
        text(cx + Math.cos(mid) * radius * 0.64, cy + Math.sin(mid) * radius * 0.64 + 4, `${trim(pct)}%`, {
          anchor: "middle",
          size: AXIS_SIZE,
          weight: 600,
          fill: theme.mode === "dark" ? "#0b0d10" : "#ffffff",
        }),
      );
    }
    angle = end;
  });

  return out.join("");
}

// ─── Legend ──────────────────────────────────────────────────────────────────

interface LegendItem {
  name: string;
  color: string;
  index: number;
}

function legendItems(data: ChartData, theme: ChartTheme): LegendItem[] {
  if (data.type === "pie") {
    const values = data.series[0].values;
    return data.labels.map((name, i) => ({
      name: `${name} — ${formatValue(values[i] ?? 0, data.unit)}`,
      color: seriesColor(theme, i),
      index: i,
    }));
  }
  return data.series.map((s, i) => ({
    name: s.name,
    color: seriesColor(theme, i, s.color),
    index: i,
  }));
}

function legendRows(data: ChartData, width: number): number {
  let x = 12;
  let rows = 1;
  for (const item of legendItems(data, DARK_CHART_THEME)) {
    const w = textWidth(item.name, LEGEND_SIZE) + 32;
    if (x + w > width - 4 && x > 12) {
      rows += 1;
      x = 12;
    }
    x += w;
  }
  return rows;
}

function renderLegend(data: ChartData, theme: ChartTheme, width: number, y: number, prefix: string): string {
  const out: string[] = [];
  let x = 12;
  let row = 0;
  for (const item of legendItems(data, theme)) {
    const w = textWidth(item.name, LEGEND_SIZE) + 32;
    if (x + w > width - 4 && x > 12) {
      row += 1;
      x = 12;
    }
    const cy = y + 12 + row * 18;
    if (data.type === "line" || data.type === "area") {
      const dash = dashFor(item.index);
      out.push(
        `<line x1="${r(x)}" y1="${r(cy)}" x2="${r(x + 18)}" y2="${r(cy)}" stroke="${item.color}" stroke-width="2"${
          dash ? ` stroke-dasharray="${dash}"` : ""
        }/>`,
        `<g fill="${item.color}">${markerPath(markerFor(item.index), x + 9, cy, 3.2)}</g>`,
      );
    } else if (data.type === "scatter") {
      out.push(`<g fill="${item.color}">${markerPath(markerFor(item.index), x + 9, cy, 4)}</g>`);
    } else {
      const geom = `x="${r(x)}" y="${r(cy - 5.5)}" width="18" height="11" rx="2"`;
      out.push(`<rect ${geom} fill="${item.color}"/>`);
      if (item.index > 0) {
        out.push(`<rect ${geom} fill="url(#${prefix}-tex-${item.index})" opacity="0.55"/>`);
      }
    }
    out.push(text(x + 24, cy + 4, item.name, { size: LEGEND_SIZE, fill: theme.muted }));
    x += w;
  }
  return out.join("");
}
