import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Chat, ContentPart, Message } from "@/lib/types";

/**
 * Chat export (0.7.1). Two formats off the same resolved snapshot:
 *  - Markdown: a single `.md` file with YAML frontmatter + timestamped message
 *    blocks (downloaded via a Blob, matching the Skills export pattern).
 *  - PDF: a theme-aware print document rendered into a hidden iframe and sent to
 *    the OS print dialog ("Save as PDF"), so it visually matches the running app
 *    (accent, background, font, message-bubble layout). Page numbers come from
 *    the print dialog's own header/footer.
 */

export interface ExportZoneInfo {
  name: string;
  accentColor: string | null;
}

export interface ExportChatData {
  chat: Chat;
  messages: Message[];
  /** Primary zone for the chat (header metadata). */
  zoneName: string | null;
  zoneModel: string | null;
  projectName: string | null;
  tagNames: string[];
  /** zoneId → display info, for labelling each assistant turn. */
  zonesById: Record<string, ExportZoneInfo>;
}

export interface ExportTheme {
  mode: "dark" | "light";
  accent: string;
  fontFamily: string;
}

interface RenderedMessage {
  role: "user" | "assistant";
  /** Zone label for assistant turns (primary or perspective); null otherwise. */
  zoneLabel: string | null;
  accent: string | null;
  text: string;
  imageCount: number;
  timestamp: number;
}

/** Pull the visible text out of a message's JSON content parts. Hidden parts
 *  (context-injection artifacts) are intentionally excluded from exports. */
function visibleText(m: Message): string {
  try {
    const parts = JSON.parse(m.content) as ContentPart[];
    return parts
      .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n")
      .trim();
  } catch {
    return "";
  }
}

function imageCount(m: Message): number {
  try {
    const parts = JSON.parse(m.content) as ContentPart[];
    return parts.filter((p) => p.type === "image_url").length;
  } catch {
    return 0;
  }
}

/** Reduce the raw message list to the user/assistant turns worth exporting,
 *  resolving a zone label for each assistant turn. Tool/system messages and
 *  empty turns (e.g. a pure tool-call step) are dropped. */
function renderMessages(data: ExportChatData): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  for (const m of data.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = visibleText(m);
    const images = imageCount(m);
    if (!text && images === 0) continue;

    let zoneLabel: string | null = null;
    let accent: string | null = null;
    if (m.role === "assistant") {
      const zid = m.zoneId ?? m.activeZoneId;
      const z = zid ? data.zonesById[zid] : undefined;
      zoneLabel = z?.name ?? data.zoneName ?? "Assistant";
      accent = z?.accentColor ?? null;
    }
    out.push({ role: m.role, zoneLabel, accent, text, imageCount: images, timestamp: m.createdAt });
  }
  return out;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

function fmtIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Filesystem-safe slug from the chat title. */
function slugify(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "chat"
  );
}

// ─── Markdown ───────────────────────────────────────────────────────────────

/** Build the full Markdown document (frontmatter + message blocks). */
export function buildChatMarkdown(data: ExportChatData): string {
  const { chat } = data;
  const fm: string[] = ["---"];
  const yaml = (k: string, v: string) => `${k}: ${v}`;
  // Quote values that could confuse a YAML parser.
  const q = (v: string) => (/[:#\[\]{}&*!|>'"%@`]/.test(v) ? JSON.stringify(v) : v);
  fm.push(yaml("title", q(chat.title || "Untitled chat")));
  fm.push(yaml("chat_id", chat.id));
  if (data.zoneName) fm.push(yaml("zone", q(data.zoneName)));
  if (data.zoneModel) fm.push(yaml("model", q(data.zoneModel)));
  if (data.projectName) fm.push(yaml("project", q(data.projectName)));
  if (data.tagNames.length) fm.push(yaml("tags", `[${data.tagNames.map(q).join(", ")}]`));
  fm.push(yaml("created", fmtIso(chat.createdAt)));
  fm.push(yaml("updated", fmtIso(chat.updatedAt)));
  fm.push(yaml("exported", fmtIso(Date.now())));
  fm.push("---", "");

  const body: string[] = [`# ${chat.title || "Untitled chat"}`, ""];
  for (const m of renderMessages(data)) {
    const who = m.role === "user" ? "User" : (m.zoneLabel ?? "Assistant");
    body.push(`## ${who} · ${fmtDate(m.timestamp)}`, "");
    if (m.text) body.push(m.text, "");
    if (m.imageCount > 0) {
      body.push(`_${m.imageCount} image${m.imageCount === 1 ? "" : "s"} attached_`, "");
    }
  }

  return fm.join("\n") + body.join("\n").trimEnd() + "\n";
}

/** Download the chat as a `.md` file via a Blob (no extra fs permissions). */
export function exportChatMarkdown(data: ExportChatData): void {
  const md = buildChatMarkdown(data);
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slugify(data.chat.title)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ─── PDF (themed print document) ─────────────────────────────────────────────

const PALETTE = {
  dark: { bg: "#0b0d10", panel: "#14171c", border: "#2d333d", text: "#e4e6eb", muted: "#8b929e", code: "#1b1f25" },
  light: { bg: "#fafafa", panel: "#ffffff", border: "#d8dde4", text: "#1f2329", muted: "#5b6573", code: "#f0f2f5" },
};

/** Fixed layout width (px) for the print document; the page height is sized to
 *  the full content so the PDF is one continuous page with no breaks. */
const PAGE_WIDTH = 820;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a message's markdown body to HTML so formatting survives export
 *  (headings, bold/italic, lists, code, blockquotes, tables, links). Uses the
 *  same markdown stack as the app (`react-markdown` + GFM); raw HTML in the
 *  source is not rendered, so the output is safe to inline. */
function renderMarkdown(text: string): string {
  try {
    return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text));
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}

/** Build the standalone themed HTML document used for PDF printing. Laid out as
 *  one continuous column; the caller sizes the page to the rendered height. */
export function buildChatPrintHtml(data: ExportChatData, theme: ExportTheme): string {
  const p = PALETTE[theme.mode];
  const accent = theme.accent || "#4f9cf9";
  const family = theme.fontFamily?.trim() ? `"${theme.fontFamily.trim()}", ` : "";
  const fontStack = `${family}-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const meta: string[] = [];
  if (data.zoneName) meta.push(escapeHtml(data.zoneName));
  if (data.projectName) meta.push(escapeHtml(data.projectName));
  meta.push(`Exported ${escapeHtml(new Date().toLocaleString())}`);

  const bubbles = renderMessages(data)
    .map((m) => {
      const isUser = m.role === "user";
      const bubbleAccent = isUser ? accent : (m.accent ?? accent);
      const who = isUser ? "User" : escapeHtml(m.zoneLabel ?? "Assistant");
      const body = m.text ? `<div class="text">${renderMarkdown(m.text)}</div>` : "";
      const img =
        m.imageCount > 0
          ? `<div class="imgnote">${m.imageCount} image${m.imageCount === 1 ? "" : "s"} attached</div>`
          : "";
      return `
        <div class="row ${isUser ? "user" : "assistant"}">
          <div class="bubble">
            <div class="meta"><span class="who" style="color:${bubbleAccent}">${who}</span>
              <span class="time">${escapeHtml(fmtDate(m.timestamp))}</span></div>
            ${body}
            ${img}
          </div>
        </div>`;
    })
    .join("");

  // The header sits inline at the top of the single continuous page (not a
  // repeating fixed band — that overlapped the first message). The page is sized
  // to content height in exportChatPdf, so there are no page breaks.
  return `<!doctype html>
<html class="${theme.mode}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(data.chat.title || "Chat export")}</title>
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: ${p.bg}; color: ${p.text}; font-family: ${fontStack}; }
  body { font-size: 12px; line-height: 1.55; width: ${PAGE_WIDTH}px; padding: 26px 30px 34px; }
  .pageheader {
    display: flex; align-items: center; gap: 10px;
    border-bottom: 1px solid ${p.border}; padding-bottom: 12px; margin-bottom: 20px;
  }
  .pageheader .accent { width: 4px; height: 26px; border-radius: 2px; background: ${accent}; }
  .pageheader .htitle { font-weight: 600; font-size: 15px; color: ${p.text}; }
  .pageheader .hmeta { margin-left: auto; text-align: right; font-size: 10px; color: ${p.muted}; }
  .row { display: flex; margin: 0 0 14px; }
  .row.user { justify-content: flex-end; }
  .bubble {
    max-width: 86%; border: 1px solid ${p.border}; border-radius: 10px;
    padding: 9px 13px; background: ${p.panel};
  }
  .row.user .bubble { border-color: ${accent}55; background: ${accent}14; }
  .meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
  .who { font-weight: 600; font-size: 11px; }
  .time { font-size: 9.5px; color: ${p.muted}; }
  .text { word-wrap: break-word; overflow-wrap: anywhere; }
  /* Rendered-markdown element styling inside a bubble. */
  .text > :first-child { margin-top: 0; }
  .text > :last-child { margin-bottom: 0; }
  .text p { margin: 0 0 8px; }
  .text h1, .text h2, .text h3, .text h4 { margin: 12px 0 6px; line-height: 1.25; }
  .text h1 { font-size: 18px; } .text h2 { font-size: 16px; } .text h3 { font-size: 14px; } .text h4 { font-size: 12.5px; }
  .text ul, .text ol { margin: 0 0 8px; padding-left: 22px; }
  .text li { margin: 2px 0; }
  .text a { color: ${accent}; text-decoration: underline; }
  .text code { font-family: "JetBrains Mono", "Fira Code", Consolas, monospace; font-size: 11px;
    background: ${p.code}; border: 1px solid ${p.border}; border-radius: 4px; padding: 1px 4px; }
  .text pre { background: ${p.code}; border: 1px solid ${p.border}; border-radius: 6px;
    padding: 10px 12px; overflow-x: auto; margin: 0 0 8px; }
  .text pre code { background: none; border: 0; padding: 0; white-space: pre-wrap; word-break: break-word; }
  .text blockquote { margin: 0 0 8px; padding: 2px 0 2px 12px; border-left: 3px solid ${p.border}; color: ${p.muted}; }
  .text table { border-collapse: collapse; margin: 0 0 8px; font-size: 11px; }
  .text th, .text td { border: 1px solid ${p.border}; padding: 4px 8px; text-align: left; }
  .text hr { border: 0; border-top: 1px solid ${p.border}; margin: 12px 0; }
  .text img { max-width: 100%; }
  .imgnote { margin-top: 6px; font-size: 10px; font-style: italic; color: ${p.muted}; }
</style>
</head>
<body>
  <div class="pageheader">
    <span class="accent"></span>
    <span class="htitle">${escapeHtml(data.chat.title || "Untitled chat")}</span>
    <span class="hmeta">${meta.join(" · ")}</span>
  </div>
  ${bubbles}
</body>
</html>`;
}

/** Render the themed document into a hidden iframe, size the page to the full
 *  content height (so the PDF is one continuous page with no breaks), then open
 *  the print dialog. */
export function exportChatPdf(data: ExportChatData, theme: ExportTheme): void {
  const html = buildChatPrintHtml(data, theme);
  const iframe = document.createElement("iframe");
  // Off-screen but laid out at the real page width so height measures correctly.
  iframe.style.position = "fixed";
  iframe.style.left = "-10000px";
  iframe.style.top = "0";
  iframe.style.width = `${PAGE_WIDTH}px`;
  iframe.style.height = "1000px";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const cleanup = () => window.setTimeout(() => iframe.remove(), 1000);
  iframe.onload = () => {
    const win = iframe.contentWindow;
    const doc = win?.document;
    if (!win || !doc) { cleanup(); return; }
    // Size the single page to the full rendered height → no pagination.
    const height = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
    const style = doc.createElement("style");
    style.textContent = `@page { size: ${PAGE_WIDTH}px ${height + 2}px; margin: 0; }`;
    doc.head.appendChild(style);
    win.focus();
    win.print();
    win.onafterprint = cleanup;
    window.setTimeout(cleanup, 60_000); // safety net if onafterprint never fires
  };

  const doc = iframe.contentWindow?.document;
  if (doc) {
    doc.open();
    doc.write(html);
    doc.close();
  } else {
    iframe.remove();
  }
}
