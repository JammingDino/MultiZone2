import type { Step, ToolStep } from "@/lib/grouping";
import type { ContentPart } from "@/lib/types";

/**
 * Shared analysis of a turn's steps: status, a human label for the activity
 * rail, and whether the step produced something worth showing outside the rail.
 * Lives here rather than in StepBlock so the rail and the expanded per-step
 * cards agree on what a step is and how it went.
 */

export type StepStatus = "pending" | "running" | "done" | "error" | "warning";

/** Tools whose result renders as a visual the user actually asked for. */
const VISUAL_TOOLS = new Set([
  "plot_function",
  "render_chart",
  "update_plan",
  "present_file",
  "draw_diagram",
]);

/**
 * Present-participle labels for the built-in tools. Anything missing (MCP
 * tools, tools added later) falls back to the humanized function name, so this
 * map going out of date degrades to "Wsl exec" rather than to nothing.
 */
const TOOL_LABELS: Record<string, string> = {
  ask_user: "Asking a question",
  draft_plan_step: "Writing a plan step",
  enter_plan_mode: "Switching to plan mode",
  exit_plan_mode: "Proposing a plan",
  change_zone: "Switching zone",
  compact_context: "Compacting context",
  read_context: "Reading context usage",
  copy_file: "Copying file",
  create_file: "Writing file",
  create_folder: "Creating folder",
  claim_files: "Claiming files",
  collect_subagents: "Collecting sub-agents",
  create_skill: "Writing skill",
  delete_file: "Deleting file",
  delete_memory: "Forgetting",
  draw_diagram: "Drawing diagram",
  render_chart: "Drawing chart",
  edit_file: "Editing file",
  execute_code: "Running code",
  extract_url: "Reading page",
  find_files: "Finding files",
  get_current_datetime: "Checking the time",
  http_request: "Calling API",
  list_directory: "Listing folder",
  list_subchats: "Listing sub-agents",
  list_zones: "Listing zones",
  load_skill: "Loading skill",
  move_file: "Moving file",
  plot_function: "Plotting",
  post_note: "Posting to the team board",
  present_file: "Presenting file",
  read_file: "Reading file",
  read_memory: "Recalling",
  read_subchat: "Reading sub-agent",
  release_files: "Releasing files",
  run_command: "Running command",
  save_memory: "Remembering",
  search_file_text: "Searching files",
  search_local_files: "Searching files",
  send_subchat_message: "Messaging sub-agent",
  smart_crawl: "Crawling site",
  smart_fetch: "Fetching page",
  smart_search: "Searching the web",
  spawn_subagent: "Spawning sub-agent",
  tag_chat: "Tagging chat",
  team_status: "Checking the team board",
  terminal_list: "Listing terminals",
  terminal_read: "Watching terminal",
  terminal_start: "Opening terminal",
  terminal_stop: "Closing terminal",
  terminal_write: "Typing into terminal",
  read_plan: "Reading the plan",
  update_plan: "Updating plan",
  update_skill: "Updating skill",
  web_search: "Searching the web",
  wsl_exec: "Running command",
};

/** Argument keys checked, in order, for a short "what it acted on" suffix. */
const TARGET_KEYS = [
  "path",
  "file_path",
  "filename",
  "query",
  "command",
  "url",
  "name",
  "expression",
  "source_path",
];

export interface ToolAnalysis {
  name: string;
  args: any;
  /** Plain text of the tool result, or null while it is still running. */
  resultText: string | null;
  /** The result parsed as JSON, when it is JSON. */
  parsed: any;
  isError: boolean;
  errorKind: string | null;
  /**
   * Environment / configuration / timeout failures aren't the model's fault —
   * they're reported as warnings so the user reads them as "something on this
   * machine", not "the AI screwed up".
   */
  isSetupIssue: boolean;
  status: StepStatus;
  /** True when the result renders as a visual (plan, diagram, plot, file). */
  hasVisual: boolean;
}

export function extractToolResultText(json: string): string {
  try {
    const parts = JSON.parse(json) as ContentPart[];
    if (Array.isArray(parts)) {
      return parts
        .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  } catch {}
  return json;
}

export function parseJson(s: string | null): any {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function analyzeToolStep(step: ToolStep): ToolAnalysis {
  const { toolCall, toolResult, pending } = step;
  // A pending block can open before the provider has named the function (some
  // stream the arguments first), so there needs to be something to show until
  // the name lands.
  const name = toolCall.function.name || (pending ? "…" : "unknown tool");
  const resultText = toolResult ? extractToolResultText(toolResult.content) : null;
  const parsed = parseJson(resultText);
  const isError = !!parsed && typeof parsed === "object" && "error" in parsed;
  const errorKind: string | null = isError
    ? ((parsed.error_kind as string | undefined) ?? null)
    : null;
  const isSetupIssue =
    errorKind === "environment" ||
    errorKind === "configuration" ||
    errorKind === "timeout";

  let status: StepStatus;
  if (pending) status = "pending";
  else if (!toolResult) status = "running";
  else if (isError) status = isSetupIssue ? "warning" : "error";
  else status = "done";

  const hasVisual =
    VISUAL_TOOLS.has(name) && !!parsed && typeof parsed === "object" && !isError;

  return {
    name,
    args: parseJson(toolCall.function.arguments),
    resultText,
    parsed,
    isError,
    errorKind,
    isSetupIssue,
    status,
    hasVisual,
  };
}

/** Turns `wsl_exec` into `Wsl exec` — the fallback when a tool has no label. */
function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toolLabel(name: string): string {
  if (name === "…" || name === "unknown tool") return "Calling a tool";
  // MCP tools arrive namespaced (`server__tool`); label off the tool part.
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return TOOL_LABELS[bare] ?? humanize(bare);
}

/** A short, single-line "what it acted on" for the rail, or null. */
export function toolTarget(args: any): string | null {
  if (!args || typeof args !== "object") return null;
  for (const key of TARGET_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) continue;
    let text = value.trim().split(/\r?\n/)[0];
    // Paths read better as just their last segment.
    if ((key === "path" || key === "file_path" || key === "source_path") && text.length > 28) {
      const parts = text.split(/[\\/]/);
      text = parts[parts.length - 1] || text;
    }
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }
  return null;
}

/** The label the rail shows for a single step, e.g. `Reading file · notes.md`. */
export function stepLabel(step: Step): string {
  if (step.kind === "thinking") return "Thinking";
  const name = step.toolCall.function.name;
  if (!name) return "Calling a tool";
  const label = toolLabel(name);
  const target = toolTarget(parseJson(step.toolCall.function.arguments));
  return target ? `${label} · ${target}` : label;
}

export interface RunSummary {
  /** The step the rail names — the live one while working, else the last. */
  current: Step;
  /** Steps that failed outright (not setup issues). */
  errors: number;
  /** Steps that hit a host/setup problem. */
  warnings: number;
  /**
   * Tool steps in the run, successful or not. Only used to decide whether
   * *everything* failed (which is what turns the rail red) — the count the rail
   * displays is out of total steps, so it agrees with the step number shown
   * alongside it. Thinking steps aren't counted here; they can't fail.
   */
  toolCount: number;
  /** True while any step in the run is still pending or running. */
  active: boolean;
  /** Steps whose output is lifted out of the rail and always shown. */
  visualSteps: ToolStep[];
}

export function summarizeRun(steps: Step[]): RunSummary {
  let errors = 0;
  let warnings = 0;
  let toolCount = 0;
  let active = false;
  let current: Step = steps[steps.length - 1];
  const visualSteps: ToolStep[] = [];

  for (const step of steps) {
    if (step.kind === "thinking") {
      if (step.streaming) {
        active = true;
        current = step;
      }
      continue;
    }
    toolCount++;
    const a = analyzeToolStep(step);
    if (a.status === "error") errors++;
    else if (a.status === "warning") warnings++;
    if (a.status === "pending" || a.status === "running") {
      active = true;
      current = step;
    }
    if (a.hasVisual) visualSteps.push(step);
  }

  // A plan is a living document — the model rewrites it as it goes, so only the
  // latest `update_plan` is worth showing. Diagrams, plots and presented files
  // are each their own artefact and all stay.
  const lastPlanIdx = visualSteps.reduce(
    (acc, s, i) => (s.toolCall.function.name === "update_plan" ? i : acc),
    -1,
  );
  const deduped =
    lastPlanIdx < 0
      ? visualSteps
      : visualSteps.filter(
          (s, i) => s.toolCall.function.name !== "update_plan" || i === lastPlanIdx,
        );

  return { current, errors, warnings, toolCount, active, visualSteps: deduped };
}
