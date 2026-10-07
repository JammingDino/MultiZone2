import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
// Registers `\ce{…}` and `\pu{…}` on the KaTeX instance rehype-katex uses —
// chemistry is half of what a study project is about for some people.
import "katex/contrib/mhchem";
import { rehypeReveal, type RevealUnit } from "@/lib/streamReveal";
import type { Components } from "react-markdown";
import { CodeBlock } from "./CodeBlock";
import { MarkdownTable } from "./DataTable";
import type { Citation } from "@/lib/citations";
import { citationPlugin } from "@/lib/remarkCitations";
import { normalizeMath } from "@/lib/normalizeMath";
import { openPath, revealPath } from "@/lib/tauri";
import { reportError } from "@/lib/reportError";

/** http(s) links can't navigate inside the Tauri webview — route them through
 *  the OS default browser. Other hrefs (in-page anchors) fall through to default. */
function isExternal(href: unknown): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}

// Defined at module level so the reference is stable across renders.
// An inline object literal here would cause ReactMarkdown to unmount/remount
// all code blocks (including MermaidBlock) on every parent re-render.
const MD_COMPONENTS: Components = {
  code(props) {
    const { children, className, ...rest } = props as any;
    const match = /language-(\w+)/.exec(className || "");
    if (!match) {
      return <code {...rest}>{children}</code>;
    }
    return (
      <CodeBlock
        language={match[1]}
        code={String(children).replace(/\n$/, "")}
      />
    );
  },
  a(props) {
    const { href } = props as { href?: string };
    return (
      <a
        {...props}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (isExternal(href)) {
            e.preventDefault();
            openPath(href).catch(reportError("Couldn't open it"));
          }
        }}
      />
    );
  },
  // Sortable, filterable, copyable, and one click from being a chart (0.16.x).
  // Falls back to the plain table for anything that is not the shape GFM
  // produces.
  table: MarkdownTable,
};

/**
 * The same set with an inert table, for markdown that is chrome rather than
 * conversation (`plainTables`).
 *
 * A table in an answer is data the model produced and the reader may want to
 * reorder or chart. A table in release notes is prose in columns: there is
 * nothing to sort it by, "chart this" has nothing to chart, and "ask about
 * this" would offer to paste the changelog into the composer. The toolbar is
 * not merely useless there, it is a set of wrong suggestions.
 *
 * Also module-level, for the same remount reason as `MD_COMPONENTS`.
 */
const MD_COMPONENTS_PLAIN_TABLES: Components = {
  ...MD_COMPONENTS,
  table(props) {
    return (
      <div className="my-2 overflow-x-auto">
        <table {...props} />
      </div>
    );
  },
};

const REMARK_PLUGINS = [remarkGfm, remarkMath];

/**
 * Shorthands models reach for that KaTeX does not define — the blackboard
 * sets, physics-style derivatives, siunitx-style units. Without them the whole
 * equation renders as a red error over one unknown command.
 */
const KATEX_MACROS: Record<string, string> = {
  "\\R": "\\mathbb{R}",
  "\\N": "\\mathbb{N}",
  "\\Z": "\\mathbb{Z}",
  "\\Q": "\\mathbb{Q}",
  "\\C": "\\mathbb{C}",
  "\\E": "\\mathbb{E}",
  "\\abs": "\\left\\lvert #1 \\right\\rvert",
  "\\norm": "\\left\\lVert #1 \\right\\rVert",
  "\\set": "\\left\\{ #1 \\right\\}",
  "\\dd": "\\mathrm{d}",
  "\\dv": "\\frac{\\mathrm{d} #1}{\\mathrm{d} #2}",
  "\\pdv": "\\frac{\\partial #1}{\\partial #2}",
  "\\Var": "\\operatorname{Var}",
  "\\Cov": "\\operatorname{Cov}",
  "\\argmax": "\\operatorname*{arg\\,max}",
  "\\argmin": "\\operatorname*{arg\\,min}",
  "\\sgn": "\\operatorname{sgn}",
  "\\tr": "\\operatorname{tr}",
  "\\rank": "\\operatorname{rank}",
  "\\degree": "^{\\circ}",
  "\\celsius": "{}^{\\circ}\\mathrm{C}",
  "\\ohm": "\\Omega",
  "\\unit": "\\,\\mathrm{#1}",
  "\\si": "\\mathrm{#1}",
  "\\SI": "#1\\,\\mathrm{#2}",
  "\\num": "#1",
};

/**
 * KaTeX settings. Lenient: a model's LaTeX is close to LaTeX, not KaTeX, and
 * one unsupported command should cost that command, not the equation.
 * `macros` is a fresh object each time the processor is built — every render
 * — so a `\newcommand` reaches the rest of its message, and neither leaks into
 * other messages nor collides with itself when a streaming message re-renders.
 */
function rehypeKatexLenient(this: unknown) {
  return (rehypeKatex as (this: unknown, o: object) => unknown).call(this, {
    strict: "ignore",
    throwOnError: false,
    trust: false,
    macros: { ...KATEX_MACROS },
  });
}

/** `\newcommand{\R}` on a name defined above would be an error; make it a redefinition. */
const OURS = new RegExp(
  `\\\\newcommand(\\s*\\{?\\s*\\\\(?:${Object.keys(KATEX_MACROS).map((k) => k.slice(1)).join("|")})(?![a-zA-Z]))`,
  "g",
);
const ownMacros = (src: string) => (src.includes("\\newcommand") ? src.replace(OURS, "\\renewcommand$1") : src);

/** A streaming group's reveal animation — see lib/streamReveal.ts. */
export type Reveal = { unit: RevealUnit; animation: string; ms: number };

export function Markdown({
  source,
  citations,
  part,
  className = "",
  fontSize,
  plainTables = false,
  reveal,
}: {
  source: string;
  citations?: Citation[];
  /** One group of a document split across several renderers (StreamingMarkdown):
   *  the first/last-child margin reset belongs to the document, not the group. */
  part?: boolean;
  /** Extra classes on the wrapper — for markdown rendered outside the thread. */
  className?: string;
  /** Overrides the message font size. Markdown shown in a panel rather than in
   *  the conversation (release notes, say) is chrome, and should be sized like
   *  the chrome around it rather than tracking the reader's message size. */
  fontSize?: string;
  /** Render tables as plain tables — see `MD_COMPONENTS_PLAIN_TABLES`. Set for
   *  the same markdown that sets `fontSize`: chrome, not conversation. */
  plainTables?: boolean;
  /** Animate text as it appears: set only while this group is still streaming. */
  reveal?: Reveal;
}) {
  // Append the citation plugin only when there are citations to map, so ordinary
  // messages keep the stable module-level plugin array (no needless re-parse).
  const remarkPlugins = useMemo(
    () =>
      citations && citations.length > 0
        ? [...REMARK_PLUGINS, citationPlugin(citations)]
        : REMARK_PLUGINS,
    [citations],
  );

  // The reveal spans only while streaming; a finished answer is plain text.
  const unit = reveal?.unit;
  const rehypePlugins = useMemo(() => {
    return unit ? [rehypeKatexLenient, [rehypeReveal, { unit }] as const] : [rehypeKatexLenient];
  }, [unit]);

  // Normalize \[…\] / \(…\) and inline $$…$$ into the delimiter forms remark-math
  // renders correctly, so display equations become centered blocks instead of
  // being squeezed inline. Memoized so streaming re-renders don't repeat the work.
  const normalized = useMemo(() => normalizeMath(ownMacros(source)), [source]);

  // File citation markers carry `data-reveal-path` (see remarkCitations). They
  // are rendered deep inside remark's output, so the click is delegated from
  // the container rather than threaded through a component override.
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-reveal-path]");
    const path = el?.dataset.revealPath;
    if (!path) return;
    e.preventDefault();
    revealPath(path).catch(reportError("Couldn't show it in Explorer"));
  }

  return (
    <div
      className={`${part ? "markdown markdown-part" : "markdown"}${className ? ` ${className}` : ""}`}
      style={{
        fontSize: fontSize ?? "var(--font-size-message, 14px)",
        ...(reveal ? { ["--mz-tok-ms" as string]: `${reveal.ms}ms` } : {}),
      }}
      data-reveal={reveal?.animation}
      onClick={onClick}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins as never}
        components={plainTables ? MD_COMPONENTS_PLAIN_TABLES : MD_COMPONENTS}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
