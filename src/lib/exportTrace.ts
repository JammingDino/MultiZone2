import { canonicalToolName } from "@/components/Message/visuals/families";
import { parseFileAttachments } from "@/lib/attachmentParts";
import type { ContentPart, Message, ToolCall } from "@/lib/types";

/**
 * The export trace model (0.9.8).
 *
 * The chat export used to carry only the model's prose, which made a transcript
 * of an agentic run read as if the answer arrived out of nowhere. This module
 * reduces the raw message list to the *whole* run — reasoning markers, every
 * tool call with a plain-language summary of what it did, and the artifacts it
 * produced — so a reader skimming the PDF can follow the work, not just the
 * conclusion.
 *
 * Everything here is pure and rendering-agnostic: `lib/export.ts` turns it into
 * the print document.
 */

export interface TraceTextItem {
  kind: "text";
  text: string;
  timestamp: number;
}

/** A reasoning block. The content is deliberately not carried — the reader is
 *  told the model was thinking and how much, not shown its private notes. */
export interface TraceThinkingItem {
  kind: "thinking";
  characters: number;
  timestamp: number;
  /** Wall time since the previous checkpoint (prior message/tool result), a
   *  proxy for how long the model spent reasoning. Null when implausible. */
  durationMs: number | null;
}

export interface TraceImagesItem {
  kind: "images";
  count: number;
  timestamp: number;
}

/** One file the user attached to a turn. */
export interface TraceAttachment {
  fileName: string;
  /** How it was sent: rendered PDF pages, extracted PDF text, a text file, or a
   *  transcribed audio upload. */
  mode: "images" | "text" | "file" | "audio";
  /** Page count, for a PDF sent as page images. */
  pages: number | null;
  /** Character count of the text the model received, when it was text. */
  characters: number | null;
}

/**
 * The files attached to a user turn. Attachments ride along as hidden parts, so
 * before 1.0 an export of a turn that was mostly "here is the spec, review it"
 * showed the one-line question and no sign that a document came with it —
 * leaving the answer looking like it came from nowhere.
 */
export interface TraceAttachmentsItem {
  kind: "attachments";
  files: TraceAttachment[];
  timestamp: number;
}

export interface TraceToolItem {
  kind: "tool";
  call: ToolCall;
  /** Parsed arguments, or null when the model emitted invalid JSON. */
  args: Record<string, unknown> | null;
  /** Parsed tool result body, or null when there is no result / it isn't JSON. */
  result: unknown;
  /** Raw result text, for tools whose output isn't JSON. */
  resultText: string | null;
  timestamp: number;
  /** Wall time from the call being issued to its result landing, in ms. */
  durationMs: number | null;
  status: ToolStatus;
}

export type ToolStatus = "ok" | "error" | "no-result";

export type TraceItem =
  | TraceTextItem
  | TraceThinkingItem
  | TraceImagesItem
  | TraceAttachmentsItem
  | TraceToolItem;

export interface TraceUnit {
  role: "user" | "assistant";
  /** Zone that produced an assistant turn; null for user turns. */
  zoneId: string | null;
  timestamp: number;
  items: TraceItem[];
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function parseParts(json: string): ContentPart[] {
  try {
    const parts = JSON.parse(json);
    return Array.isArray(parts) ? (parts as ContentPart[]) : [];
  } catch {
    return [];
  }
}

/** Visible text only — hidden parts are context-injection artifacts. */
function visibleText(m: Message): string {
  return parseParts(m.content)
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

function visibleImageCount(m: Message): number {
  return parseParts(m.content).filter((p) => p.type === "image_url").length;
}

/** The files attached to a message, read back off its hidden parts. */
function attachmentsOf(m: Message): TraceAttachment[] {
  return parseFileAttachments(parseParts(m.content)).map((a) => ({
    fileName: a.fileName,
    mode: a.mode,
    pages: a.mode === "images" ? a.pages.length : null,
    characters: a.mode === "images" ? null : a.text.length,
  }));
}

function parseToolCalls(json: string | null): ToolCall[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as ToolCall[]) : [];
  } catch {
    return [];
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ─── Trace construction ──────────────────────────────────────────────────────

/**
 * Reduce a chat's messages to ordered turns. Consecutive assistant messages from
 * the same participant collapse into one turn so a multi-step agentic run reads
 * as a single answer with steps inside it, rather than a dozen near-empty
 * bubbles. Tool results are matched back onto the call that issued them.
 */
export function buildTrace(messages: Message[]): TraceUnit[] {
  const units: TraceUnit[] = [];
  /** tool_call_id → the item awaiting its result. */
  const awaiting = new Map<string, TraceToolItem>();
  let current: TraceUnit | null = null;
  /** createdAt of the previous message, the anchor for a reasoning block's
   *  elapsed-time estimate. */
  let lastTs: number | null = null;

  for (const m of messages) {
    if (m.role === "system") continue;
    const anchorTs = lastTs;
    lastTs = m.createdAt;

    if (m.role === "user") {
      current = null;
      const items: TraceItem[] = [];
      const text = visibleText(m);
      if (text) items.push({ kind: "text", text, timestamp: m.createdAt });
      const images = visibleImageCount(m);
      if (images > 0) items.push({ kind: "images", count: images, timestamp: m.createdAt });
      const files = attachmentsOf(m);
      if (files.length > 0) items.push({ kind: "attachments", files, timestamp: m.createdAt });
      if (items.length === 0) continue;
      units.push({ role: "user", zoneId: null, timestamp: m.createdAt, items });
      continue;
    }

    if (m.role === "tool") {
      const item = m.toolCallId ? awaiting.get(m.toolCallId) : undefined;
      if (item) {
        applyResult(item, m);
        awaiting.delete(m.toolCallId!);
      }
      continue;
    }

    // Assistant. Steps by the same participant extend the open turn.
    const zoneId = m.zoneId ?? m.activeZoneId ?? null;
    if (!current || current.zoneId !== zoneId) {
      current = { role: "assistant", zoneId, timestamp: m.createdAt, items: [] };
      units.push(current);
    }

    if (m.reasoning && m.reasoning.trim()) {
      const elapsed = anchorTs !== null ? m.createdAt - anchorTs : null;
      current.items.push({
        kind: "thinking",
        characters: m.reasoning.trim().length,
        timestamp: m.createdAt,
        // Clock skew and resumed sessions produce nonsense; only report a plausible one.
        durationMs: elapsed !== null && elapsed >= 0 && elapsed < 60 * 60 * 1000 ? elapsed : null,
      });
    }
    const text = visibleText(m);
    if (text) current.items.push({ kind: "text", text, timestamp: m.createdAt });
    for (const call of parseToolCalls(m.toolCalls)) {
      const item: TraceToolItem = {
        kind: "tool",
        call,
        args: asRecord(parseJson(call.function.arguments ?? "")),
        result: null,
        resultText: null,
        timestamp: m.createdAt,
        durationMs: null,
        status: "no-result",
      };
      current.items.push(item);
      if (call.id) awaiting.set(call.id, item);
    }
  }

  return units.filter((u) => u.items.length > 0);
}

function applyResult(item: TraceToolItem, m: Message): void {
  const text = parseParts(m.content)
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  item.resultText = text || null;
  item.result = text ? parseJson(text) : null;
  const body = asRecord(item.result);
  item.status = body && "error" in body ? "error" : "ok";
  const elapsed = m.createdAt - item.timestamp;
  // Clock skew and resumed sessions produce nonsense; only report a plausible one.
  item.durationMs = elapsed >= 0 && elapsed < 60 * 60 * 1000 ? elapsed : null;
}

// ─── Condensing a turn into activity runs ────────────────────────────────────

/** Tools whose result is an artefact the user asked for, so it survives
 *  condensing. Mirrors `VISUAL_TOOLS` in lib/stepSummary.ts, which does the same
 *  job for the chat's activity rail. */
const VISUAL_TOOLS = new Set([
  "update_plan",
  "draw_diagram",
  "plot_function",
  "render_chart",
  "present_file",
]);

/**
 * A stretch of consecutive thinking/tool steps, collapsed into one unit — the
 * export's counterpart to the chat's activity rail.
 */
export interface TraceRunItem {
  kind: "run";
  steps: (TraceThinkingItem | TraceToolItem)[];
  toolCalls: number;
  errors: number;
  thinkingBlocks: number;
  /** Steps whose output is drawn in full anyway (plan, diagram, plot, file). */
  visuals: TraceToolItem[];
  timestamp: number;
  /** Time spent inside the run's tool calls, when any of them are known. */
  toolTimeMs: number | null;
}

export type CondensedItem = TraceItem | TraceRunItem;

/**
 * Group a turn's items so that each run of consecutive thinking/tool steps
 * becomes a single [`TraceRunItem`]; prose and attachments pass through
 * untouched. Prose ends a run, so the model's answer is never swallowed by one.
 */
export function condenseRuns(items: TraceItem[]): CondensedItem[] {
  const out: CondensedItem[] = [];
  let run: TraceRunItem | null = null;

  const close = () => {
    if (!run) return;
    // A plan is rewritten as the model goes, so only the last one is worth
    // drawing — same rule the chat's rail applies.
    const lastPlan = run.visuals.reduce(
      (acc, s, i) => (s.call.function.name === "update_plan" ? i : acc),
      -1,
    );
    if (lastPlan >= 0) {
      run.visuals = run.visuals.filter(
        (s, i) => s.call.function.name !== "update_plan" || i === lastPlan,
      );
    }
    out.push(run);
    run = null;
  };

  for (const item of items) {
    if (item.kind !== "thinking" && item.kind !== "tool") {
      close();
      out.push(item);
      continue;
    }
    if (!run) {
      run = {
        kind: "run",
        steps: [],
        toolCalls: 0,
        errors: 0,
        thinkingBlocks: 0,
        visuals: [],
        timestamp: item.timestamp,
        toolTimeMs: null,
      };
    }
    run.steps.push(item);
    if (item.kind === "thinking") {
      run.thinkingBlocks++;
    } else {
      run.toolCalls++;
      if (item.status === "error") run.errors++;
      if (item.durationMs !== null) run.toolTimeMs = (run.toolTimeMs ?? 0) + item.durationMs;
      if (item.status === "ok" && VISUAL_TOOLS.has(item.call.function.name)) {
        run.visuals.push(item);
      }
    }
  }
  close();
  return out;
}

// ─── Tool descriptions ───────────────────────────────────────────────────────

/** Which glyph the renderer should put on a tool card. */
export type ToolIcon =
  | "tool"
  | "file"
  | "folder"
  | "edit"
  | "search"
  | "globe"
  | "terminal"
  | "checklist"
  | "diagram"
  | "chart"
  | "brain"
  | "users"
  | "database"
  | "settings"
  | "clock";

export interface ToolDescription {
  /** Human-facing name, e.g. "Read file". */
  label: string;
  icon: ToolIcon;
  /** What it acted on, drawn from the arguments — the skim line. */
  subject: string | null;
  /** What came back, drawn from the result. */
  outcome: string | null;
}

const LABELS: Record<string, { label: string; icon: ToolIcon }> = {
  read: { label: "Read file", icon: "file" },
  write: { label: "Wrote file", icon: "file" },
  edit: { label: "Edited file", icon: "edit" },
  present_file: { label: "Presented file", icon: "file" },
  move_file: { label: "Moved file", icon: "file" },
  copy_file: { label: "Copied file", icon: "file" },
  delete_file: { label: "Deleted file", icon: "file" },
  create_folder: { label: "Created folder", icon: "folder" },
  glob: { label: "Found files", icon: "search" },
  grep: { label: "Searched in files", icon: "search" },
  web_search: { label: "Web search", icon: "globe" },
  smart_search: { label: "Web search", icon: "globe" },
  smart_fetch: { label: "Fetched page", icon: "globe" },
  smart_crawl: { label: "Crawled site", icon: "globe" },
  extract_url: { label: "Read web page", icon: "globe" },
  http_request: { label: "HTTP request", icon: "globe" },
  execute_code: { label: "Ran code", icon: "terminal" },
  bash: { label: "Ran command", icon: "terminal" },
  wsl_exec: { label: "Ran Linux command", icon: "terminal" },
  terminal_start: { label: "Opened terminal", icon: "terminal" },
  terminal_write: { label: "Typed into terminal", icon: "terminal" },
  terminal_read: { label: "Read terminal", icon: "terminal" },
  terminal_list: { label: "Listed terminals", icon: "terminal" },
  terminal_stop: { label: "Closed terminal", icon: "terminal" },
  app_read: { label: "Read app state", icon: "settings" },
  app_control: { label: "Changed the app", icon: "settings" },
  update_plan: { label: "Plan", icon: "checklist" },
  draw_diagram: { label: "Diagram", icon: "diagram" },
  plot_function: { label: "Plot", icon: "chart" },
  render_chart: { label: "Chart", icon: "chart" },
  search_local_files: { label: "Knowledge search", icon: "database" },
  save_memory: { label: "Saved memory", icon: "brain" },
  read_memory: { label: "Read memory", icon: "brain" },
  delete_memory: { label: "Deleted memory", icon: "brain" },
  load_skill: { label: "Loaded skill", icon: "brain" },
  create_skill: { label: "Wrote skill", icon: "brain" },
  update_skill: { label: "Updated skill", icon: "brain" },
  compact_context: { label: "Condensed the conversation", icon: "brain" },
  read_context: { label: "Read context usage", icon: "brain" },
  spawn_subagent: { label: "Delegated to a zone", icon: "users" },
  send_subchat_message: { label: "Messaged subagent", icon: "users" },
  read_subchat: { label: "Read subagent transcript", icon: "users" },
  collect_subagents: { label: "Collected subagents", icon: "users" },
  list_subchats: { label: "Listed subagents", icon: "users" },
  team_status: { label: "Read the team board", icon: "users" },
  claim_files: { label: "Claimed files", icon: "users" },
  release_files: { label: "Released files", icon: "users" },
  post_note: { label: "Posted to the team board", icon: "users" },
  list_zones: { label: "Listed zones", icon: "users" },
  change_zone: { label: "Switched zone", icon: "users" },
  ask_user: { label: "Asked a question", icon: "users" },
  enter_plan_mode: { label: "Entered plan mode", icon: "checklist" },
  exit_plan_mode: { label: "Proposed a plan", icon: "checklist" },
  draft_plan_step: { label: "Drafted a plan step", icon: "checklist" },
  read_plan: { label: "Read the plan", icon: "checklist" },
  tag_chat: { label: "Tagged the chat", icon: "tool" },
  get_current_datetime: { label: "Checked the time", icon: "clock" },
};

/** Turn a raw function name into something readable when it isn't in the map
 *  (MCP tools, renamed built-ins): `mcp__ab12__list_issues` → "List issues". */
function prettifyName(name: string): string {
  const tail = name.replace(/^mcp__[^_]+__/, "").replace(/[_-]+/g, " ").trim();
  if (!tail) return name;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

/** Shorten a path to its last two segments so a card stays one line. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The first argument that carries meaning, for tools with no bespoke rule. */
function genericSubject(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  for (const key of ["path", "query", "url", "command", "name", "pattern", "source", "text"]) {
    const v = str(args[key]);
    if (v) return key === "path" ? shortPath(v) : truncate(v, 90);
  }
  const first = Object.values(args).find((v) => typeof v === "string" && v.trim());
  return typeof first === "string" ? truncate(first, 90) : null;
}

/**
 * A one-line, plain-language account of a tool call: what it was pointed at and
 * what came back. This is what makes the trace skimmable — without it a reader
 * gets a function name and a JSON blob.
 */
export function describeTool(item: TraceToolItem): ToolDescription {
  const name = item.call.function.name || "unknown";
  const known = LABELS[canonicalToolName(name)];
  const args = item.args;
  const body = asRecord(item.result);

  const desc: ToolDescription = {
    label: known?.label ?? prettifyName(name),
    icon: known?.icon ?? "tool",
    subject: null,
    outcome: null,
  };

  // On the canonical name, not the raw one: history from before 0.18 carries
  // `read_file` and `list_directory`, and the label above already resolves
  // them. A switch on the raw name gave those turns a label and then no
  // subject and no outcome, which reads as a tool that did nothing.
  switch (canonicalToolName(name)) {
    case "read":
    case "write":
    case "edit":
    case "delete_file":
    case "present_file":
    case "create_folder":
      desc.subject = str(args?.path) ? shortPath(str(args!.path)!) : null;
      break;
    case "move_file":
    case "copy_file": {
      const from = str(args?.source ?? args?.from ?? args?.path);
      const to = str(args?.destination ?? args?.to ?? args?.dest);
      desc.subject = from && to ? `${shortPath(from)} → ${shortPath(to)}` : (from ?? to);
      break;
    }
    case "web_search":
    case "smart_search":
    case "search_local_files":
    case "glob":
    case "grep":
      desc.subject = str(args?.query) ?? str(args?.pattern) ?? str(args?.text);
      break;
    case "smart_fetch":
    case "smart_crawl":
    case "extract_url":
    case "http_request": {
      const url = str(args?.url) ?? str(args?.urls);
      const urls = Array.isArray(args?.urls) ? (args!.urls as unknown[]) : null;
      desc.subject = urls
        ? `${str(urls[0]) ?? ""}${urls.length > 1 ? ` +${urls.length - 1} more` : ""}`
        : url;
      if (name === "http_request" && str(args?.method)) {
        desc.subject = `${str(args!.method)!.toUpperCase()} ${desc.subject ?? ""}`.trim();
      }
      break;
    }
    case "execute_code":
      desc.subject = str(args?.language) ? `${str(args!.language)} snippet` : "code snippet";
      break;
    case "bash":
    case "wsl_exec":
      desc.subject = str(args?.command);
      break;
    case "terminal_start":
      desc.subject = str(args?.command) ?? str(args?.name);
      break;
    case "terminal_write":
    case "terminal_read":
    case "terminal_stop":
      // Which terminal, deliberately not what was typed: `terminal_write` is how
      // a password reaches a prompt, and a summary line is the last place it
      // should be reprinted.
      desc.subject = str(args?.terminal_id);
      break;
    case "update_plan": {
      const steps = Array.isArray(args?.steps) ? (args!.steps as unknown[]) : [];
      desc.subject = steps.length ? plural(steps.length, "step") : null;
      break;
    }
    case "draw_diagram": {
      const source = str(args?.source) ?? "";
      const first = source.split("\n")[0]?.trim() ?? "";
      desc.subject = str(args?.caption) ?? (first ? truncate(first, 60) : null);
      break;
    }
    case "render_chart": {
      const series = Array.isArray(args?.series) ? (args!.series as unknown[]) : [];
      const names = series.map((x) => str(asRecord(x)?.name)).filter(Boolean) as string[];
      desc.subject = str(args?.title) ?? (names.length ? names.join(", ") : str(args?.type));
      break;
    }
    case "plot_function": {
      const fns = Array.isArray(args?.functions) ? (args!.functions as unknown[]) : [];
      const exprs = fns
        .map((f) => (typeof f === "string" ? f : str(asRecord(f)?.fn)))
        .filter(Boolean) as string[];
      desc.subject = exprs.length ? exprs.join(", ") : str(args?.title);
      break;
    }
    case "spawn_subagent":
      desc.subject = str(args?.zone_name) ?? str(args?.zone_id) ?? str(args?.task);
      break;
    case "collect_subagents": {
      const ids = Array.isArray(args?.subchat_ids) ? (args!.subchat_ids as unknown[]) : [];
      desc.subject = ids.length ? plural(ids.length, "sub-agent") : "all in flight";
      break;
    }
    case "save_memory":
    case "read_memory":
      desc.subject = str(args?.content) ?? str(args?.scope);
      break;
    case "load_skill":
    case "create_skill":
    case "update_skill":
      desc.subject = str(args?.name);
      break;
    case "tag_chat": {
      const tags = Array.isArray(args?.tags) ? (args!.tags as unknown[]) : [];
      desc.subject = tags.map((t) => str(t) ?? "").filter(Boolean).join(", ") || null;
      break;
    }
    default:
      desc.subject = genericSubject(args);
  }
  if (!desc.subject) desc.subject = genericSubject(args);
  if (desc.subject) desc.subject = truncate(desc.subject, 110);

  desc.outcome = describeOutcome(name, item, body);
  return desc;
}

function describeOutcome(
  name: string,
  item: TraceToolItem,
  body: Record<string, unknown> | null,
): string | null {
  if (item.status === "no-result") return null;
  if (item.status === "error") {
    const msg = body ? str(body.error) : null;
    return msg ? truncate(msg, 120) : "failed";
  }
  // A multimodal result is an array of content parts, not an object: an image
  // read, or a PDF read as page images. Counting the images says what the model
  // actually got to look at, where "N lines of output" would only describe the
  // caption above them.
  if (Array.isArray(item.result)) {
    const images = item.result.filter(
      (p) => asRecord(p)?.type === "image_url",
    ).length;
    // `read` labels its own multimodal result: "PDF: …" for page renders,
    // "Image file: …" for a picture read with `as_image`.
    const asPages = item.resultText?.startsWith("PDF:") ?? false;
    if (images > 0) {
      return asPages ? plural(images, "page read", "pages read") : plural(images, "image");
    }
  }
  if (!body) {
    return item.resultText ? `${plural(countLines(item.resultText), "line")} of output` : null;
  }

  const results = Array.isArray(body.results) ? body.results : null;
  if (results) return results.length ? plural(results.length, "result") : "no results";

  switch (canonicalToolName(name)) {
    case "update_plan": {
      const done = typeof body.done === "number" ? body.done : null;
      const total = typeof body.total === "number" ? body.total : null;
      return done !== null && total !== null ? `${done} of ${total} done` : null;
    }
    // One `read` does both jobs since 0.18 — a file's text, or a directory's
    // entries — so the result shape is what says which happened, not the name.
    case "read": {
      const content = str(body.content) ?? str(body.text);
      if (content) return `${plural(countLines(content), "line")} read`;
      const entries = Array.isArray(body.entries) ? body.entries.length : null;
      return entries !== null ? plural(entries, "entry", "entries") : null;
    }
    case "write":
    case "edit": {
      const bytes = typeof body.bytes === "number" ? body.bytes : null;
      return bytes !== null ? `${formatBytes(bytes)} written` : "saved";
    }
    case "glob": {
      const files = Array.isArray(body.files) ? body.files.length : null;
      return files !== null ? plural(files, "file") : null;
    }
    case "present_file":
      return str(body.filename) ?? null;
    case "draw_diagram":
      return null;
    case "render_chart":
      // The chart itself is drawn just below; the only thing worth saying in
      // words is the one case the renderer quietly papered over.
      return str(body.note) ?? null;
    case "http_request": {
      const status = typeof body.status === "number" ? body.status : null;
      return status !== null ? `HTTP ${status}` : null;
    }
    case "execute_code":
    case "bash":
    case "wsl_exec": {
      const code = typeof body.exit_code === "number" ? body.exit_code : null;
      const out = str(body.stdout) ?? str(body.output);
      const parts: string[] = [];
      if (code !== null) parts.push(code === 0 ? "exit 0" : `exit ${code}`);
      if (out) parts.push(`${plural(countLines(out), "line")} of output`);
      return parts.join(" · ") || null;
    }
    case "terminal_start":
    case "terminal_write":
    case "terminal_read":
    case "terminal_stop": {
      // Whether the thing is still alive is the fact that matters here — an
      // exit code on a terminal that was supposed to keep running is the story.
      const parts: string[] = [];
      if (body.running === true) parts.push("still running");
      else if (typeof body.exit_code === "number") parts.push(`exited ${body.exit_code}`);
      if (body.matched === false) parts.push("pattern not seen");
      const out = str(body.output);
      if (out) parts.push(`${plural(countLines(out), "line")} of output`);
      return parts.join(" · ") || null;
    }
    case "terminal_list": {
      const n = Array.isArray(body.terminals) ? body.terminals.length : null;
      return n !== null ? plural(n, "terminal") : null;
    }
    default: {
      const pages = Array.isArray(body.pages) ? body.pages.length : null;
      if (pages !== null) return plural(pages, "page");
      const content = str(body.content) ?? str(body.markdown) ?? str(body.text);
      if (content) return `${formatBytes(content.length)} of text`;
      if (body.ok === true) return "done";
      return null;
    }
  }
}

function countLines(s: string): number {
  return s.split("\n").length;
}

// ─── Run statistics ──────────────────────────────────────────────────────────

export interface TraceStats {
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  failedToolCalls: number;
  thinkingBlocks: number;
  /** Total reasoning characters across the conversation. */
  thinkingCharacters: number;
  /** Files the user attached across the conversation (images excluded). */
  attachedFiles: number;
  /** Images the user attached across the conversation. */
  attachedImages: number;
  /** Tool name → call count, most-used first. */
  toolCounts: [string, number][];
  firstAt: number | null;
  lastAt: number | null;
}

/** The at-a-glance numbers printed under the export header. */
export function traceStats(units: TraceUnit[]): TraceStats {
  const stats: TraceStats = {
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    thinkingBlocks: 0,
    thinkingCharacters: 0,
    attachedFiles: 0,
    attachedImages: 0,
    toolCounts: [],
    firstAt: null,
    lastAt: null,
  };
  const counts = new Map<string, number>();

  for (const unit of units) {
    if (unit.role === "user") stats.userTurns++;
    else stats.assistantTurns++;
    for (const item of unit.items) {
      if (stats.firstAt === null || item.timestamp < stats.firstAt) stats.firstAt = item.timestamp;
      if (stats.lastAt === null || item.timestamp > stats.lastAt) stats.lastAt = item.timestamp;
      if (item.kind === "thinking") {
        stats.thinkingBlocks++;
        stats.thinkingCharacters += item.characters;
      } else if (item.kind === "images") {
        stats.attachedImages += item.count;
      } else if (item.kind === "attachments") {
        stats.attachedFiles += item.files.length;
      } else if (item.kind === "tool") {
        stats.toolCalls++;
        if (item.status === "error") stats.failedToolCalls++;
        const label = describeTool(item).label;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }

  stats.toolCounts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return stats;
}

/** Compact human duration: "820ms", "4.2s", "3m 10s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
