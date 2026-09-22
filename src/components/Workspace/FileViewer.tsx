import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Code2, ExternalLink, Eye, FolderOpen, Loader2, RefreshCw, Save, X } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { formatBytes } from "@/lib/format";
import { Markdown } from "@/components/Renderers/Markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useIsLightMode } from "@/components/Renderers/CodeBlock";
import { openPdf, drawPdfPage, type PdfDoc } from "@/lib/pdf";
import type { FileText as FileTextData } from "@/lib/types";
import { iconFor } from "./FilesPanel";

/**
 * One file, as a document tab in the main column (0.17.9, moved 0.18).
 *
 * Two ways of looking at a file, and the type picks the default: a **preview**
 * — an HTML page in a frame with its scripts running, Markdown rendered, an
 * SVG drawn — or the **source**, in an editor that is deliberately small: a
 * textarea with line numbers, Tab that indents, and Ctrl+S that saves. It is
 * for the nudge — a typo in a report, a value in a config — not for writing
 * software; that is what the terminal and the agent are for.
 *
 * The HTML frame loads the file from the app's `mzfile` URL scheme, so a page
 * that refers to files beside it — `chart.png`, `app.js` — finds them, the
 * way it would in a browser. That origin is the scheme's own, not the app's,
 * so the page's scripts run without reach into this window. A remote window
 * has no such scheme and gets the file's text as a `srcdoc` instead, which
 * runs scripts but cannot resolve relative references.
 */
export function FileViewer({ path }: { path: string }) {
  const close = useApp((s) => s.closeWorkspaceFile);
  const [file, setFile] = useState<FileTextData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const kind = kindOf(path);
  // An image or a PDF has a preview and nothing else: the "source" is bytes,
  // and the editor would offer to save a textarea full of them over the file.
  const viewOnly = kind === "image" || kind === "pdf";
  const previewable = kind !== "text" && !viewOnly;
  const [mode, setMode] = useState<"preview" | "source">(kind === "text" ? "source" : "preview");
  // A different file starts over: its own default view, its own draft.
  useEffect(() => {
    setMode(kindOf(path) === "text" ? "source" : "preview");
    setSavedAt(null);
    setSaveError(null);
  }, [path]);

  const load = useCallback(() => {
    setError(null);
    if (viewOnlyKind(path)) return;
    api.readWorkspaceFile(path)
      .then((f) => {
        setFile(f);
        setDraft(f.content);
      })
      .catch((e) => setError(String(e)));
  }, [path]);
  useEffect(() => {
    setFile(null);
    load();
  }, [load]);

  const dirty = file !== null && draft !== file.content;

  const save = useCallback(async () => {
    if (!file || !dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const f = await api.writeWorkspaceFile(path, draft);
      setFile(f);
      setDraft(f.content);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [file, dirty, saving, path, draft]);

  const { Icon, color } = iconFor(file?.name ?? path);
  const name = file?.name ?? path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-bg)]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-1.5">
        <Icon size={13} className="shrink-0" style={{ color }} />
        <span className="min-w-0 flex-1 truncate text-[var(--color-text)]" title={path}>
          {name}
          {dirty && <span className="ml-1 text-[var(--color-accent)]" title="Unsaved changes">●</span>}
        </span>
        {file && (
          <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{formatBytes(file.size)}</span>
        )}
        {previewable && (
          <div className="ml-1 flex shrink-0 overflow-hidden rounded border border-[var(--color-border)]">
            <ModeButton active={mode === "preview"} onClick={() => setMode("preview")} title="Preview">
              <Eye size={11} />
            </ModeButton>
            <ModeButton active={mode === "source"} onClick={() => setMode("source")} title="Source">
              <Code2 size={11} />
            </ModeButton>
          </div>
        )}
        {!viewOnly && (
          <Action title={dirty ? "Save (Ctrl+S)" : "Saved"} onClick={save} disabled={!dirty || saving} accent={dirty}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          </Action>
        )}
        <Action title="Re-read from disk" onClick={load}>
          <RefreshCw size={12} />
        </Action>
        <Action title="Open in the default app" onClick={() => api.openPath(path).catch(console.warn)}>
          <ExternalLink size={12} />
        </Action>
        <Action title="Show in the file manager" onClick={() => api.revealPath(path).catch(console.warn)}>
          <FolderOpen size={12} />
        </Action>
        <Action title="Close" onClick={close}>
          <X size={12} />
        </Action>
      </div>

      {(saveError || savedAt) && (
        <div
          className={`border-b border-[var(--color-border)] px-2 py-1 text-[10px] ${
            saveError ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"
          }`}
        >
          {saveError ? `Could not save: ${saveError}` : `Saved ${new Date(savedAt!).toLocaleTimeString()}`}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* An image first, ahead of both the loader and the read error: the
            frame fetches its own bytes from the scheme, so it needs neither.
            `read_workspace_file` caps at 4 MB because it is building a
            *string*; a 6 MB screenshot displays perfectly well and used to be
            refused by a limit that had nothing to do with it. */}
        {kind === "image" ? (
          <ImagePreview path={path} name={name} savedAt={savedAt} />
        ) : kind === "pdf" ? (
          <PdfPreview path={path} name={name} />
        ) : error ? (
          <Notice icon={<AlertCircle size={12} />} danger>
            {error}
          </Notice>
        ) : !file ? (
          <Notice icon={<Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />}>Loading…</Notice>
        ) : file.binary ? (
          <Notice icon={<AlertCircle size={12} />}>
            Not a text file. Open it in its own app with the arrow above.
          </Notice>
        ) : mode === "preview" ? (
          <Preview kind={kind} content={draft} name={name} path={path} savedAt={savedAt} />
        ) : (
          <Editor value={draft} onChange={setDraft} onSave={save} path={path} />
        )}
      </div>
    </div>
  );
}

type Kind = "html" | "markdown" | "svg" | "image" | "pdf" | "text";

function kindOf(path: string): Kind {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ext === "svg") return "svg";
  if (IMAGE.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "text";
}

/** Bytes, not text: nothing to read into a string and nothing to save back. */
function viewOnlyKind(path: string): boolean {
  const k = kindOf(path);
  return k === "image" || k === "pdf";
}

/** Raster formats the `mzfile` scheme already serves with a real media type. */
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);

function Preview({ kind, content, name, path, savedAt }: { kind: Kind; content: string; name: string; path: string; savedAt: number | null }) {
  const svgSrc = useMemo(
    () => (kind === "svg" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}` : ""),
    [kind, content],
  );
  // The served file, re-fetched after each save: the frame shows what is on
  // disk, which is what the report's own relative references see too.
  const url = useMemo(() => {
    const u = api.previewUrl(path);
    return u ? `${u}${u.includes("?") ? "&" : "?"}v=${savedAt ?? 0}` : null;
  }, [path, savedAt]);
  if (kind === "html") {
    return (
      <iframe
        title={name}
        {...(url ? { src: url } : { srcDoc: content })}
        // Scripts run — that is the point. From the scheme, the origin is the
        // scheme's own, so keeping it lets the page use its storage while
        // still having no reach into this window. A `srcdoc` would inherit
        // *this* origin, so there it stays opaque. Popups so links can open.
        sandbox={`allow-scripts allow-popups allow-forms allow-modals${url ? " allow-same-origin" : ""}`}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    );
  }
  if (kind === "svg") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img src={svgSrc} alt={name} className="max-h-full max-w-full" />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px]">
      <div className="mx-auto max-w-3xl"><Markdown source={content} /></div>
    </div>
  );
}

/**
 * An image, served by the `mzfile` scheme — which already answers with the
 * right media type, so the file needs no encoding pass to be looked at. Click
 * to toggle between fitting the frame and full size, because a screenshot that
 * fits is unreadable and one at full size needs scrolling; which of those is
 * wanted is not something the viewer can know.
 *
 * A remote window has no such scheme, so it says so rather than showing a
 * broken image.
 */
function ImagePreview({ path, name, savedAt }: { path: string; name: string; savedAt: number | null }) {
  const [actual, setActual] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const url = useMemo(() => {
    const u = api.previewUrl(path);
    return u ? `${u}${u.includes("?") ? "&" : "?"}v=${savedAt ?? 0}` : null;
  }, [path, savedAt]);

  useEffect(() => {
    setActual(false);
    setSize(null);
    setFailed(false);
  }, [path]);

  if (!url) {
    return (
      <Notice icon={<AlertCircle size={12} />}>
        Images open on the desktop app only. Use the arrow above to open this one in its own app.
      </Notice>
    );
  }
  if (failed) {
    return <Notice icon={<AlertCircle size={12} />} danger>Could not decode {name}.</Notice>;
  }

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      {/* The checkered frame is the size of the image, not the size of the
          pane. It is there to show a transparent PNG's transparency, and a
          checker stretched across the whole column showed nothing except how
          much emptiness surrounded a 200px GIF. `w-fit` on a flex-centred
          child is what keeps it to the picture. */}
      <div
        className="w-fit shrink-0"
        style={{
          backgroundImage:
            "repeating-conic-gradient(var(--color-panel) 0% 25%, var(--color-bg) 0% 50%)",
          backgroundSize: "16px 16px",
        }}
      >
        <img
          src={url}
          alt={name}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          onClick={() => setActual((v) => !v)}
          // Never upscaled: "fit" shrinks an image too big for the pane and
          // leaves a small one at its own size, which is what looking at a
          // file means. 1:1 is the escape hatch for a screenshot to read.
          className={actual ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in"}
        />
      </div>
      {size && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-[var(--color-bg)]/85 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
          {size.w}×{size.h}
        </span>
      )}
    </div>
  );
}

/**
 * A PDF, drawn page by page with the copy of pdf.js the app already carries
 * for the `read` tool (`lib/pdf.ts`). Viewing only: no form filling, no
 * annotation, no text layer — the toolbar's "open in the default app" is the
 * way to a real PDF reader, and this is the way to glance at one without
 * leaving the window.
 *
 * Pages render in order rather than on demand. A document in a project folder
 * is a report or a datasheet, not a book, and an IntersectionObserver per page
 * would be more machinery than the case deserves; past `MAX_PAGES` it stops
 * and says so instead of drawing a thousand canvases.
 */
const MAX_PAGES = 60;

function PdfPreview({ path, name }: { path: string; name: string }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = useMemo(() => api.previewUrl(path), [path]);

  useEffect(() => {
    if (!url) return;
    let live = true;
    let opened: PdfDoc | null = null;
    setDoc(null);
    setError(null);
    openPdf(url)
      .then((d) => {
        opened = d;
        // Arriving after the viewer moved on means this document belongs to a
        // file nobody is looking at: close it rather than leaking a worker.
        if (live) setDoc(d);
        else void d.destroy();
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
      void opened?.destroy();
    };
  }, [url]);

  if (!url) {
    return (
      <Notice icon={<AlertCircle size={12} />}>
        PDFs open on the desktop app only. Use the arrow above to open this one in its own app.
      </Notice>
    );
  }
  if (error) return <Notice icon={<AlertCircle size={12} />} danger>Could not open {name}: {error}</Notice>;
  if (!doc) {
    return (
      <Notice icon={<Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />}>
        Opening {name}…
      </Notice>
    );
  }

  const shown = Math.min(doc.numPages, MAX_PAGES);
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-[var(--color-panel)] px-4 py-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {Array.from({ length: shown }, (_, i) => (
          <PdfPage key={i} doc={doc} n={i + 1} total={doc.numPages} />
        ))}
        {shown < doc.numPages && (
          <p className="pb-2 text-center text-[11px] text-[var(--color-text-muted)]">
            Showing the first {MAX_PAGES} of {doc.numPages} pages. Open it in a PDF reader for the rest.
          </p>
        )}
      </div>
    </div>
  );
}

function PdfPage({ doc, n, total }: { doc: PdfDoc; n: number; total: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let live = true;
    // The canvas is laid out by CSS before anything is drawn, so its own width
    // is the width to render at — no measuring of ancestors, and correct
    // whatever the panel has been dragged to.
    const width = canvas.clientWidth || 700;
    drawPdfPage(doc, n, canvas, width).catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [doc, n]);

  return (
    <div className="relative">
      <canvas
        ref={ref}
        aria-label={`Page ${n} of ${total}`}
        className="block w-full rounded-sm bg-white shadow-md"
        style={{ aspectRatio: "1 / 1.414" }}
      />
      <span className="pointer-events-none absolute -top-0.5 right-1.5 translate-y-[-100%] font-mono text-[10px] text-[var(--color-text-muted)]">
        {n}/{total}
      </span>
      {failed && (
        <span className="absolute inset-0 flex items-center justify-center text-[11px] text-[var(--color-danger)]">
          Page {n} could not be drawn.
        </span>
      )}
    </div>
  );
}

/**
 * Prism's name for a file extension. Only the ones this app's own tree is full
 * of plus the usual suspects — an unknown extension highlights as nothing,
 * which is exactly what it used to do for everything.
 */
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  rs: "rust", py: "python", go: "go", java: "java", kt: "kotlin", swift: "swift", rb: "ruby",
  php: "php", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", lua: "lua", zig: "zig",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "batch", sql: "sql",
  css: "css", scss: "scss", less: "less", html: "markup", htm: "markup", xml: "markup",
  svg: "markup", vue: "markup", svelte: "markup", json: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", md: "markdown", mdx: "markdown", diff: "diff", patch: "diff",
  dockerfile: "docker", graphql: "graphql", proto: "protobuf",
};

function languageOf(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  if (name.toLowerCase() === "dockerfile") return "docker";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return LANGUAGES[ext] ?? null;
}

/**
 * Above this many characters the file is edited as plain text. Highlighting
 * re-tokenises the whole document on every keystroke, and somewhere past a few
 * hundred KB that turns typing into a slideshow.
 *
 * ponytail: one flat ceiling, no incremental tokeniser. If editing large files
 * here ever becomes a thing people do, the answer is a real editor component,
 * not a cleverer version of this.
 */
const HIGHLIGHT_LIMIT = 200_000;

/**
 * A textarea with a line-number gutter kept in step by mirroring its scroll,
 * and — since 0.18 — Prism's colours behind it.
 *
 * The highlighting is the standard overlay: a `<pre>` painted underneath and a
 * textarea with transparent text on top, the two kept in register by sharing
 * every metric that moves a glyph (family, size, line height, padding, tab
 * size, no wrapping) and by mirroring the textarea's scroll onto the layer
 * below. The caret, the selection and every keystroke still belong to the
 * textarea, which is what keeps this a text box that happens to have colour
 * rather than an editor that has to reimplement one.
 */
function Editor({
  value,
  onChange,
  onSave,
  path,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  path: string;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const isLight = useIsLightMode();
  const lines = useMemo(() => value.split("\n").length, [value]);
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);
  const language = languageOf(path);
  const highlight = language !== null && value.length <= HIGHLIGHT_LIMIT;

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = el;
      const next = `${value.slice(0, s)}  ${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = s + 2;
      });
    }
  }

  // Every metric that decides where a glyph lands, in one object, applied to
  // the textarea and to the layer under it. They drift the moment they are
  // written down twice.
  const metrics: React.CSSProperties = {
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    padding: "8px",
    tabSize: 2,
    whiteSpace: "pre",
    wordBreak: "normal",
    overflowWrap: "normal",
    border: 0,
  };

  return (
    <div className="flex min-h-0 flex-1 font-mono text-[12px] leading-[1.55]">
      <div
        ref={gutterRef}
        aria-hidden
        className="select-none overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-right text-[var(--color-text-muted)]"
      >
        <pre className="m-0 font-[inherit] text-[inherit]">{numbers}</pre>
      </div>
      <div className="relative min-w-0 flex-1">
        {highlight && (
          <div ref={layerRef} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <SyntaxHighlighter
              language={language}
              style={isLight ? oneLight : oneDark}
              customStyle={{ ...metrics, margin: 0, background: "transparent", overflow: "visible" }}
              codeTagProps={{ style: { ...metrics, padding: 0, background: "transparent" } }}
            >
              {/* A file ending in a newline loses its last (empty) line to the
                  tokeniser, which shifts nothing but does make the layer one
                  line shorter than the textarea; a space keeps them equal. */}
              {value.endsWith("\n") ? `${value} ` : value}
            </SyntaxHighlighter>
          </div>
        )}
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
            if (layerRef.current) {
              layerRef.current.scrollTop = e.currentTarget.scrollTop;
              layerRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          style={{
            ...metrics,
            // The text is the layer's job; the caret and the selection are
            // still this element's, so both are given explicitly.
            color: highlight ? "transparent" : "var(--color-text)",
            caretColor: "var(--color-text)",
          }}
          className="absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent outline-none selection:bg-[var(--color-accent)]/30"
        />
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`px-1.5 py-0.5 ${
        active ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
      }`}
    >
      {children}
    </button>
  );
}

function Action({
  title,
  onClick,
  disabled,
  accent,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`shrink-0 rounded p-0.5 hover:bg-[var(--color-panel-hover)] disabled:opacity-40 disabled:hover:bg-transparent ${
        accent ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function Notice({ icon, danger, children }: { icon: React.ReactNode; danger?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-2 p-3 text-[11px] ${danger ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}>
      {icon}
      <span>{children}</span>
    </div>
  );
}
