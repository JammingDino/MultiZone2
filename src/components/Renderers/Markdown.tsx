import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import { CodeBlock } from "./CodeBlock";
import type { Citation } from "@/lib/citations";
import { citationPlugin } from "@/lib/remarkCitations";
import { openPath } from "@/lib/tauri";

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

export function Markdown({ source, citations }: { source: string; citations?: Citation[] }) {
  // Append the citation plugin only when there are citations to map, so ordinary
  // messages keep the stable module-level plugin array (no needless re-parse).
  const remarkPlugins = useMemo(
    () =>
      citations && citations.length > 0
        ? [...REMARK_PLUGINS, citationPlugin(citations)]
        : REMARK_PLUGINS,
    [citations],
  );

  return (
    <div className="markdown" style={{ fontSize: "var(--font-size-message, 14px)" }}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={REHYPE_PLUGINS}
        components={MD_COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
