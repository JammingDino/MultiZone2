import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MermaidBlock } from "./MermaidBlock";
import { MathPlotBlock } from "./MathPlotBlock";
import { ChartBlock } from "./ChartBlock";
import { toChartData, type ChartData } from "@/lib/chart";
import { CHROME_QUIET } from "@/lib/chrome";

interface Props {
  language: string;
  code: string;
}

/** Watches for dark/light class changes on <html> and returns true when in light mode. */
export function useIsLightMode() {
  const [light, setLight] = useState(() =>
    document.documentElement.classList.contains("light"),
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setLight(document.documentElement.classList.contains("light"));
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);
  return light;
}

export function CodeBlock({ language, code }: Props) {
  if (language === "mermaid") return <MermaidBlock source={code} />;
  if (language === "mathplot") return <MathPlotBlock spec={code} />;
  // A ```chart fence holding the same JSON `render_chart` takes. Models that
  // reach for a fence rather than the tool — and answers replayed from a
  // provider that dropped the tool call — still get a chart. Anything that is
  // not chartable falls through to being shown as the JSON it is.
  if (language === "chart") {
    const data = parseChartFence(code);
    if (data) return <ChartBlock data={data} />;
  }
  return <RawCode language={language} code={code} />;
}

function RawCode({ language, code }: Props) {
  const [copied, setCopied] = useState(false);
  const isLight = useIsLightMode();

  async function onCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const theme = isLight ? oneLight : oneDark;

  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] text-sm">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
        <span>{language || "code"}</span>
        <button
          onClick={onCopy}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${CHROME_QUIET}`}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={theme}
        customStyle={{
          margin: 0,
          background: "transparent",
          padding: "0.75rem",
          fontSize: "13px",
        }}
        codeTagProps={{
          style: { background: "transparent", fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace" },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

/** A ```chart fence's body, if it is JSON describing a chart. */
function parseChartFence(code: string): ChartData | null {
  try {
    return toChartData(JSON.parse(code));
  } catch {
    return null;
  }
}
