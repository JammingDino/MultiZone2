import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import { CodeBlock } from "./CodeBlock";

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
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
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

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown" style={{ fontSize: "var(--font-size-message, 14px)" }}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MD_COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
