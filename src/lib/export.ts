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
  Settings,
  Sparkles,
  TerminalSquare,
  User,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { parseFileAttachments, type FileAttachment } from "@/lib/attachmentParts";
import type { Chat, ContentPart, Message, SessionEvent } from "@/lib/types";
import { saveTextFile } from "@/lib/saveFile";
import { chatContextEstimate, estimateTokens } from "@/lib/tokens";
import {
  buildTrace,
  condenseRuns,
  describeTool,
  formatDuration,
  traceStats,
  type ToolIcon,
  type TraceAttachmentsItem,
  type TraceRunItem,
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

/**
 * A sub-agent conversation spawned during the run (0.9.11).
 *
 * Exporting only the root chat used to lose most of what a Multizone run
 * actually was: the leader's answer survived, and the panel it cross-examined to
 * get there did not. These carry the delegated conversations, nested the way the
 * stack tracer shows them.
 *
 * The `user`-role turns inside one are *not* the person using the app — they are
 * the spawning zone briefing its sub-agent. Everything downstream of here takes
 * care to say so; see [`ConvoVoices`].
 */
export interface ExportSubchat {
  id: string;
  /** The chat that spawned it — the root chat, or another subchat when nested. */
  parentChatId: string | null;
  title: string;
  /** The zone that answers here. */
  zoneId: string | null;
  /** The zone that spawned it, and whose voice the prompts are in. */
  initiatedByZoneId: string | null;
  messages: Message[];
  createdAt: number;
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
  /** Sub-agent conversations to fold in. Empty when there are none, or when the
   *  user has turned them off in Settings. */
  subchats: ExportSubchat[];
  /**
   * The session event log (0.12.2), appended as a timeline. Empty for a chat
   * that predates the log — the export says nothing rather than claiming the
   * session did nothing.
   */
  events: SessionEvent[];
}

export interface ExportTheme {
  mode: "dark" | "light";
  accent: string;
  fontFamily: string;
}

/**
 * How much of the run the PDF spells out (1.0). The full trace is a power-user
 * document; someone exporting a chat to hand to a colleague usually wants the
 * conversation, not thirty tool cards. Configured in Settings → PDF export.
 *
 * "steps" — one card per tool call and reasoning block (the 0.9.8 document).
 * "rails" — each run of steps condensed to one line, the way the chat's activity
 *           rail does it; plans, diagrams, plots and presented files still drawn.
 * "text"  — the conversation only: what was asked, what was attached, what came
 *           back.
 */
export type ExportDetail = "steps" | "rails" | "text";

export interface ExportOptions {
  detail: ExportDetail;
}

const DEFAULT_OPTIONS: ExportOptions = { detail: "steps" };

interface RenderedMessage {
  role: "user" | "assistant";
  /** Display name for the turn. Null only for a turn the person actually typed;
   *  a `user` turn inside a subchat carries the spawning zone's name instead. */
  zoneLabel: string | null;
  accent: string | null;
  text: string;
  imageCount: number;
  /** Files attached to the turn, recovered from its hidden parts. */
  attachments: FileAttachment[];
  /** Sub-agent conversations this turn started, nested under it. */
  subchats: ExportSubchat[];
  timestamp: number;
}

/**
 * Who is speaking in a conversation, so the same renderers can draw the root
 * chat and a delegated one without either being mislabelled.
 *
 * `prompter` is the crux. In the root chat it is null and a `user` turn is the
 * person reading the export. In a subchat it is the zone that spawned the
 * sub-agent, and a `user` turn is one machine instructing another — which must
 * never be presented as something the user asked for.
 */
interface ConvoVoices {
  prompter: { name: string; accent: string | null } | null;
  /** Fallback name for assistant turns that carry no zone of their own. */
  responder: string | null;
}

const USER_VOICES: ConvoVoices = { prompter: null, responder: null };

function parseParts(json: string): ContentPart[] {
  try {
    const parts = JSON.parse(json);
    return Array.isArray(parts) ? (parts as ContentPart[]) : [];
  } catch {
    return [];
  }
}

// ─── Sub-agent conversations ─────────────────────────────────────────────────

/**
 * Hands out each subchat exactly once, at the call that spawned it.
 *
 * Taking rather than looking up does two jobs: a subchat can't be printed twice
 * if a run somehow references it twice, and a cycle in the parent chain (which
 * would otherwise recurse forever) terminates on its own.
 */
class SubchatIndex {
  private readonly byId = new Map<string, ExportSubchat>();

  constructor(subchats: ExportSubchat[]) {
    for (const s of subchats) this.byId.set(s.id, s);
  }

  take(id: string | null): ExportSubchat | null {
    if (!id) return null;
    const found = this.byId.get(id);
    if (found) this.byId.delete(id);
    return found ?? null;
  }

  /**
   * The oldest subchat no spawn call ever claimed — an orphan whose tool result
   * was trimmed, say. Taken as it is handed over, so a caller draining these can
   * loop without re-printing one that a nested render has since claimed.
   */
  takeOrphan(): ExportSubchat | null {
    let oldest: ExportSubchat | null = null;
    for (const s of this.byId.values()) {
      if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
    }
    if (oldest) this.byId.delete(oldest.id);
    return oldest;
  }
}

/** The subchat id a `spawn_subagent` step returned, if it succeeded. */
function spawnedIdOf(item: TraceToolItem): string | null {
  if (item.call.function.name !== "spawn_subagent") return null;
  const body = item.result as { subchat_id?: unknown } | null;
  return body && typeof body.subchat_id === "string" ? body.subchat_id : null;
}

/** The sub-agent conversations a turn started, in the order it started them. */
function subchatsSpawnedIn(unit: TraceUnit, index: SubchatIndex): ExportSubchat[] {
  const out: ExportSubchat[] = [];
  for (const item of unit.items) {
    if (item.kind !== "tool") continue;
    const sub = index.take(spawnedIdOf(item));
    if (sub) out.push(sub);
  }
  return out;
}

/** How a subchat's two participants should be named. */
function voicesFor(sub: ExportSubchat, data: ExportChatData): ConvoVoices {
  const leader = sub.initiatedByZoneId ? data.zonesById[sub.initiatedByZoneId] : undefined;
  const agent = sub.zoneId ? data.zonesById[sub.zoneId] : undefined;
  return {
    prompter: {
      name: leader?.name ?? "the calling zone",
      accent: leader?.accentColor ?? null,
    },
    responder: agent?.name ?? sub.title ?? "Sub-agent",
  };
}

/** Pull the visible text out of a message's JSON content parts. Hidden parts
 *  carry the attachments (named separately) and context-injection artifacts, so
 *  they are excluded here. */
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

/**
 * assistant message id → the subchat ids its `spawn_subagent` calls returned.
 *
 * The Markdown path walks raw messages rather than the trace, so the spawn
 * points are recovered the same way the app's stack tracer does it: match each
 * call id to the tool result that answered it.
 */
function spawnsByMessage(messages: Message[]): Map<string, string[]> {
  const callToMessage = new Map<string, string>();
  const out = new Map<string, string[]>();

  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      try {
        for (const call of JSON.parse(m.toolCalls) as { id?: string; function?: { name?: string } }[]) {
          if (call?.function?.name === "spawn_subagent" && call.id) {
            callToMessage.set(call.id, m.id);
          }
        }
      } catch {
        /* a malformed tool_calls blob just means no spawns found here */
      }
      continue;
    }
    if (m.role !== "tool" || !m.toolCallId) continue;
    const owner = callToMessage.get(m.toolCallId);
    if (!owner) continue;
    try {
      const body = JSON.parse(visibleText(m)) as { subchat_id?: unknown };
      if (typeof body?.subchat_id !== "string") continue;
      out.set(owner, [...(out.get(owner) ?? []), body.subchat_id]);
    } catch {
      /* a non-JSON result is a failed spawn — nothing to link */
    }
  }
  return out;
}

/** Reduce a raw message list to the user/assistant turns worth exporting,
 *  resolving a label for each one. Tool/system messages and empty turns (e.g. a
 *  pure tool-call step) are dropped — unless the step spawned a sub-agent, whose
 *  conversation hangs off it. */
function renderMessages(
  messages: Message[],
  data: ExportChatData,
  voices: ConvoVoices,
  index: SubchatIndex,
): RenderedMessage[] {
  const spawns = spawnsByMessage(messages);
  const out: RenderedMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = visibleText(m);
    const images = imageCount(m);
    const attachments = parseFileAttachments(parseParts(m.content));
    const subchats = (spawns.get(m.id) ?? [])
      .map((id) => index.take(id))
      .filter((s): s is ExportSubchat => s !== null);
    if (!text && images === 0 && attachments.length === 0 && subchats.length === 0) continue;

    let zoneLabel: string | null = null;
    let accent: string | null = null;
    if (m.role === "assistant") {
      const zid = m.zoneId ?? m.activeZoneId;
      const z = zid ? data.zonesById[zid] : undefined;
      zoneLabel = z?.name ?? voices.responder ?? data.zoneName ?? "Assistant";
      accent = z?.accentColor ?? null;
    } else if (voices.prompter) {
      // Not the user: a zone briefing the sub-agent it spawned.
      zoneLabel = voices.prompter.name;
      accent = voices.prompter.accent;
    }
    out.push({
      role: m.role,
      zoneLabel,
      accent,
      text,
      imageCount: images,
      attachments,
      subchats,
      timestamp: m.createdAt,
    });
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
  if (data.subchats.length) fm.push(yaml("subagent_conversations", String(data.subchats.length)));
  fm.push(yaml("exported", fmtIso(Date.now())));
  fm.push("---", "");

  const index = new SubchatIndex(data.subchats);
  const body: string[] = [`# ${chat.title || "Untitled chat"}`, ""];
  if (data.subchats.length) {
    body.push(
      `_This run delegated to ${data.subchats.length} sub-agent conversation${
        data.subchats.length === 1 ? "" : "s"
      }, nested below the turns that started them. Turns inside them are between ` +
        `zones — no one but the zone named wrote them._`,
      "",
    );
  }
  body.push(...conversationMarkdown(data.messages, data, USER_VOICES, index, 0));

  // A subchat whose spawn call left no usable result would otherwise vanish.
  for (let orphan = index.takeOrphan(); orphan; orphan = index.takeOrphan()) {
    body.push(...subchatMarkdown(orphan, data, index, 0));
  }

  // The event log as an appendix (0.12.2). Last, because it is the record
  // rather than the reading: the transcript is what happened as told, this is
  // what happened as logged — including the approvals declined and the failures
  // the prose never mentions.
  if (data.events.length) {
    const start = data.events[0].createdAt;
    const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ");
    body.push("", "---", "", "## Session log", "");
    body.push(
      `_${data.events.length} recorded event${data.events.length === 1 ? "" : "s"}, in order, timed from the first._`,
      "",
      "| Time | Event | Detail |",
      "| --- | --- | --- |",
    );
    for (const e of data.events) {
      const detail = cell(e.detail ?? "");
      body.push(
        `| ${elapsedLabel(e.createdAt - start)} | ${cell(e.label)} | ${
          detail.length > 160 ? `${detail.slice(0, 160)}…` : detail
        } |`,
      );
    }
    body.push("");
  }

  return fm.join("\n") + body.join("\n").trimEnd() + "\n";
}

/**
 * The session log as the PDF's closing section (0.12.2).
 *
 * The trace above is the run as it reads; this is the run as it was recorded —
 * the approvals declined, the tools that failed, the plan edited before it was
 * approved. Kept to a table on purpose: it is evidence, not narrative.
 */
function renderSessionLog(events: SessionEvent[], p: typeof PALETTE.dark): string {
  if (!events.length) return "";
  const start = events[0].createdAt;
  const rows = events
    .map(
      (e) => `<tr>
        <td style="color:${p.muted};white-space:nowrap;">${elapsedLabel(e.createdAt - start)}</td>
        <td>${escapeHtml(e.label)}</td>
      </tr>`,
    )
    .join("");
  return `<div class="section">
    <h2 style="font-size:15px;margin:18px 0 6px;">Session log</h2>
    <div style="font-size:10.5px;color:${p.muted};margin-bottom:6px;">
      ${events.length} recorded event${events.length === 1 ? "" : "s"}, in order, timed from the first.
    </div>
    <table style="border-collapse:collapse;font-size:11px;width:100%;">
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/** mm:ss since the session started — the axis a log is read along. */
function elapsedLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Markdown heading prefix for a conversation nested `depth` levels down. The
 *  root chat's turns are `##`; Markdown stops at six. */
function heading(depth: number, offset = 0): string {
  return "#".repeat(Math.min(2 + depth * 2 + offset, 6));
}

/** One conversation's turns as Markdown blocks, with any sub-agent conversations
 *  nested under the turns that started them. */
function conversationMarkdown(
  messages: Message[],
  data: ExportChatData,
  voices: ConvoVoices,
  index: SubchatIndex,
  depth: number,
): string[] {
  const body: string[] = [];
  for (const m of renderMessages(messages, data, voices, index)) {
    const who = m.role === "user" ? (m.zoneLabel ?? "User") : (m.zoneLabel ?? "Assistant");
    // A prompt inside a subchat is one zone instructing another; saying who it
    // went *to* is what stops it reading as a request from the person.
    const arrow = m.role === "user" && voices.prompter && voices.responder
      ? ` → ${voices.responder}`
      : "";
    body.push(`${heading(depth)} ${who}${arrow} · ${fmtDate(m.timestamp)}`, "");
    if (m.text) body.push(m.text, "");
    else if (m.subchats.length) {
      // A step that only delegated says nothing of its own; without this the
      // heading sits above the nested section with no explanation of why.
      body.push(
        `_Delegated to ${m.subchats.length} sub-agent${m.subchats.length === 1 ? "" : "s"}._`,
        "",
      );
    }
    if (m.imageCount > 0) {
      body.push(`_${m.imageCount} image${m.imageCount === 1 ? "" : "s"} attached_`, "");
    }
    // Named, so the transcript records which document the turn was about.
    for (const att of m.attachments) {
      const note =
        att.mode === "images"
          ? `PDF, ${att.pages.length} page${att.pages.length === 1 ? "" : "s"} as images`
          : att.mode === "text"
            ? "PDF, extracted text"
            : "text file";
      body.push(`_Attached: ${att.fileName} (${note})_`, "");
    }
    for (const sub of m.subchats) {
      body.push(...subchatMarkdown(sub, data, index, depth));
    }
  }
  return body;
}

/** A delegated conversation as a nested Markdown section. */
function subchatMarkdown(
  sub: ExportSubchat,
  data: ExportChatData,
  index: SubchatIndex,
  parentDepth: number,
): string[] {
  const voices = voicesFor(sub, data);
  const turns = sub.messages.filter((m) => m.role === "user" || m.role === "assistant").length;
  return [
    `${heading(parentDepth, 1)} ↳ Sub-agent · ${voices.responder}`,
    "",
    `_Spawned by ${voices.prompter?.name ?? "the calling zone"} · ${turns} turn${
      turns === 1 ? "" : "s"
    }_`,
    "",
    ...conversationMarkdown(sub.messages, data, voices, index, parentDepth + 1),
  ];
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
  settings: Settings,
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

async function renderVisuals(
  units: TraceUnit[],
  subchats: ExportSubchat[] = [],
): Promise<VisualCache> {
  const cache: VisualCache = new Map();
  const jobs: Promise<void>[] = [];

  // A diagram a sub-agent drew is drawn in the export too, so the nested
  // transcripts are not a downgraded second class of content.
  const all = [...units, ...subchats.flatMap((s) => buildTrace(s.messages))];

  for (const unit of all) {
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

/** Hostname only, for a compact source label — full URLs are too wide for a
 *  one-line hit. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const SEARCH_HITS_SHOWN = 5;

/** Search hits, as a compact numbered list of what was actually found — one
 *  line per hit so a search step reads as a small step, not a wall of text. */
function renderSearchVisual(body: any, accent: string): string {
  const results = Array.isArray(body?.results) ? body.results.slice(0, SEARCH_HITS_SHOWN) : [];
  if (results.length === 0) return "";
  const rows = results
    .map((r: any, i: number) => {
      const title = typeof r?.title === "string" && r.title.trim() ? r.title : `Result ${i + 1}`;
      const url = typeof r?.url === "string" ? r.url : typeof r?.path === "string" ? r.path : null;
      const source = url ? (hostOf(url) ?? url) : null;
      return `<li>
        <span class="hitn" style="color:${accent}">${i + 1}</span>
        <span class="hittitle">${escapeHtml(title)}</span>
        ${source ? `<span class="hitdomain">${escapeHtml(source)}</span>` : ""}
      </li>`;
    })
    .join("");
  const more = Array.isArray(body?.results) && body.results.length > SEARCH_HITS_SHOWN
    ? `<li class="hitmore">+ ${body.results.length - SEARCH_HITS_SHOWN} more</li>`
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

/**
 * A file write as its diff (0.13.3 export fidelity).
 *
 * The screen shows an edit as a diff, and the export used to show it as a
 * preview of `{"path": "...", "ok": true}` — which says a file changed and not
 * what changed about it. Built from the call's arguments, exactly as on screen.
 */
function renderDiffVisual(item: TraceToolItem, p: Palette): string {
  const name = item.call.function.name;
  const args = (item.args ?? {}) as Record<string, unknown>;
  const removed =
    name === "create_file" ? [] : String(args.old_text ?? "").split("\n").filter((l, i, a) => l !== "" || i < a.length - 1);
  const added = String(name === "create_file" ? (args.content ?? "") : (args.new_text ?? ""))
    .split("\n")
    .filter((l, i, a) => l !== "" || i < a.length - 1);
  if (removed.length === 0 && added.length === 0) return "";

  const rows = [
    ...removed.slice(0, DIFF_LINES).map((l) => ({ sign: "-", text: l })),
    ...added.slice(0, DIFF_LINES).map((l) => ({ sign: "+", text: l })),
  ]
    .map(
      (r) =>
        `<div class="dl ${r.sign === "+" ? "dadd" : "drem"}"><span class="ds">${r.sign}</span>${escapeHtml(
          r.text,
        )}</div>`,
    )
    .join("");
  const elided =
    removed.length > DIFF_LINES || added.length > DIFF_LINES
      ? `<div class="dl dmore">… ${Math.max(0, removed.length - DIFF_LINES) + Math.max(0, added.length - DIFF_LINES)} more lines</div>`
      : "";
  return `<div class="diff" style="border-color:${p.border}">
    <div class="dcount">+${added.length} −${removed.length}</div>${rows}${elided}
  </div>`;
}

/** A command, what it printed, and how it ended. */
function renderTerminalVisual(item: TraceToolItem, p: Palette): string {
  const args = (item.args ?? {}) as Record<string, unknown>;
  const body = (item.result ?? {}) as Record<string, unknown>;
  const command = String(args.command ?? args.code ?? args.input ?? "");
  const stdout = String(body.stdout ?? "");
  const stderr = String(body.stderr ?? "");
  const exit = typeof body.exit_code === "number" ? body.exit_code : null;
  if (!command && !stdout && !stderr) return "";

  // Tail-anchored, matching the screen: the end of a long run is the part that
  // carries the outcome.
  const tail = (s: string) => {
    const lines = s.replace(/\r\n/g, "\n").split("\n");
    const shown = lines.slice(-PREVIEW_LINES);
    return (lines.length > shown.length ? "…\n" : "") + shown.join("\n");
  };

  return `<div class="term" style="border-color:${p.border}">
    ${command ? `<div class="tcmd">$ ${escapeHtml(command)}</div>` : ""}
    ${stdout ? `<pre class="preview">${escapeHtml(tail(stdout))}</pre>` : ""}
    ${stderr ? `<pre class="preview terr">${escapeHtml(tail(stderr))}</pre>` : ""}
    ${exit !== null ? `<div class="texit ${exit === 0 ? "eok" : "ebad"}">exit ${exit}</div>` : ""}
  </div>`;
}

const DIFF_LINES = 24;
const DIFF_TOOLS = new Set(["create_file", "edit_file"]);
const TERMINAL_TOOLS = new Set(["run_command", "execute_code", "wsl_exec"]);

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
  } else if (DIFF_TOOLS.has(name)) {
    visual = renderDiffVisual(item, p);
  } else if (TERMINAL_TOOLS.has(name)) {
    visual = renderTerminalVisual(item, p);
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
  const tokens = estimateTokens(item.characters).toLocaleString();
  const label = item.durationMs !== null
    ? `Reasoning ${formatDuration(item.durationMs)} · ~${tokens} tks`
    : `Reasoning · ~${tokens} tks`;
  return `
    <div class="think">
      <span class="thinkico">${icon("brain")}</span>
      <span>${escapeHtml(label)}</span>
      <span class="tmeta">${escapeHtml(fmtTime(item.timestamp))}</span>
    </div>`;
}

/** What each attachment mode is called in the export, and what its size means. */
function attachmentNote(file: TraceAttachmentsItem["files"][number]): string {
  if (file.mode === "images") {
    return `PDF · ${file.pages ?? 0} page${file.pages === 1 ? "" : "s"} as images`;
  }
  const size = file.characters !== null ? formatBytes(file.characters) : null;
  const kind = file.mode === "text" ? "PDF · extracted text" : "text file";
  return size ? `${kind} · ${size}` : kind;
}

/** Compact byte size for an attachment's text payload. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The files that came with a user turn. Named, because "the assistant answered
 * about a spec" and "the assistant answered about *this* spec" are different
 * documents to anyone reading the export later.
 */
function renderAttachments(item: TraceAttachmentsItem, accent: string): string {
  const rows = item.files
    .map(
      (f) => `<span class="att">
        <span class="attico" style="color:${accent}">${icon("file", 11)}</span>
        <span class="attname">${escapeHtml(f.fileName)}</span>
        <span class="attmeta">${escapeHtml(attachmentNote(f))}</span>
      </span>`,
    )
    .join("");
  return `<div class="atts">${rows}</div>`;
}

/**
 * A run of steps as one line — icon, what it did, how long, how many failed.
 * The condensed counterpart to the stack of tool cards, and the same summary the
 * chat's activity rail shows when compact steps are on.
 */
function renderRun(run: TraceRunItem, visuals: VisualCache, accent: string, p: Palette): string {
  const single = run.steps.length === 1 ? run.steps[0] : null;
  const label = single
    ? single.kind === "thinking"
      ? "Reasoning"
      : [describeTool(single).label, describeTool(single).subject].filter(Boolean).join(" · ")
    : `Worked through ${run.steps.length} steps`;

  const bits: string[] = [];
  if (run.toolCalls > 0) {
    bits.push(`${run.toolCalls} tool call${run.toolCalls === 1 ? "" : "s"}`);
  }
  if (run.thinkingBlocks > 0) {
    bits.push(`${run.thinkingBlocks} reasoning`);
  }
  if (run.toolTimeMs !== null) bits.push(formatDuration(run.toolTimeMs));

  // One failure in a long run is not a failed run — the model usually reads the
  // error and carries on. Only a run where everything failed is called out, and
  // anything short of that is a count. (Same reading as the chat's rail.)
  const allFailed = run.toolCalls > 0 && run.errors === run.toolCalls;
  const issues =
    run.errors > 0
      ? `<span class="runissue ${allFailed ? "runfail" : ""}">${run.errors}/${run.steps.length} failed</span>`
      : "";

  const drawn = run.visuals
    .map((item) => renderToolCard(item, visuals, accent, p))
    .join("");

  return `
    <div class="run">
      <span class="runico" style="color:${accent}">${icon("tool", 11)}</span>
      <span class="runlabel">${escapeHtml(label)}</span>
      <span class="runrule"></span>
      ${issues}
      ${bits.length ? `<span class="runmeta">${escapeHtml(bits.join(" · "))}</span>` : ""}
    </div>
    ${drawn}`;
}

function renderUnit(
  unit: TraceUnit,
  data: ExportChatData,
  visuals: VisualCache,
  theme: { accent: string; p: Palette },
  detail: ExportDetail,
  voices: ConvoVoices,
  index: SubchatIndex,
  depth: number,
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
            : item.kind === "attachments"
              ? renderAttachments(item, accent)
              : "",
      )
      .join("");

    // Inside a subchat this is not the person: it is the spawning zone briefing
    // its sub-agent. Drawn as a brief — left-aligned, dashed, named on both ends
    // — so it can't be mistaken for the right-aligned bubble that means "you
    // said this".
    if (voices.prompter) {
      const briefAccent = voices.prompter.accent ?? accent;
      return `
        <div class="turn brief">
          <div class="who" style="color:${briefAccent}">
            <span class="whoico">${icon("users", 11)}</span>${escapeHtml(voices.prompter.name)}
            <span class="toagent">→ ${escapeHtml(voices.responder ?? "sub-agent")}</span>
            <span class="tmeta">${escapeHtml(fmtTime(unit.timestamp))}</span>
          </div>
          <div class="briefbody" style="border-color:${briefAccent}55">${inner}</div>
        </div>`;
    }

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
  const label = zone?.name ?? voices.responder ?? data.zoneName ?? "Assistant";
  // Delegated conversations are drawn after the turn that started them, in every
  // detail mode — in text-only they are the only trace of the delegation left.
  const spawned = subchatsSpawnedIn(unit, index)
    .map((sub) => renderSubchat(sub, data, visuals, theme, detail, index, depth + 1))
    .join("");

  let items: string;
  if (detail === "text") {
    items = unit.items
      .map((item) =>
        item.kind === "text" ? `<div class="text say">${renderMarkdown(item.text)}</div>` : "",
      )
      .join("");
    // A turn that only called tools has nothing to say in text-only mode — but a
    // turn that only delegated still has the delegation to show.
    if (!items.trim() && !spawned) return "";
  } else if (detail === "rails") {
    items = condenseRuns(unit.items)
      .map((item) => {
        if (item.kind === "text") return `<div class="text say">${renderMarkdown(item.text)}</div>`;
        if (item.kind === "run") return renderRun(item, visuals, zoneAccent, p);
        return "";
      })
      .join("");
  } else {
    items = unit.items
      .map((item) => {
        if (item.kind === "text") return `<div class="text say">${renderMarkdown(item.text)}</div>`;
        if (item.kind === "thinking") return renderThinking(item);
        if (item.kind === "tool") return renderToolCard(item, visuals, zoneAccent, p);
        return "";
      })
      .join("");
  }

  return `
    <div class="turn assistant">
      <div class="who" style="color:${zoneAccent}">
        <span class="whoico">${icon("assistant", 11)}</span>${escapeHtml(label)}
        <span class="tmeta">${escapeHtml(fmtDate(unit.timestamp))}</span>
      </div>
      <div class="steps" style="border-color:${zoneAccent}33">${items}${spawned}</div>
    </div>`;
}

/**
 * A delegated conversation, drawn inside the turn that started it.
 *
 * Indented and framed rather than merged into the flow, because the reader has
 * to be able to tell at a glance that they have stepped out of their own
 * conversation and into one between two zones.
 */
function renderSubchat(
  sub: ExportSubchat,
  data: ExportChatData,
  visuals: VisualCache,
  theme: { accent: string; p: Palette },
  detail: ExportDetail,
  index: SubchatIndex,
  depth: number,
): string {
  const voices = voicesFor(sub, data);
  const agent = sub.zoneId ? data.zonesById[sub.zoneId] : undefined;
  const agentAccent = agent?.accentColor ?? theme.accent;
  const units = buildTrace(sub.messages);
  const turns = units.length;

  const body = units
    .map((u) => renderUnit(u, data, visuals, theme, detail, voices, index, depth))
    .join("");

  return `
    <div class="subchat" style="border-color:${agentAccent}55">
      <div class="subhead">
        <span class="subico" style="color:${agentAccent}">${icon("users", 12)}</span>
        <span class="subname" style="color:${agentAccent}">${escapeHtml(
          voices.responder ?? "Sub-agent",
        )}</span>
        <span class="subrole">sub-agent of ${escapeHtml(
          voices.prompter?.name ?? "the calling zone",
        )}</span>
        <span class="tmeta">${escapeHtml(
          `${turns} turn${turns === 1 ? "" : "s"} · ${fmtTime(sub.createdAt)}`,
        )}</span>
      </div>
      <div class="subbody">${body || '<div class="subempty">No turns recorded.</div>'}</div>
    </div>`;
}

/** Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M". */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** The numbers strip under the header: what happened, before you read any of it. */
function renderOverview(
  stats: TraceStats,
  tokens: { input: number; output: number },
  accent: string,
  subagents: number,
): string {
  const elapsed =
    stats.firstAt !== null && stats.lastAt !== null && stats.lastAt > stats.firstAt
      ? formatDuration(stats.lastAt - stats.firstAt)
      : null;

  const cells: [string, string][] = [
    [`~${formatTokenCount(tokens.input)}`, "input tokens"],
    [`~${formatTokenCount(tokens.output)}`, "output tokens"],
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
  // What the conversation was given, not just what it produced — a run that
  // hinged on an attached document should say so before the first turn.
  const attached = stats.attachedFiles + stats.attachedImages;
  if (attached > 0) {
    cells.push([String(attached), attached === 1 ? "file attached" : "files attached"]);
  }
  if (subagents > 0) {
    cells.push([
      String(subagents),
      subagents === 1 ? "sub-agent conversation" : "sub-agent conversations",
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
  options: ExportOptions = DEFAULT_OPTIONS,
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
  const ctx = chatContextEstimate(data.messages);
  // Nothing a tool drew is shown in text-only mode, so nothing needs rendering.
  const visuals =
    options.detail === "text" ? new Map() : await renderVisuals(units, data.subchats);

  const index = new SubchatIndex(data.subchats);
  const look = { accent, p };
  let body = units
    .map((u) => renderUnit(u, data, visuals, look, options.detail, USER_VOICES, index, 0))
    .join("");
  // Anything the run never linked back to a spawn call still belongs in the
  // document; better an unattached transcript than a missing one.
  for (let orphan = index.takeOrphan(); orphan; orphan = index.takeOrphan()) {
    body += renderSubchat(orphan, data, visuals, look, options.detail, index, 1);
  }

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

  /* ── Legend, when the document contains delegated conversations ── */
  .legend { display: flex; align-items: flex-start; gap: 6px; margin: -8px 0 18px;
    font-size: 10px; color: ${p.muted}; border-left: 2px solid ${accent}66;
    padding: 2px 0 2px 9px; }
  .legend svg { flex: 0 0 auto; margin-top: 2px; }

  /* ── A brief from one zone to another (a subchat's "user" turn) ── */
  .turn.brief { margin-bottom: 10px; }
  .briefbody { border: 1px dashed; border-radius: 8px; padding: 8px 11px; background: ${p.bg}; }
  .toagent { font-weight: 400; font-size: 10px; color: ${p.muted}; }

  /* ── A delegated conversation ── */
  .subchat { margin: 8px 0 2px; border: 1px solid; border-radius: 9px;
    background: ${p.bg}; overflow: hidden; }
  .subhead { display: flex; align-items: center; gap: 7px; padding: 6px 10px;
    background: ${p.panel}; border-bottom: 1px solid ${p.border}; font-size: 10.5px; }
  .subico { display: inline-flex; }
  .subname { font-weight: 600; }
  .subrole { color: ${p.muted}; }
  .subbody { padding: 9px 11px; }
  .subbody > .turn:last-child { margin-bottom: 0; }
  .subempty { font-size: 10px; font-style: italic; color: ${p.muted}; }

  /* ── Attachments on a user turn ── */
  .atts { display: flex; flex-direction: column; gap: 4px; margin-top: 7px; }
  .att { display: flex; align-items: center; gap: 6px; font-size: 10px;
    border: 1px solid ${p.border}; border-radius: 6px; padding: 4px 8px; background: ${p.panel}; }
  .attico { display: inline-flex; }
  .attname { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attmeta { margin-left: auto; color: ${p.muted}; white-space: nowrap; }

  /* ── Condensed activity run ── */
  .run { display: flex; align-items: center; gap: 7px; font-size: 10.5px; color: ${p.muted}; }
  .runico { display: inline-flex; }
  .runlabel { color: ${p.text}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .runrule { flex: 1 1 auto; min-width: 16px; height: 1px; background: ${p.border}; }
  .runmeta { flex: 0 0 auto; white-space: nowrap; }
  .runissue { flex: 0 0 auto; color: #fbbf24; white-space: nowrap; }
  .runissue.runfail { color: #f87171; }

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

  /* ── Diffs and terminals (0.13.3) — the export shows what the screen showed ── */
  .diff { margin-top: 7px; border: 1px solid ${p.border}; border-radius: 6px; overflow: hidden;
    font-family: ${mono}; font-size: 9.5px; line-height: 1.5; }
  .dcount { padding: 3px 8px; background: ${p.code}; color: ${p.muted}; font-size: 9px;
    border-bottom: 1px solid ${p.border}; }
  .dl { padding: 0 8px; white-space: pre-wrap; word-break: break-word; }
  .ds { display: inline-block; width: 10px; color: ${p.muted}; }
  .dadd { background: #34d39914; color: ${p.text}; }
  .drem { background: #f8717114; color: ${p.muted}; }
  .dmore { color: ${p.muted}; padding: 2px 8px; }
  .term { margin-top: 7px; border: 1px solid ${p.border}; border-radius: 6px; overflow: hidden; }
  .tcmd { font-family: ${mono}; font-size: 9.5px; padding: 5px 9px; background: ${p.code};
    color: ${p.text}; white-space: pre-wrap; word-break: break-word;
    border-bottom: 1px solid ${p.border}; }
  .term .preview { margin: 0; border: 0; border-radius: 0; }
  .texit { padding: 3px 9px; font-size: 9px; font-family: ${mono};
    border-top: 1px solid ${p.border}; }
  .eok { color: #34d399; }
  .ebad { color: #f87171; }

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
  .hits { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .hits li { display: flex; align-items: baseline; gap: 6px; font-size: 9.5px;
    white-space: nowrap; overflow: hidden; }
  .hitn { font-weight: 700; font-size: 8.5px; flex: 0 0 auto; min-width: 10px; }
  .hittitle { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1 1 auto; min-width: 0; }
  .hitdomain { font-family: ${mono}; font-size: 8.5px; color: ${p.muted}; flex: 0 0 auto;
    max-width: 34%; overflow: hidden; text-overflow: ellipsis; }
  .hitmore { color: ${p.muted}; font-style: italic; font-size: 9px; }

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
  ${renderOverview(
    stats,
    { input: ctx.inputTokens, output: ctx.outputTokens },
    accent,
    data.subchats.length,
  )}
  ${
    data.subchats.length
      ? `<div class="legend">${icon("users", 11)} Boxed sections are conversations between
           zones — a leader briefing a sub-agent and reading its reply. Nothing inside one
           was written by you.</div>`
      : ""
  }
  ${body}
  ${renderSessionLog(data.events, p)}
</body>
</html>`;
}

/** Render the themed document into a hidden iframe, size the page to the full
 *  content height (so the PDF is one continuous page with no breaks), then open
 *  the print dialog. */
export async function exportChatPdf(
  data: ExportChatData,
  theme: ExportTheme,
  options: ExportOptions = DEFAULT_OPTIONS,
): Promise<void> {
  const html = await buildChatPrintHtml(data, theme, options);
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
