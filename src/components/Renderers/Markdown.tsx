import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import { CodeBlock } from "./CodeBlock";
import type { Citation } from "@/lib/citations";
import { citationPlugin } from "@/lib/remarkCitations";
import { normalizeMath } from "@/lib/normalizeMath";
import { openPath, revealPath } from "@/lib/tauri";

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
            openPath(href).catch((err) => console.error("openPath failed", err));
          }
        }}
      />
    );
  },
  table(props) {
    return (
      <div className="my-2 overflow-x-auto">
        <table {...props} />
      </div>
    );
  },
};

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

export function Markdown({
  source,
  citations,
  part,
  className = "",
  fontSize,
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

  // Normalize \[…\] / \(…\) and inline $$…$$ into the delimiter forms remark-math
  // renders correctly, so display equations become centered blocks instead of
  // being squeezed inline. Memoized so streaming re-renders don't repeat the work.
  const normalized = useMemo(() => normalizeMath(source), [source]);

  // File citation markers carry `data-reveal-path` (see remarkCitations). They
  // are rendered deep inside remark's output, so the click is delegated from
  // the container rather than threaded through a component override.
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-reveal-path]");
    const path = el?.dataset.revealPath;
    if (!path) return;
    e.preventDefault();
    revealPath(path).catch((err) => console.error("revealPath failed", err));
  }

  return (
    <div
      className={`${part ? "markdown markdown-part" : "markdown"}${className ? ` ${className}` : ""}`}
      style={{ fontSize: fontSize ?? "var(--font-size-message, 14px)" }}
      onClick={onClick}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={REHYPE_PLUGINS}
        components={MD_COMPONENTS}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
