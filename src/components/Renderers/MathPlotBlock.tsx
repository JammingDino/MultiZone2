import { useEffect, useRef, useState } from "react";
import functionPlot from "function-plot";

function useIsLightMode() {
  const [light, setLight] = useState(() =>
    document.documentElement.classList.contains("light"),
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setLight(document.documentElement.classList.contains("light"));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return light;
}

export interface MathPlotData {
  title?: string;
  xRange: [number, number];
  yRange: [number, number];
  xLabel?: string;
  yLabel?: string;
  functions: { fn: string; color?: string }[];
}

interface SpecProps {
  /** Legacy text spec used by ```mathplot fenced code blocks. */
  spec: string;
}

interface DataProps {
  data: MathPlotData;
}

export function MathPlotBlock(props: SpecProps | DataProps) {
  const parsed: MathPlotData | { error: string } =
    "data" in props ? props.data : parseSpec(props.spec);
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const isError = "error" in parsed;
  const data = isError ? null : parsed;
  const isLight = useIsLightMode();

  useEffect(() => {
    if (!ref.current || !data) return;
    setError(null);
    ref.current.innerHTML = "";
    try {
      functionPlot({
        target: ref.current,
        width: ref.current.clientWidth || 560,
        height: 260,
        grid: true,
        title: data.title,
        xAxis: { domain: data.xRange, label: data.xLabel },
        yAxis: { domain: data.yRange, label: data.yLabel },
        data: data.functions.map((f) => ({ fn: f.fn, color: f.color })),
      });
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, [JSON.stringify(data), isLight]);

  if (isError || error) {
    const msg = isError ? parsed.error : error;
    return (
      <div className="my-2 rounded border border-[var(--color-danger)] bg-[var(--color-panel)] p-3 text-xs">
        <div className="mb-1 text-[var(--color-danger)]">MathPlot error:</div>
        <pre className="whitespace-pre-wrap">{msg}</pre>
      </div>
    );
  }

  return (
    <div className="math-plot-wrapper my-2 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2">
      <div ref={ref} />
    </div>
  );
}

/** Normalize a `plot_function` tool call's arguments (or its echoed result) into
 *  plot props. Returns null when the required ranges/functions are missing. */
export function toMathPlotData(raw: any): MathPlotData | null {
  if (!raw || typeof raw !== "object") return null;
  const xRange = raw.x_range ?? raw.xRange;
  const yRange = raw.y_range ?? raw.yRange;
  const fns = raw.functions;
  if (!Array.isArray(xRange) || xRange.length !== 2) return null;
  if (!Array.isArray(yRange) || yRange.length !== 2) return null;
  if (!Array.isArray(fns) || fns.length === 0) return null;
  return {
    title: raw.title,
    xRange: [Number(xRange[0]), Number(xRange[1])],
    yRange: [Number(yRange[0]), Number(yRange[1])],
    xLabel: raw.x_label ?? raw.xLabel,
    yLabel: raw.y_label ?? raw.yLabel,
    functions: fns
      .map((f: any) =>
        typeof f === "string"
          ? { fn: f }
          : f && typeof f === "object" && typeof f.fn === "string"
            ? { fn: f.fn, color: f.color }
            : null,
      )
      .filter((f: any) => f !== null) as { fn: string; color?: string }[],
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
    functionPlot({
      target: host,
      width: 600,
      height: 260,
      grid: true,
      title: data.title,
      xAxis: { domain: data.xRange, label: data.xLabel },
      yAxis: { domain: data.yRange, label: data.yLabel },
      data: data.functions.map((f) => ({ fn: f.fn, color: f.color })),
    });
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
  const out: Partial<MathPlotData> & { functions: { fn: string; color?: string }[] } = {
    functions: [],
  };
  let inFunctions = false;
  let current: { fn?: string; color?: string } | null = null;

  function pushCurrent() {
    if (current && current.fn) {
      out.functions.push({ fn: current.fn, color: current.color });
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
