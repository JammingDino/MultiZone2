/**
 * Prompt-section switches (0.21.0): which parts of the system prompt a zone
 * sends. Stored as `{id: boolean}` — app-wide in the `promptSections` app
 * setting, per zone under `prompt_sections` in its tool config, the zone's
 * winning. An id named in neither is on. The ids are Rust's `SnippetKind`
 * names (`context.rs: SWITCHABLE`), which a Rust test checks against this file.
 */

export interface FirstRequest {
  zoneName: string;
  model: string;
  providerName: string;
  endpoint: string;
  sections: { id: string; title: string; tokens: number; text: string }[];
  tools: { name: string; group: string; tokens: number }[];
  systemTokens: number;
  toolsTokens: number;
  historyTokens: number;
  totalTokens: number;
  messageCount: number;
  body: string;
  off: string[];
  switchable: { id: string; label: string }[];
}

export type Switches = Record<string, boolean>;

/** Every switch, in the order the editor lists them. */
export const SECTION_SWITCHES: { id: string; label: string }[] = [
  { id: "continuity", label: "Agent-loop preamble" },
  { id: "env", label: "Environment" },
  { id: "trust", label: "Trust and refusals" },
  { id: "default_rules", label: "Default rules" },
  { id: "project_instructions", label: "Project instructions (AGENTS.md)" },
  { id: "skills", label: "Skills catalog" },
  { id: "memory", label: "Memories" },
  { id: "plan_offer", label: "Planning available" },
  { id: "repo_map", label: "Repository map" },
  { id: "knowledge", label: "Knowledge index" },
  { id: "project_context", label: "Project context" },
  { id: "tag_context", label: "Tag context" },
  { id: "leader", label: "Sub-agent roster" },
  { id: "rolling_context", label: "Rolling context" },
  { id: "study", label: "Study mode" },
  { id: "identity", label: "Multi-zone identity" },
  { id: "tool_descriptions", label: "Full tool descriptions" },
];

const FILE_TOOLS = ["file_system", "file_manage", "file_search", "shell_exec", "code_exec", "wsl_exec", "terminal"];

/**
 * Why leaving this section out can break the zone, or null when it is safe
 * to drop. A warning, not a lock: the user may know better.
 */
export function sectionWarning(id: string, tools: string[]): string | null {
  const has = (t: string) => tools.includes(t);
  switch (id) {
    case "continuity":
      return tools.length > 0
        ? "Tells the model it runs in a loop. Without it, models often stop after one tool call."
        : null;
    case "env":
      return FILE_TOOLS.some(has) ? "Says where paths resolve. File and shell tools guess without it." : null;
    case "skills":
      return has("skills") ? "load_skill only knows a skill exists from this list." : null;
    case "leader":
      return has("subchat") ? "How to delegate, and to whom. The sub-agent tools are offered without it." : null;
    // These follow the chat's own state; dropping them leaves a mode unexplained.
    case "rolling_context":
      return "Only sent while a chat rolls. Without it the model is not told to mark what matters.";
    case "study":
      return "Only sent in a study project. Without it answers are not held to the sources.";
    case "identity":
      return "Only sent with several zones in a chat. Without it a zone cannot tell who said what.";
    default:
      return null;
  }
}

/** A switch's value: the zone's, else the app default's, else on. */
export function isOn(id: string, zone: Switches, app: Switches): boolean {
  return zone[id] ?? app[id] ?? true;
}

/** The zone's switches from its tool config JSON. */
export function readSwitches(toolConfig: string): Switches {
  try {
    const v = JSON.parse(toolConfig || "{}").prompt_sections;
    return v && typeof v === "object" ? (v as Switches) : {};
  } catch {
    return {};
  }
}

/** The tool config with these switches; none at all removes the key. */
export function writeSwitches(toolConfig: string, switches: Switches): string {
  let obj: Record<string, unknown> = {};
  try { obj = JSON.parse(toolConfig || "{}"); } catch { /* start clean */ }
  if (Object.keys(switches).length > 0) obj.prompt_sections = switches;
  else delete obj.prompt_sections;
  return JSON.stringify(obj, null, 2);
}

/**
 * The lean preset: every section that is safe to drop for these tools off,
 * tool descriptions short, the load-bearing ones on.
 */
export function leanSwitches(tools: string[]): Switches {
  return Object.fromEntries(SECTION_SWITCHES.map((s) => [s.id, sectionWarning(s.id, tools) !== null]));
}

/** Whether these switches are the lean preset for these tools. */
export function isLean(zone: Switches, app: Switches, tools: string[]): boolean {
  const lean = leanSwitches(tools);
  return SECTION_SWITCHES.every((s) => isOn(s.id, zone, app) === lean[s.id]);
}
