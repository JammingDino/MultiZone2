import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Code2, ExternalLink, Eye, FileText as FileTextIcon, FolderOpen, Loader2, Minus, Plus, RefreshCw, Save, X } from "lucide-react";
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
 * The zoom ladder, in place of a percentage that can be any number. Every stop
 * is a size somebody would choose, and stepping through a list means the
 * buttons and the wheel can never disagree about what comes next.
 */
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function stepZoom(current: number, direction: 1 | -1): number {
  const i = ZOOMS.findIndex((z) => z >= current - 0.001);
  const next = (i < 0 ? ZOOMS.length - 1 : i) + direction;
  return ZOOMS[Math.min(Math.max(next, 0), ZOOMS.length - 1)];
}

/**
 * Ctrl+wheel zooms the pane, the way it does in a browser and every viewer
 * anyone has used.
 *
 * It is a listener rather than React's `onWheel` because that one is passive:
 * `preventDefault` does nothing there, so the webview would zoom the whole app
 * underneath the pane doing its own zoom. React 19 runs the returned cleanup
 * when the ref detaches, which is what makes a ref callback the right place.
 */
function useCtrlWheelZoom(setZoom: React.Dispatch<React.SetStateAction<number>>) {
  return useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom((z) => stepZoom(z, e.deltaY < 0 ? 1 : -1));
      };
      node.addEventListener("wheel", onWheel, { passive: false });
      return () => node.removeEventListener("wheel", onWheel);
    },
    [setZoom],
  );
}

/** Minus, the percentage (click to reset), plus. */
function Zoom({ value, onChange }: { value: number; onChange: (z: number) => void }) {
  return (
    <div className="ml-1 flex shrink-0 items-center overflow-hidden rounded border border-[var(--color-border)]">
      <ModeButton active={false} onClick={() => onChange(stepZoom(value, -1))} title="Zoom out (Ctrl+wheel)">
        <Minus size={11} />
      </ModeButton>
      <button
        onClick={() => onChange(1)}
        title="Reset to 100%"
        className="w-10 px-1 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
      >
        {Math.round(value * 100)}%
      </button>
      <ModeButton active={false} onClick={() => onChange(stepZoom(value, 1))} title="Zoom in (Ctrl+wheel)">
        <Plus size={11} />
      </ModeButton>
    </div>
  );
}

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
  const [zoom, setZoom] = useState(1);
  // A file whose bytes were called binary, opened in the editor anyway on the
  // user's say-so. Read-only: the text is a lossy decode, and saving it back
  // would write that lossiness over the file.
  const [asText, setAsText] = useState(false);
  // A different file starts over: its own default view, its own zoom, its own draft.
  useEffect(() => {
    setMode(kindOf(path) === "text" ? "source" : "preview");
    setZoom(1);
    setAsText(false);
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

  const paneRef = useCtrlWheelZoom(setZoom);
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
        <Zoom value={zoom} onChange={setZoom} />
        {!viewOnly && !asText && (
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

      {/* Ctrl+wheel is wired once here rather than in each pane. */}
      <div ref={paneRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* An image first, ahead of both the loader and the read error: the
            frame fetches its own bytes from the scheme, so it needs neither.
            `read_workspace_file` caps at 4 MB because it is building a
            *string*; a 6 MB screenshot displays perfectly well and used to be
            refused by a limit that had nothing to do with it. */}
        {kind === "image" ? (
          <ImagePreview path={path} name={name} savedAt={savedAt} zoom={zoom} />
        ) : kind === "pdf" ? (
          <PdfPreview path={path} name={name} zoom={zoom} />
        ) : error ? (
          <Notice icon={<AlertCircle size={12} />} danger>
            {error}
          </Notice>
        ) : !file ? (
          <Notice icon={<Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />}>Loading…</Notice>
        ) : file.binary && !asText ? (
          // Not "cannot open": the bytes did not decode, which is a verdict
          // the user is allowed to overrule. An extension nobody here has
          // heard of is not evidence of anything, and the editor is the
          // default for everything precisely so a new one needs no release.
          <Notice icon={<AlertCircle size={12} />}>
            <span>
              {name} does not look like text — it did not decode as any encoding this reads.
            </span>
            <button
              onClick={() => setAsText(true)}
              className="mt-2 flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text)] hover:bg-[var(--color-panel-hover)]"
            >
              <FileTextIcon size={11} />
              Open as text anyway
            </button>
          </Notice>
        ) : mode === "preview" && !asText ? (
          <Preview kind={kind} content={draft} name={name} path={path} savedAt={savedAt} zoom={zoom} />
        ) : (
          <Editor
            value={draft}
            onChange={setDraft}
            onSave={save}
            path={path}
            zoom={zoom}
            readOnly={asText}
          />
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

function Preview({
  kind,
  content,
  name,
  path,
  savedAt,
  zoom,
}: {
  kind: Kind;
  content: string;
  name: string;
  path: string;
  savedAt: number | null;
  zoom: number;
}) {
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
        // CSS `zoom` rather than a transform: the page inside reflows to the
        // new size instead of being a scaled picture of the old one, and the
        // frame is cross-origin so its own styles are out of reach anyway.
        style={{ zoom }}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    );
  }
  if (kind === "svg") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img src={svgSrc} alt={name} style={{ zoom }} className="max-h-full max-w-full" />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3" style={{ fontSize: `${13 * zoom}px` }}>
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
function ImagePreview({
  path,
  name,
  savedAt,
  zoom,
}: {
  path: string;
  name: string;
  savedAt: number | null;
  zoom: number;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const url = useMemo(() => {
    const u = api.previewUrl(path);
    return u ? `${u}${u.includes("?") ? "&" : "?"}v=${savedAt ?? 0}` : null;
  }, [path, savedAt]);

  useEffect(() => {
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
        // Zoom scales the framed picture, so at 100% the image still fits the
        // pane and above it the pane scrolls — the same gesture as every other
        // pane here, rather than a bespoke fit/actual toggle.
        style={{
          zoom,
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
          // Never upscaled at 100%: an image too big for the pane shrinks to
          // fit, a small one is left at its own size.
          className="max-h-full max-w-full"
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

function PdfPreview({ path, name, zoom }: { path: string; name: string; zoom: number }) {
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
      {/* Zoom widens the column and each page re-renders into it, so a zoomed
          page is drawn at that size rather than being a stretched bitmap —
          which is the whole point of zooming into a document. */}
      <div
        className="mx-auto flex flex-col gap-4"
        style={{ width: `${zoom * 100}%`, maxWidth: zoom <= 1 ? "48rem" : "none" }}
      >
        {Array.from({ length: shown }, (_, i) => (
          <PdfPage key={i} doc={doc} n={i + 1} total={doc.numPages} zoom={zoom} />
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

function PdfPage({ doc, n, total, zoom }: { doc: PdfDoc; n: number; total: number; zoom: number }) {
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
    // `zoom` is not read here — the container's width is — but it is what
    // changed that width, so it is what has to trigger the redraw.
  }, [doc, n, zoom]);

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
 * Above this many characters the file is edited as plain text. Highlighting
 * re-tokenises the whole document on every keystroke, and somewhere past a few
 * hundred KB that turns typing into a slideshow.
 *
 * ponytail: one flat ceiling, no incremental tokeniser. If editing large files
 * here ever becomes a thing people do, the answer is a real editor component,
 * not a cleverer version of this.
 */
const HIGHLIGHT_LIMIT = 200_000;

/** Columns per indent level — the same two spaces Tab inserts. */
const INDENT = 2;

/**
 * The indent guides, as text.
 *
 * Every editor draws faint vertical lines down each level of indentation, and
 * the cheap way to get them is to notice that the columns they occupy are
 * blank by definition. So this builds one line per line of the file holding a
 * box-drawing character at each indent step and spaces elsewhere, and paints
 * it underneath in the same metrics. No per-line elements, no measuring of
 * character widths — a string, in a `<pre>`, that lands exactly where the
 * whitespace already is.
 *
 * A blank line gets the guides of the deeper of its neighbours, so a gap
 * inside a block does not cut the lines in half.
 */
function indentGuides(value: string): string {
  const lines = value.split("\n");
  const depth = lines.map((line) => {
    if (line.trim() === "") return -1;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    return Math.floor(lead.replace(/\t/g, " ".repeat(INDENT)).length / INDENT);
  });
  // Fill each blank line from its neighbours, so a run of them keeps the
  // guides that surround it rather than breaking them.
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] !== -1) continue;
    let before = 0;
    for (let j = i - 1; j >= 0; j--) if (depth[j] !== -1) { before = depth[j]; break; }
    let after = 0;
    for (let j = i + 1; j < depth.length; j++) if (depth[j] !== -1) { after = depth[j]; break; }
    depth[i] = Math.min(before, after);
  }
  return depth
    .map((d) => ("\u2502" + " ".repeat(INDENT - 1)).repeat(Math.max(d, 0)))
    .join("\n");
}

/** Prism's name for a file extension. An unknown one highlights as nothing. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  rs: "rust", py: "python", go: "go", java: "java", kt: "kotlin", swift: "swift", rb: "ruby",
  php: "php", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", lua: "lua", zig: "zig",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "batch", sql: "sql",
  css: "css", scss: "scss", less: "less", html: "markup", htm: "markup", xml: "markup",
  svg: "markup", vue: "markup", svelte: "markup", json: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", md: "markdown", mdx: "markdown", diff: "diff", patch: "diff",
  dockerfile: "docker", graphql: "graphql", proto: "protobuf", conf: "ini", cfg: "ini",
  env: "bash", gitignore: "bash", lock: "toml",
};

function languageOf(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  if (name.toLowerCase() === "dockerfile") return "docker";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return LANGUAGES[ext] ?? null;
}

/**
 * A textarea with a line-number gutter kept in step by mirroring its scroll,
 * indent guides behind it, and — since 0.18 — Prism's colours between them.
 *
 * Three layers, one set of metrics: guides at the back, highlighting over
 * them, and a textarea with transparent text on top. They stay in register by
 * sharing every property that can move a glyph (family, size, line height,
 * padding, tab size, no wrapping) and by mirroring the textarea's scroll onto
 * the two below it. The caret, the selection and every keystroke still belong
 * to the textarea, which is what keeps this a text box that happens to have
 * colour rather than an editor that has to reimplement one.
 */
function Editor({
  value,
  onChange,
  onSave,
  path,
  zoom,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  path: string;
  zoom: number;
  readOnly?: boolean;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const isLight = useIsLightMode();
  const lines = useMemo(() => value.split("\n").length, [value]);
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);
  const guides = useMemo(() => indentGuides(value), [value]);
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
      const { selectionStart: start, selectionEnd: end } = el;
      const next = `${value.slice(0, start)}${" ".repeat(INDENT)}${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + INDENT;
      });
    }
  }

  // Every property that decides where a glyph lands, in one object, applied to
  // the textarea and to both layers under it. They drift the moment they are
  // written down twice.
  const metrics: React.CSSProperties = {
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    padding: "8px",
    tabSize: INDENT,
    whiteSpace: "pre",
    wordBreak: "normal",
    overflowWrap: "normal",
    border: 0,
  };

  return (
    <div
      className="flex min-h-0 flex-1 font-mono leading-[1.55]"
      // Zoom is the font size here. It is the honest knob for text, and
      // because every layer inherits it they all scale together and stay
      // aligned — which CSS `zoom` on a textarea does not reliably manage.
      style={{ fontSize: `${12 * zoom}px` }}
    >
      <div
        ref={gutterRef}
        aria-hidden
        className="select-none overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-right text-[var(--color-text-muted)]"
      >
        <pre className="m-0 font-[inherit] text-[inherit]">{numbers}</pre>
      </div>
      <div className="relative min-w-0 flex-1">
        <div ref={guideRef} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <pre className="m-0 text-[var(--color-border)]" style={metrics}>
            {guides}
          </pre>
        </div>
        {highlight && (
          <div ref={layerRef} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <SyntaxHighlighter
              language={language}
              style={isLight ? oneLight : oneDark}
              customStyle={{ ...metrics, margin: 0, background: "transparent", overflow: "visible" }}
              codeTagProps={{ style: { ...metrics, padding: 0, background: "transparent" } }}
            >
              {/* A file ending in a newline loses its last (empty) line to the
                  tokeniser, which shifts nothing but does leave the layer one
                  line shorter than the textarea; a space keeps them equal. */}
              {value.endsWith("\n") ? `${value} ` : value}
            </SyntaxHighlighter>
          </div>
        )}
        <textarea
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            const { scrollTop, scrollLeft } = e.currentTarget;
            if (gutterRef.current) gutterRef.current.scrollTop = scrollTop;
            for (const layer of [guideRef.current, layerRef.current]) {
              if (!layer) continue;
              layer.scrollTop = scrollTop;
              layer.scrollLeft = scrollLeft;
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          style={{
            ...metrics,
            // The text is the highlighting layer's job; the caret and the
            // selection are still this element's, so both are given here.
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
    <div className={`flex items-start gap-2 p-3 text-[11px] ${danger ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}>
      <span className="mt-px shrink-0">{icon}</span>
      <div className="flex min-w-0 flex-col items-start">{children}</div>
    </div>
  );
}
