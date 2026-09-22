import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Code2, ExternalLink, Eye, FolderOpen, Loader2, RefreshCw, Save, X } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { formatBytes } from "@/lib/format";
import { Markdown } from "@/components/Renderers/Markdown";
import type { FileText as FileTextData } from "@/lib/types";
import { iconFor } from "./FilesPanel";

/**
 * One file, in the workspace panel (0.17.9).
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
  // An image has a preview and nothing else: its "source" is bytes, and the
  // editor would offer to save a textarea full of them back over the file.
  const previewable = kind !== "text" && kind !== "image";
  const [mode, setMode] = useState<"preview" | "source">(kind === "text" ? "source" : "preview");
  // A different file starts over: its own default view, its own draft.
  useEffect(() => {
    setMode(kindOf(path) === "text" ? "source" : "preview");
    setSavedAt(null);
    setSaveError(null);
  }, [path]);

  const load = useCallback(() => {
    setError(null);
    if (kindOf(path) === "image") return;
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
    <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1">
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
        {kind !== "image" && (
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

      <div className="h-[48vh] min-h-[160px] resize-y overflow-hidden bg-[var(--color-panel)]">
        {/* An image first, ahead of both the loader and the read error: the
            frame fetches its own bytes from the scheme, so it needs neither.
            `read_workspace_file` caps at 4 MB because it is building a
            *string*; a 6 MB screenshot displays perfectly well and used to be
            refused by a limit that had nothing to do with it. */}
        {kind === "image" ? (
          <ImagePreview path={path} name={name} savedAt={savedAt} />
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
          <Editor value={draft} onChange={setDraft} onSave={save} />
        )}
      </div>
    </div>
  );
}

type Kind = "html" | "markdown" | "svg" | "image" | "text";

function kindOf(path: string): Kind {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ext === "svg") return "svg";
  if (IMAGE.has(ext)) return "image";
  return "text";
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
        className="h-full w-full border-0 bg-white"
      />
    );
  }
  if (kind === "svg") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-[var(--color-bg)] p-3">
        <img src={svgSrc} alt={name} className="max-h-full max-w-full" />
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto px-3 py-2 text-[13px]">
      <Markdown source={content} />
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
    <div className="relative h-full overflow-auto bg-[var(--color-bg)]">
      {/* The checker under a transparent PNG, so its transparency is visible
          as transparency rather than as whatever the panel is painted. */}
      <div
        className={`flex min-h-full min-w-full items-center justify-center p-3 ${actual ? "w-max" : ""}`}
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
          className={actual ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain"}
        />
      </div>
      {size && (
        <span className="pointer-events-none sticky bottom-1 left-1 ml-1 inline-block rounded bg-[var(--color-bg)]/85 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
          {size.w}×{size.h}
          {actual ? " · 1:1" : " · fit"}
        </span>
      )}
    </div>
  );
}

/**
 * A textarea with a line-number gutter kept in step by mirroring its scroll.
 * Tab inserts two spaces rather than leaving the field, and Ctrl/Cmd+S saves —
 * the two habits that make a plain textarea feel like it is not one.
 */
function Editor({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave: () => void }) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n").length, [value]);
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);

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

  return (
    <div className="flex h-full font-mono text-[11.5px] leading-[1.5]">
      <div
        ref={gutterRef}
        aria-hidden
        className="select-none overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-right text-[var(--color-text-muted)]"
      >
        <pre className="m-0 font-[inherit] text-[inherit]">{numbers}</pre>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        className="h-full min-w-0 flex-1 resize-none overflow-auto bg-transparent px-2 py-2 text-[var(--color-text)] outline-none"
      />
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
