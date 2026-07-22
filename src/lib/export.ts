import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  Folder,
  GitBranch,
  Globe,
  Image as ImageIcon,
  LineChart,
  ListChecks,
  Pencil,
  Search,
  Sparkles,
  TerminalSquare,
  User,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { Chat, ContentPart, Message } from "@/lib/types";
import { saveTextFile } from "@/lib/saveFile";
import {
  buildTrace,
  describeTool,
  formatDuration,
  traceStats,
  type ToolIcon,
  type TraceStats,
  type TraceThinkingItem,
  type TraceToolItem,
  type TraceUnit,
} from "@/lib/exportTrace";
import { toPlanData } from "@/components/Renderers/PlanBlock";
import { renderMermaidSvg } from "@/components/Renderers/MermaidBlock";
import { renderPlotSvg, toMathPlotData } from "@/components/Renderers/MathPlotBlock";

/**
 * Chat export (0.7.1). Two formats off the same resolved snapshot:
 *  - Markdown: a single `.md` file with YAML frontmatter + timestamped message
 *    blocks (downloaded via a Blob, matching the Skills export pattern).
 *  - PDF: a theme-aware print document rendered into a hidden iframe and sent to
 *    the OS print dialog ("Save as PDF"), so it visually matches the running app
 *    (accent, background, font, message-bubble layout). Page numbers come from
 *    the print dialog's own header/footer.
 *
 * 0.9.8 — the PDF traces the whole run, not just the prose. Every tool call gets
 * a timestamped card with a plain-language summary of what it did and what came
 * back; reasoning blocks are marked (timestamp and size, never content); and
 * plans, diagrams, plots and presented files are drawn as themselves, so a
 * reader skimming the document can see what actually happened.
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

/** Clock time only — used on step rows, where the date is already on the turn. */
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
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

/** Save the chat as a `.md` file, letting the user pick the destination. */
export async function exportChatMarkdown(data: ExportChatData): Promise<void> {
  await saveTextFile(`${slugify(data.chat.title)}.md`, buildChatMarkdown(data), [
    { name: "Markdown", extensions: ["md"] },
  ]);
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

// ─── Icons ───────────────────────────────────────────────────────────────────

/** The app's own icon set, rendered to inline SVG so the print document carries
 *  no external assets and still looks like MultiZone. */
const ICONS: Record<ToolIcon | "user" | "assistant" | "ok" | "error" | "image", LucideIcon> = {
  tool: Wrench,
  file: FileText,
  folder: Folder,
  edit: Pencil,
  search: Search,
  globe: Globe,
  terminal: TerminalSquare,
  checklist: ListChecks,
  diagram: GitBranch,
  chart: LineChart,
  brain: Brain,
  users: Users,
  database: Database,
  clock: Clock,
  user: User,
  assistant: Sparkles,
  ok: CheckCircle2,
  error: AlertCircle,
  image: ImageIcon,
};

function icon(key: keyof typeof ICONS, size = 12): string {
  try {
    return renderToStaticMarkup(
      createElement(ICONS[key], { size, strokeWidth: 2, "aria-hidden": true } as any),
    );
  } catch {
    return "";
  }
}

// ─── Rich per-tool visuals ───────────────────────────────────────────────────

/**
 * Diagrams and plots have to be rasterized before the document is assembled, so
 * they're rendered up front and looked up by tool-call id while building the
 * HTML. Everything else renders synchronously from the trace.
 */
type VisualCache = Map<string, string>;

/** Cache key for a pre-rendered visual. Falls back to the timestamp because a
 *  tool call streamed mid-turn may not have an id yet. */
function visualKey(item: TraceToolItem): string {
  return item.call.id || `${item.timestamp}:${item.call.function.name}`;
}

async function renderVisuals(units: TraceUnit[]): Promise<VisualCache> {
  const cache: VisualCache = new Map();
  const jobs: Promise<void>[] = [];

  for (const unit of units) {
    for (const item of unit.items) {
      if (item.kind !== "tool" || item.status === "error") continue;
      const name = item.call.function.name;
      const body = item.result && typeof item.result === "object" ? (item.result as any) : null;
      const key = visualKey(item);

      if (name === "draw_diagram") {
        const source =
          (typeof item.args?.source === "string" && item.args.source) ||
          (body && typeof body.source === "string" && body.source) ||
          "";
        if (!source) continue;
        jobs.push(
          renderMermaidSvg(source).then((svg) => {
            if (svg) cache.set(key, svg);
          }),
        );
      } else if (name === "plot_function") {
        const plot = toMathPlotData(item.args ?? body);
        if (!plot) continue;
        const svg = renderPlotSvg(plot);
        if (svg) cache.set(key, svg);
      }
    }
  }

  await Promise.all(jobs);
  return cache;
}

/** The checklist a `update_plan` call produced, drawn as a checklist. */
function renderPlanVisual(body: any, accent: string, p: Palette): string {
  const plan = toPlanData(body);
  if (!plan) return "";
  const pct = plan.total > 0 ? Math.round((plan.done / plan.total) * 100) : 0;
  const rows = plan.steps
    .map((s) => {
      const mark =
        s.status === "done" ? "✓" : s.status === "skipped" ? "–" : s.status === "in_progress" ? "▸" : "○";
      return `<li class="pl-${s.status}"><span class="plmark">${mark}</span><span>${escapeHtml(
        s.step,
      )}</span></li>`;
    })
    .join("");
  return `
    <div class="plan">
      <div class="planbar">
        <span class="planpct">${plan.done} of ${plan.total} complete</span>
        <span class="plantrack"><span class="planfill" style="width:${pct}%;background:${accent}"></span></span>
      </div>
      <ul class="plansteps" style="border-color:${p.border}">${rows}</ul>
    </div>`;
}

/** The card for a file the assistant put in front of the user. */
function renderFileVisual(body: any, accent: string): string {
  const filename = typeof body?.filename === "string" ? body.filename : null;
  const path = typeof body?.path === "string" ? body.path : null;
  if (!filename && !path) return "";
  const format = typeof body?.format === "string" && body.format ? body.format : null;
  const name = filename ?? path!.split(/[\\/]/).pop() ?? path!;
  return `
    <div class="filecard" style="border-color:${accent}55">
      <span class="fileico" style="color:${accent}">${icon("file", 20)}</span>
      <span class="filetext">
        <span class="filename">${escapeHtml(name)}</span>
        ${path ? `<span class="filepath">${escapeHtml(path)}</span>` : ""}
      </span>
      ${format ? `<span class="fmt" style="border-color:${accent}55;color:${accent}">${escapeHtml(format.toUpperCase())}</span>` : ""}
    </div>`;
}

/** Search hits, as a numbered list of what was actually found. */
function renderSearchVisual(body: any, accent: string): string {
  const results = Array.isArray(body?.results) ? body.results.slice(0, 8) : [];
  if (results.length === 0) return "";
  const rows = results
    .map((r: any, i: number) => {
      const title = typeof r?.title === "string" && r.title.trim() ? r.title : `Result ${i + 1}`;
      const url = typeof r?.url === "string" ? r.url : typeof r?.path === "string" ? r.path : null;
      return `<li>
        <span class="hitn" style="color:${accent}">${i + 1}</span>
        <span class="hittext">
          <span class="hittitle">${escapeHtml(title)}</span>
          ${url ? `<span class="hiturl">${escapeHtml(url)}</span>` : ""}
        </span>
      </li>`;
    })
    .join("");
  const more = Array.isArray(body?.results) && body.results.length > 8
    ? `<li class="hitmore">+ ${body.results.length - 8} more</li>`
    : "";
  return `<ul class="hits">${rows}${more}</ul>`;
}

const PREVIEW_LINES = 8;
const PREVIEW_CHARS = 600;

/** A tightly clipped look at whatever a tool actually returned, for the tools
 *  with no visual of their own. Enough to see the shape of the output without
 *  turning the export into a JSON dump. */
function renderPreview(item: TraceToolItem): string {
  const body = item.result && typeof item.result === "object" ? (item.result as any) : null;
  let text: string | null = null;
  if (body) {
    for (const key of ["stdout", "output", "content", "markdown", "text", "summary"]) {
      if (typeof body[key] === "string" && body[key].trim()) {
        text = body[key];
        break;
      }
    }
  } else if (item.resultText) {
    text = item.resultText;
  }
  if (!text) return "";

  const lines = text.split("\n");
  let clipped = lines.slice(0, PREVIEW_LINES).join("\n");
  let elided = lines.length > PREVIEW_LINES;
  if (clipped.length > PREVIEW_CHARS) {
    clipped = clipped.slice(0, PREVIEW_CHARS);
    elided = true;
  }
  return `<pre class="preview">${escapeHtml(clipped)}${elided ? "\n…" : ""}</pre>`;
}

function renderErrorVisual(item: TraceToolItem): string {
  const body = item.result && typeof item.result === "object" ? (item.result as any) : null;
  const message =
    (body && typeof body.error === "string" && body.error) || item.resultText || "The tool failed.";
  const hint = body && typeof body.hint === "string" ? body.hint : null;
  return `<div class="terr">${escapeHtml(message)}${
    hint ? `<span class="thint">${escapeHtml(hint)}</span>` : ""
  }</div>`;
}

const SEARCH_TOOLS = new Set(["web_search", "smart_search", "search_local_files", "smart_crawl"]);
const NO_PREVIEW = new Set([
  "update_plan",
  "draw_diagram",
  "plot_function",
  "present_file",
  ...SEARCH_TOOLS,
]);

function renderToolCard(
  item: TraceToolItem,
  visuals: VisualCache,
  accent: string,
  p: Palette,
): string {
  const desc = describeTool(item);
  const name = item.call.function.name;
  const body = item.result && typeof item.result === "object" ? (item.result as any) : null;
  const key = visualKey(item);

  let visual = "";
  if (item.status === "error") {
    visual = renderErrorVisual(item);
  } else if (name === "update_plan") {
    visual = renderPlanVisual(body, accent, p);
  } else if (name === "present_file") {
    visual = renderFileVisual(body, accent);
  } else if (name === "draw_diagram" || name === "plot_function") {
    const svg = visuals.get(key);
    const caption = typeof body?.caption === "string" ? body.caption : null;
    visual = svg
      ? `<div class="${name === "draw_diagram" ? "diagram" : "plot"}">${svg}</div>${
          caption ? `<div class="caption">${escapeHtml(caption)}</div>` : ""
        }`
      : renderPreview(item);
  } else if (SEARCH_TOOLS.has(name)) {
    visual = renderSearchVisual(body, accent);
  }
  if (!visual && !NO_PREVIEW.has(name)) visual = renderPreview(item);

  const statusClass =
    item.status === "error" ? "s-error" : item.status === "no-result" ? "s-idle" : "s-ok";
  const timing = [
    item.durationMs !== null ? formatDuration(item.durationMs) : null,
    fmtTime(item.timestamp),
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <div class="tool ${statusClass}">
      <div class="thead">
        <span class="tico">${icon(desc.icon)}</span>
        <span class="tlabel">${escapeHtml(desc.label)}</span>
        ${desc.subject ? `<span class="tsubject">${escapeHtml(desc.subject)}</span>` : ""}
        <span class="tmeta">${escapeHtml(timing)}</span>
      </div>
      <div class="tfoot">
        <code class="tfn">${escapeHtml(name)}</code>
        ${
          // On a failure the message is spelled out in the error panel just
          // below, so repeating it here would only add noise.
          desc.outcome && item.status !== "error"
            ? `<span class="toutcome">${escapeHtml(desc.outcome)}</span>`
            : ""
        }
        ${item.status === "error" ? `<span class="tfailed">failed</span>` : ""}
        ${item.status === "no-result" ? `<span class="toutcome">no result recorded</span>` : ""}
      </div>
      ${visual}
    </div>`;
}

// ─── Document assembly ───────────────────────────────────────────────────────

type Palette = (typeof PALETTE)["dark"];

function renderThinking(item: TraceThinkingItem): string {
  return `
    <div class="think">
      <span class="thinkico">${icon("brain")}</span>
      <span>Reasoned privately — ${item.characters.toLocaleString()} characters, not shown</span>
      <span class="tmeta">${escapeHtml(fmtTime(item.timestamp))}</span>
    </div>`;
}

function renderUnit(
  unit: TraceUnit,
  data: ExportChatData,
  visuals: VisualCache,
  theme: { accent: string; p: Palette },
): string {
  const { accent, p } = theme;
  if (unit.role === "user") {
    const inner = unit.items
      .map((item) =>
        item.kind === "text"
          ? `<div class="text">${renderMarkdown(item.text)}</div>`
          : item.kind === "images"
            ? `<div class="imgnote">${icon("image", 11)} ${item.count} image${
                item.count === 1 ? "" : "s"
              } attached</div>`
            : "",
      )
      .join("");
    return `
      <div class="turn user">
        <div class="bubble">
          <div class="who"><span class="whoico">${icon("user", 11)}</span>You
            <span class="tmeta">${escapeHtml(fmtTime(unit.timestamp))}</span></div>
          ${inner}
        </div>
      </div>`;
  }

  const zone = unit.zoneId ? data.zonesById[unit.zoneId] : undefined;
  const zoneAccent = zone?.accentColor ?? accent;
  const label = zone?.name ?? data.zoneName ?? "Assistant";
  const items = unit.items
    .map((item) => {
      if (item.kind === "text") return `<div class="text say">${renderMarkdown(item.text)}</div>`;
      if (item.kind === "thinking") return renderThinking(item);
      if (item.kind === "tool") return renderToolCard(item, visuals, zoneAccent, p);
      return "";
    })
    .join("");

  return `
    <div class="turn assistant">
      <div class="who" style="color:${zoneAccent}">
        <span class="whoico">${icon("assistant", 11)}</span>${escapeHtml(label)}
        <span class="tmeta">${escapeHtml(fmtDate(unit.timestamp))}</span>
      </div>
      <div class="steps" style="border-color:${zoneAccent}33">${items}</div>
    </div>`;
}

/** The numbers strip under the header: what happened, before you read any of it. */
function renderOverview(stats: TraceStats, accent: string): string {
  const elapsed =
    stats.firstAt !== null && stats.lastAt !== null && stats.lastAt > stats.firstAt
      ? formatDuration(stats.lastAt - stats.firstAt)
      : null;

  const cells: [string, string][] = [
    [String(stats.userTurns), stats.userTurns === 1 ? "message sent" : "messages sent"],
    [String(stats.assistantTurns), stats.assistantTurns === 1 ? "response" : "responses"],
  ];
  if (stats.toolCalls > 0) {
    cells.push([
      String(stats.toolCalls),
      stats.failedToolCalls > 0
        ? `tool calls (${stats.failedToolCalls} failed)`
        : stats.toolCalls === 1
          ? "tool call"
          : "tool calls",
    ]);
  }
  if (stats.thinkingBlocks > 0) {
    cells.push([
      String(stats.thinkingBlocks),
      stats.thinkingBlocks === 1 ? "reasoning block" : "reasoning blocks",
    ]);
  }
  if (elapsed) cells.push([elapsed, "elapsed"]);

  const stat = cells
    .map(
      ([n, l]) =>
        `<span class="stat"><b style="color:${accent}">${escapeHtml(n)}</b><span>${escapeHtml(l)}</span></span>`,
    )
    .join("");
  const chips = stats.toolCounts
    .slice(0, 8)
    .map(([label, n]) => `<span class="chip">${escapeHtml(label)}${n > 1 ? ` ×${n}` : ""}</span>`)
    .join("");

  return `
    <div class="overview">
      <div class="stats">${stat}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ""}
    </div>`;
}

/**
 * Build the standalone themed HTML document used for PDF printing. Laid out as
 * one continuous column; the caller sizes the page to the rendered height.
 *
 * Async because diagrams and plots are really rendered — a `draw_diagram` step
 * appears in the PDF as the diagram, not as its source.
 */
export async function buildChatPrintHtml(
  data: ExportChatData,
  theme: ExportTheme,
): Promise<string> {
  const p = PALETTE[theme.mode];
  const accent = theme.accent || "#4f9cf9";
  const family = theme.fontFamily?.trim() ? `"${theme.fontFamily.trim()}", ` : "";
  const fontStack = `${family}-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const mono = `"JetBrains Mono", "Fira Code", Consolas, monospace`;

  const meta: string[] = [];
  if (data.zoneName) meta.push(escapeHtml(data.zoneName));
  if (data.zoneModel) meta.push(escapeHtml(data.zoneModel));
  if (data.projectName) meta.push(escapeHtml(data.projectName));
  if (data.tagNames.length) meta.push(escapeHtml(data.tagNames.join(", ")));
  meta.push(`Exported ${escapeHtml(new Date().toLocaleString())}`);

  const units = buildTrace(data.messages);
  const stats = traceStats(units);
  const visuals = await renderVisuals(units);
  const body = units.map((u) => renderUnit(u, data, visuals, { accent, p })).join("");

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
  svg { vertical-align: middle; }

  /* ── Header ── */
  .pageheader { display: flex; align-items: center; gap: 10px;
    border-bottom: 1px solid ${p.border}; padding-bottom: 12px; }
  .pageheader .accent { width: 4px; height: 26px; border-radius: 2px; background: ${accent}; }
  .pageheader .htitle { font-weight: 600; font-size: 15px; }
  .pageheader .hmeta { margin-left: auto; text-align: right; font-size: 10px; color: ${p.muted}; }

  /* ── Overview strip ── */
  .overview { margin: 14px 0 22px; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; }
  .stat { display: flex; align-items: baseline; gap: 5px; font-size: 10px; color: ${p.muted};
    border: 1px solid ${p.border}; border-radius: 6px; padding: 5px 9px; background: ${p.panel}; }
  .stat b { font-size: 14px; font-weight: 700; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .chip { font-size: 9.5px; color: ${p.muted}; border: 1px solid ${p.border};
    border-radius: 999px; padding: 2px 8px; }

  /* ── Turns ── */
  .turn { margin: 0 0 16px; }
  .turn.user { display: flex; justify-content: flex-end; }
  .turn.user .bubble { max-width: 82%; border: 1px solid ${accent}55; background: ${accent}14;
    border-radius: 10px; padding: 9px 13px; }
  .who { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 11px;
    margin-bottom: 5px; }
  .whoico { display: inline-flex; opacity: 0.85; }
  .tmeta { margin-left: auto; font-weight: 400; font-size: 9.5px; color: ${p.muted};
    white-space: nowrap; }
  .steps { border-left: 2px solid ${p.border}; padding-left: 12px;
    display: flex; flex-direction: column; gap: 8px; }
  .say { border: 1px solid ${p.border}; background: ${p.panel}; border-radius: 8px; padding: 9px 12px; }

  /* ── Reasoning marker ── */
  .think { display: flex; align-items: center; gap: 7px; font-size: 10px; color: ${p.muted};
    border: 1px dashed ${p.border}; border-radius: 6px; padding: 5px 10px; }
  .thinkico { display: inline-flex; color: #a78bfa; }

  /* ── Tool cards ── */
  .tool { border: 1px solid ${p.border}; border-left-width: 3px; border-radius: 8px;
    background: ${p.panel}; padding: 8px 11px; break-inside: avoid; page-break-inside: avoid; }
  .tool.s-ok { border-left-color: #34d399; }
  .tool.s-error { border-left-color: #f87171; }
  .tool.s-idle { border-left-color: ${p.muted}; }
  .thead { display: flex; align-items: center; gap: 7px; }
  .tico { display: inline-flex; color: ${accent}; }
  .tlabel { font-weight: 600; font-size: 11px; white-space: nowrap; }
  .tsubject { font-size: 10.5px; color: ${p.text}; opacity: 0.8; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .tfoot { display: flex; align-items: center; gap: 8px; margin-top: 3px;
    font-size: 9.5px; color: ${p.muted}; }
  .tfn { font-family: ${mono}; font-size: 9px; background: ${p.code};
    border: 1px solid ${p.border}; border-radius: 4px; padding: 0 4px; }
  .tfailed { color: #f87171; font-weight: 600; }
  .preview { font-family: ${mono}; font-size: 9.5px; line-height: 1.45; margin: 7px 0 0;
    padding: 7px 9px; background: ${p.code}; border: 1px solid ${p.border}; border-radius: 6px;
    white-space: pre-wrap; word-break: break-word; color: ${p.muted}; }
  .terr { margin-top: 7px; padding: 7px 9px; border-radius: 6px; font-size: 10px;
    background: #f8717114; border: 1px solid #f8717144; color: ${p.text}; white-space: pre-wrap; }
  .thint { display: block; margin-top: 4px; color: ${p.muted}; }

  /* ── Plans ── */
  .plan { margin-top: 8px; }
  .planbar { display: flex; align-items: center; gap: 9px; font-size: 10px; color: ${p.muted}; }
  .plantrack { flex: 1; height: 4px; border-radius: 999px; background: ${p.border}; overflow: hidden; }
  .planfill { display: block; height: 100%; border-radius: 999px; }
  .plansteps { list-style: none; margin: 7px 0 0; padding: 7px 0 0; border-top: 1px solid; }
  .plansteps li { display: flex; align-items: flex-start; gap: 7px; font-size: 10.5px;
    padding: 2px 0; }
  .plmark { width: 11px; text-align: center; flex: 0 0 auto; }
  .pl-done { color: ${p.muted}; text-decoration: line-through; }
  .pl-done .plmark { color: #34d399; text-decoration: none; }
  .pl-skipped { color: ${p.muted}; opacity: 0.6; text-decoration: line-through; }
  .pl-in_progress { font-weight: 600; }
  .pl-in_progress .plmark { color: ${accent}; }
  .pl-pending { color: ${p.muted}; }

  /* ── Presented files ── */
  .filecard { display: flex; align-items: center; gap: 10px; margin-top: 8px;
    border: 1px solid ${p.border}; border-radius: 8px; padding: 9px 11px; background: ${p.bg}; }
  .fileico { display: inline-flex; }
  .filetext { display: flex; flex-direction: column; min-width: 0; }
  .filename { font-weight: 600; font-size: 11.5px; }
  .filepath { font-family: ${mono}; font-size: 9px; color: ${p.muted}; word-break: break-all; }
  .fmt { margin-left: auto; font-size: 9px; font-weight: 600; letter-spacing: 0.04em;
    border: 1px solid; border-radius: 999px; padding: 1px 7px; }

  /* ── Search hits ── */
  .hits { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .hits li { display: flex; gap: 7px; font-size: 10px; }
  .hitn { font-weight: 700; font-size: 9px; min-width: 12px; }
  .hittext { display: flex; flex-direction: column; min-width: 0; }
  .hittitle { font-weight: 500; }
  .hiturl { font-family: ${mono}; font-size: 9px; color: ${p.muted}; word-break: break-all; }
  .hitmore { color: ${p.muted}; font-style: italic; }

  /* ── Diagrams & plots ── */
  .diagram, .plot { margin-top: 8px; padding: 8px; border: 1px solid ${p.border};
    border-radius: 8px; background: ${p.bg}; text-align: center; }
  .diagram svg, .plot svg { max-width: 100%; height: auto; background: transparent !important; }
  .plot text { fill: ${p.text} !important; font-family: ${fontStack} !important; font-size: 11px !important; }
  .plot .axis path, .plot .axis .domain, .plot .axis .tick line { stroke: ${p.muted} !important; }
  .plot .x.grid .tick line, .plot .y.grid .tick line { stroke: ${p.border} !important; opacity: 0.7 !important; }
  .plot .x.grid path, .plot .y.grid path { stroke: none !important; }
  .plot .graph-container rect.background { fill: transparent !important; }
  .plot .content path, .plot .content circle { stroke-width: 2px; }
  .caption { margin-top: 4px; font-size: 9.5px; color: ${p.muted}; text-align: center; }

  /* ── Rendered markdown ── */
  .text { word-wrap: break-word; overflow-wrap: anywhere; }
  .text > :first-child { margin-top: 0; }
  .text > :last-child { margin-bottom: 0; }
  .text p { margin: 0 0 8px; }
  .text h1, .text h2, .text h3, .text h4 { margin: 12px 0 6px; line-height: 1.25; }
  .text h1 { font-size: 18px; } .text h2 { font-size: 16px; } .text h3 { font-size: 14px; } .text h4 { font-size: 12.5px; }
  .text ul, .text ol { margin: 0 0 8px; padding-left: 22px; }
  .text li { margin: 2px 0; }
  .text a { color: ${accent}; text-decoration: underline; }
  .text code { font-family: ${mono}; font-size: 11px;
    background: ${p.code}; border: 1px solid ${p.border}; border-radius: 4px; padding: 1px 4px; }
  .text pre { background: ${p.code}; border: 1px solid ${p.border}; border-radius: 6px;
    padding: 10px 12px; overflow-x: auto; margin: 0 0 8px; }
  .text pre code { background: none; border: 0; padding: 0; white-space: pre-wrap; word-break: break-word; }
  .text blockquote { margin: 0 0 8px; padding: 2px 0 2px 12px; border-left: 3px solid ${p.border}; color: ${p.muted}; }
  .text table { border-collapse: collapse; margin: 0 0 8px; font-size: 11px; }
  .text th, .text td { border: 1px solid ${p.border}; padding: 4px 8px; text-align: left; }
  .text hr { border: 0; border-top: 1px solid ${p.border}; margin: 12px 0; }
  .text img { max-width: 100%; }
  .imgnote { display: flex; align-items: center; gap: 5px; margin-top: 6px; font-size: 10px;
    font-style: italic; color: ${p.muted}; }
</style>
</head>
<body>
  <div class="pageheader">
    <span class="accent"></span>
    <span class="htitle">${escapeHtml(data.chat.title || "Untitled chat")}</span>
    <span class="hmeta">${meta.join(" · ")}</span>
  </div>
  ${renderOverview(stats, accent)}
  ${body}
</body>
</html>`;
}

/** Render the themed document into a hidden iframe, size the page to the full
 *  content height (so the PDF is one continuous page with no breaks), then open
 *  the print dialog. */
export async function exportChatPdf(data: ExportChatData, theme: ExportTheme): Promise<void> {
  const html = await buildChatPrintHtml(data, theme);
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
