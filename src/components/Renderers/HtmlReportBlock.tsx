import { useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, Loader2, AlertCircle } from "lucide-react";
import * as api from "@/lib/tauri";

/** Shape of the `present_file` tool result the backend renders. */
export interface SavedOutput {
  path: string;
  filename?: string;
  format?: string;
}

/** Directory portion of an absolute path (handles \ and /). */
function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(0, idx) : "";
}

/** True for an href we should hand straight to the OS opener (URL or absolute). */
function isAbsoluteTarget(href: string): boolean {
  return (
    /^[a-z]+:\/\//i.test(href) || // http://, https://, file://, …
    /^(mailto|tel):/i.test(href) ||
    href.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(href) // Windows drive path
  );
}

/** Resolve a link href clicked inside the report into something `open_path`
 * can handle: URLs and absolute paths pass through; relative paths resolve
 * against the report file's own directory. In-page anchors return null. */
function resolveHref(href: string, baseDir: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) {
    return null;
  }
  if (isAbsoluteTarget(trimmed)) {
    return trimmed.replace(/^file:\/\//i, "");
  }
  if (!baseDir) return trimmed;
  const sep = baseDir.includes("\\") ? "\\" : "/";
  return `${baseDir}${sep}${trimmed.replace(/^[\\/]+/, "")}`;
}

/**
 * Inline preview of an HTML report surfaced via `present_file`. Loads the file
 * content, renders it in a sandboxed (scripts-disabled) same-origin iframe so we
 * can intercept link clicks and route them through the OS opener, and offers an
 * "open in browser" button for the full file.
 */
export function HtmlReportBlock({ output }: { output: SavedOutput }) {
  const { path } = output;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(240);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    api
      .readOutputFile(path)
      .then((content) => {
        if (!cancelled) setHtml(content);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // After the iframe renders, size it to its content and wire link clicks to
  // the OS opener (the report has no scripts of its own — sandbox blocks them).
  function onIframeLoad() {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const h = doc.body?.scrollHeight ?? 240;
    setHeight(Math.min(Math.max(h + 8, 120), 600));
    const baseDir = dirOf(path);
    doc.querySelectorAll("a[href]").forEach((a) => {
      a.addEventListener("click", (e) => {
        const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
        const target = resolveHref(href, baseDir);
        if (!target) return; // in-page anchor — let it be
        e.preventDefault();
        api.openPath(target).catch((err) => console.error("open_path failed", err));
      });
    });
  }

  return (
    <div className="my-1 overflow-hidden rounded border border-[var(--color-border)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5 text-xs">
        <div className="flex min-w-0 items-center gap-1.5 text-[var(--color-text-muted)]">
          <FileText size={12} className="text-[var(--color-accent)]" />
          <span className="truncate text-[var(--color-text)]">
            {output.filename || path}
          </span>
        </div>
        <button
          onClick={() => api.openPath(path).catch((e) => console.error(e))}
          className="flex flex-shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          title="Open in browser"
        >
          <ExternalLink size={11} /> Open in browser
        </button>
      </div>
      {error ? (
        <div className="flex items-center gap-2 bg-[var(--color-panel)] p-3 text-xs text-[var(--color-danger)]">
          <AlertCircle size={12} /> Couldn't load preview: {error}
        </div>
      ) : html === null ? (
        <div className="flex items-center gap-2 bg-[var(--color-panel)] p-3 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
          Loading preview…
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          title={output.filename || "HTML report"}
          srcDoc={html}
          onLoad={onIframeLoad}
          sandbox="allow-same-origin allow-popups"
          className="w-full bg-white"
          style={{ height }}
        />
      )}
    </div>
  );
}
