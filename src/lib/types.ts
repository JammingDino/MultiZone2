export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  /** Model used for quick/simple chats not bound to a zone. Null until set. */
  defaultModel: string | null;
  createdAt: number;
}

export interface Zone {
  id: string;
  name: string;
  providerId: string | null;
  model: string;
  systemPrompt: string | null;
  /** null = unset: the request omits it and the provider's own default applies. */
  temperature: number | null;
  maxTokens: number | null;
  topP: number | null;
  /** JSON-encoded array of tool IDs */
  toolsEnabled: string;
  /** JSON-encoded config object */
  toolConfig: string;
  thinkingEnabled: boolean;
  /** When false (the default), `<think>…</think>` blocks inside historical
   * assistant messages are stripped before being fed back to the model on
   * subsequent turns. Turn on if the model relies on its own chain-of-thought
   * being preserved across follow-ups. */
  includeThinkingInContext: boolean;
  /** Lucide icon name, e.g. "Brain". Null = default Bot icon. */
  icon: string | null;
  /** Hex accent color, e.g. "#3b82f6". Null = use global accent. */
  accentColor: string | null;
  /** Response Leader: a zone configured to coordinate sub-agents. Shown with a
   * dedicated indicator in the library/editor; gets the orchestration preamble. */
  isLeader: boolean;
  /**
   * This zone's approval overrides as a JSON `ApprovalPolicy` (0.14.2), or null
   * to inherit the global one. Stored as a string because the category set
   * grows with the tool set, and a column per category would be a migration per
   * tool group.
   */
  approvals: string | null;
  /**
   * Zone to answer with when this one's provider will not serve the request —
   * rate limited past its cooldown, host down, key rejected (0.14.1). Null for
   * none, which means such a failure ends the turn as it always did.
   */
  fallbackZoneId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Chat {
  id: string;
  title: string;
  zoneId: string | null;
  projectId: string | null;
  projectContextEnabled: boolean;
  /** Per-chat opt-in for project knowledge (RAG); offers the search_local_files tool. */
  knowledgeEnabled: boolean;
  /** Per-chat override for perspective execution; null = inherit global setting. */
  perspectiveMode: "sequential" | "parallel" | null;
  /** When true, the router picks the best zone per turn (Smart chat). */
  smartRouting: boolean;
  /** Set on chats created via "Branch from here" — the chat this forked from. */
  parentChatId: string | null;
  /** The parent message this branch was forked at. */
  branchedFromMessageId: string | null;
  /**
   * Set on subchats — the zone that spawned and drives this chat. A child chat
   * with this set is a subchat (vs. a branch, which sets branchedFromMessageId).
   * Subchats are observable but read-only from the user's perspective.
   */
  initiatedByZoneId: string | null;
  /**
   * Context compaction (0.9.3): the model's summary of this chat's older turns,
   * written by `compact_context`. Messages at or before `contextSummaryThrough`
   * are replaced by it in the history sent to the model — they are never deleted,
   * and the UI still shows the whole conversation.
   */
  contextSummary: string | null;
  contextSummaryThrough: number | null;
  /**
   * Plan mode (0.12.0). While on, every mutating tool is withheld from this
   * chat's requests — the model reads, asks, and proposes a plan the user edits
   * and approves. Either the user or the model can turn it on; only an approved
   * plan (or the user) turns it off.
   */
  planMode: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One step of a plan (0.12.0). */
export interface PlanStep {
  /** Stable across edits and reorders, so live status can find its step. */
  id: string;
  /** What is being done, in a few words. */
  step: string;
  /** Why — the sentence that makes the step reviewable rather than a label. */
  intent?: string | null;
  /** The files this step expects to touch, as the model named them. */
  files: string[];
  risk: "low" | "medium" | "high";
  status: "pending" | "in_progress" | "done" | "skipped" | "failed";
  note?: string | null;
  /** Why a failed step failed — kept so the failure is readable afterwards. */
  error?: string | null;
}

/**
 * A plan the model proposed and the user approves, edits or turns down
 * (0.12.0). `steps` is the raw JSON blob as stored; use `parsePlanSteps`.
 */
export interface Plan {
  id: string;
  chatId: string;
  /** The participant that authored it — a sub-agent, or null for the primary. */
  zoneId: string | null;
  parentPlanId: string | null;
  title: string;
  goal: string | null;
  /** JSON-encoded array of PlanStep. */
  steps: string;
  status: "draft" | "approved" | "executing" | "done" | "stopped" | "rejected" | "superseded";
  /** True when the user changed the steps before approving. */
  editedByUser: boolean;
  /** The user asked the run to finish the current step and stop (0.12.1). */
  stopRequested: boolean;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
}

/**
 * One row of the session event log (0.12.2) — the ordered record of what an
 * agent actually did, including the parts the transcript never held (an
 * approval declined, a zone switched mid-turn, a turn that died on an error).
 */
export interface SessionEvent {
  id: string;
  chatId: string;
  /** Groups every event of one turn, matching the checkpoints' turn id. */
  turnId: string | null;
  /** The participant — a sub-agent or perspective zone, null for the primary. */
  zoneId: string | null;
  kind: string;
  /** The line to show; written for a person at the time it happened. */
  label: string;
  /** JSON blob with whatever the kind carries. */
  detail: string | null;
  createdAt: number;
}

export function parsePlanSteps(plan: Pick<Plan, "steps">): PlanStep[] {
  try {
    const parsed = JSON.parse(plan.steps);
    return Array.isArray(parsed) ? (parsed as PlanStep[]) : [];
  } catch {
    return [];
  }
}

export interface Project {
  id: string;
  name: string;
  icon: string | null;
  accentColor: string | null;
  defaultZoneId: string | null;
  contextSnippet: string | null;
  /** Local filesystem directory the project is rooted at; scopes filesystem tools. */
  directory: string | null;
  /** When true, new chats in this project start with project context enabled. */
  defaultContextEnabled: boolean;
  /** Knowledge (RAG) embedding config, bound to the index. Provider+model define
   * the vector space; changing either forces a re-index. Null until configured. */
  kbProviderId: string | null;
  kbEmbeddingModel: string | null;
  kbDimensions: number | null;
  kbIndexedAt: number | null;
  /** Per-project override for the knowledge default in new chats. Null = inherit
   * the global `knowledgeDefaultEnabled` setting. */
  kbDefaultEnabled: boolean | null;
  createdAt: number;
  updatedAt: number;
}

/** A document in a project's knowledge index. */
export interface KbDocument {
  id: string;
  path: string;
  title: string;
  chunkCount: number;
  status: string;
  error: string | null;
  indexedAt: number;
}

export interface KnowledgeStatus {
  documentCount: number;
  chunkCount: number;
}

/** The default embedding config + global-KB index status (Settings → Knowledge). */
export interface GlobalKbView {
  providerId: string | null;
  embeddingModel: string | null;
  /** The app's default directory — the global KB's source. */
  directory: string | null;
  indexedAt: number | null;
  dimensions: number | null;
  documentCount: number;
  chunkCount: number;
}

/** Result of (re)indexing a project's directory. */
export interface IndexSummary {
  indexed: number;
  unchanged: number;
  removed: number;
  failed: number;
  totalChunks: number;
  dimensions: number | null;
  errors: string[];
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  contextSnippet: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A perspective zone assigned to a chat (beyond the primary zone). */
export interface ChatZone {
  chatId: string;
  zoneId: string;
}

/**
 * A node in a chat's sub-agent call tree (0.6.1 stack tracer). One per subchat
 * descended from the root chat. `zoneId` is the answering sub-agent;
 * `initiatedByZoneId` is the zone that spawned it; nesting is reconstructed via
 * `parentChatId`. `messageCount` is the subchat's user/assistant turn count.
 */
export interface SubchatNode {
  id: string;
  title: string;
  zoneId: string | null;
  initiatedByZoneId: string | null;
  parentChatId: string | null;
  messageCount: number;
  /** Turns of this subchat that loop detection stopped (0.14.1). */
  runawayCount: number;
  createdAt: number;
}

/**
 * A portable zone preset in the on-disk zone library. Provider/model are not
 * bound — installing resolves them from the user's settings. `curated` entries
 * ship with the app; the rest are user "Save to library" snapshots.
 */
export interface LibraryEntry {
  id: string;
  name: string;
  curated: boolean;
  icon: string | null;
  accentColor: string | null;
  model: string | null;
  systemPrompt: string | null;
  /** null = installs with no temperature set, so the provider's default applies. */
  temperature: number | null;
  maxTokens: number | null;
  topP: number | null;
  /** JSON array string of tool ids. */
  toolsEnabled: string;
  /** JSON object string of per-tool config. */
  toolConfig: string;
  thinkingEnabled: boolean;
  includeThinkingInContext: boolean;
  /** Response Leader preset — installs as a sub-agent-coordinating zone. */
  isLeader: boolean;
  description: string | null;
  /** Library-detail metadata (cosmetic). */
  author: string | null;
  source: string | null;
  version: string | null;
  examples: string[];
  /** True for shipped MultiZone presets; false for user imports/snapshots. */
  curatedTeam: boolean;
  /**
   * Name of the multi-zone team this preset belongs to, when it only works as
   * part of a set (a Response Leader plus its specialists). The library groups
   * these and installs them together. Null for a stand-alone zone.
   */
  team: string | null;
  createdAt: number;
}

/** Joined tag info + per-chat context toggle returned by get_chat_tags. */
export interface ChatTagEntry {
  tagId: string;
  name: string;
  color: string | null;
  contextSnippet: string | null;
  contextEnabled: boolean;
}

/** Flat chat↔tag link for the sidebar (all chats' tags in one fetch). */
export interface ChatTagLink {
  chatId: string;
  tagId: string;
  name: string;
  color: string | null;
}

/**
 * A global, on-demand instruction set (Anthropic Agent Skills model). Every
 * enabled skill's name + description is offered to agents that have the skills
 * tool; the agent loads `content` on demand via `load_skill`.
 */
export interface Skill {
  id: string;
  name: string;
  description: string | null;
  content: string;
  /** When true, the skill appears in the catalog offered to agents. */
  enabled: boolean;
  /**
   * Id of the zone that wrote this skill itself via `create_skill` (0.9.2), or
   * null when you wrote it. Self-authored skills arrive disabled and stay out of
   * every agent's catalog until reviewed and enabled.
   */
  authoredByZoneId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A folder-backed skill discovered on disk (0.9.9) — the multi-file format the
 * wider agent-skill ecosystem publishes in (Anthropic Agent Skills, impeccable,
 * HyperFrames): a directory with `SKILL.md` plus reference pages and scripts.
 *
 * Unlike a {@link Skill}, this is not a DB row and is not editable here: the
 * installer owns the tree and its own `update` command overwrites it. All the
 * app stores is whether it is switched on (`disabledSkillPacks` in settings).
 */
export interface SkillPack {
  name: string;
  description: string;
  /** Absolute path of the skill's own folder (the one holding SKILL.md). */
  dir: string;
  /** The scanned root it was found under. */
  root: string;
  /** Whether the folder holds more than SKILL.md. */
  multiFile: boolean;
  /**
   * Files in the tree. Only filled by `listSkillPacks` (counting means walking
   * the folder, which is skipped on the per-message catalog path).
   */
  fileCount: number | null;
  enabled: boolean;
}

/** A registered MCP (Model Context Protocol) server. */
export interface McpServer {
  id: string;
  name: string;
  /** "stdio" (spawn a command) or "sse" (connect to a URL). */
  transport: "stdio" | "sse";
  /** stdio: command line to run. */
  command: string | null;
  /** sse: endpoint URL. */
  url: string | null;
  /** stdio: JSON object string of env vars. */
  env: string | null;
  /** sse/http: JSON object string of headers — where `Authorization` lives. */
  headers: string | null;
  /** The catalog entry this was installed from, if it wasn't typed in by hand. */
  catalogId: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One value a connector needs from the user: an env var or an HTTP header. */
export interface ConnectorField {
  key: string;
  label: string;
  description?: string | null;
  /** The page this value comes from — the most useful line in the form. */
  credentialUrl?: string | null;
  required?: boolean;
  secret?: boolean;
  /** `Bearer {value}` — the user pastes a token, not a header. */
  template?: string | null;
  default?: string | null;
}

/** A curated MCP server: everything but the credential. */
export interface ConnectorEntry {
  id: string;
  name: string;
  description: string;
  category?: string | null;
  transport: "stdio" | "sse";
  command?: string | null;
  url?: string | null;
  env?: ConnectorField[];
  headers?: ConnectorField[];
  prerequisites?: string[];
  docsUrl?: string | null;
  /** Shipped with the app, so it cannot be deleted — only overridden. */
  curated?: boolean;
  source?: string | null;
}

export interface ConnectorCatalog {
  entries: ConnectorEntry[];
  /** catalogId → the id of the server installed from it. */
  installed: Record<string, string>;
}

/** One question a diagnosis answered. */
export interface McpCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Why a server isn't working — the first failing check, and what to do. */
export interface McpDiagnosis {
  serverId: string;
  ok: boolean;
  summary: string;
  checks: McpCheck[];
  nextStep?: string | null;
  docsUrl?: string | null;
}

/** A tool advertised by an MCP server, with a user-assigned danger level. */
export interface McpTool {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  /** JSON-schema string for the tool's input. */
  inputSchema: string | null;
  /** 0 safe / 1 moderate / 2 dangerous. */
  dangerLevel: number;
  createdAt: number;
  updatedAt: number;
}

/** Runtime connection status for an MCP server (not persisted). */
export interface McpServerStatus {
  /** "connected" | "error" | "disconnected" */
  state: "connected" | "error" | "disconnected";
  error?: string;
}

/** A server plus its persisted tools and live status — Settings → MCP shape. */
export interface McpServerView extends McpServer {
  tools: McpTool[];
  status: McpServerStatus;
}

/**
 * The per-zone enable id for an MCP tool: `mcp__<shortServerId>__<tool>`, where
 * shortServerId is the first 8 hex chars of the server's UUID (dashes stripped).
 * Mirrors the Rust `mcp::qualified_name`.
 */
export function mcpToolEnableId(serverId: string, toolName: string): string {
  const short = serverId.replace(/-/g, "").slice(0, 8);
  return `mcp__${short}__${toolName}`;
}

/** A model-managed long-term memory entry. */
export interface Memory {
  id: string;
  /** "global" | "project" | "chat" */
  scope: "global" | "project" | "chat";
  /** Owning project/chat id; null for global. */
  scopeId: string | null;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export type Role = "user" | "assistant" | "tool" | "system";

export interface Message {
  id: string;
  chatId: string;
  role: Role;
  /** JSON-encoded ContentPart[] */
  content: string;
  /** JSON-encoded ToolCall[] */
  toolCalls: string | null;
  toolCallId: string | null;
  /** Raw reasoning text from the model, if any. */
  reasoning: string | null;
  /** Set for perspective assistant messages; null for primary conversation messages. */
  zoneId: string | null;
  /** Zone that answered this primary assistant turn. Null for user/tool messages. */
  activeZoneId: string | null;
  /** True when the user hand-edited this message's content after it was saved. */
  edited: boolean;
  createdAt: number;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "hidden_text"; text: string }
  | { type: "hidden_image"; image_url: { url: string; detail?: string } };

export interface ToolCall {
  id: string;
  callType: string;
  function: { name: string; arguments: string };
}

export interface Attachment {
  id: string;
  messageId: string | null;
  chatId: string | null;
  fileName: string;
  fileType: "image" | "pdf" | "text" | "other";
  storagePath: string;
  content: string | null;
  pageCount: number | null;
  createdAt: number;
}

export type InputPart =
  | { type: "text"; text: string }
  | { type: "image"; data_url: string }
  | { type: "hidden_text"; text: string }
  | { type: "hidden_image"; data_url: string };

/**
 * What kind of work a tool does, from the user's point of view — a different
 * axis from how dangerous it is (0.14.2). `delete_file` and `run_command` are
 * both dangerous and belong in different categories: letting an agent edit a
 * repo is not agreeing to let it run anything.
 */
export type ApprovalCategory =
  | "read"
  | "edit"
  | "shell"
  | "web"
  | "mcp"
  | "spawn"
  | "state";

/**
 * An approval policy, global or per zone. Every field optional-by-omission:
 * a category that is absent inherits, and a zone's lists are added to the
 * global ones rather than replacing them — a deny list that can be dropped by
 * configuring something else is not a deny list.
 */
export interface ApprovalPolicy {
  /** true = auto-approve, false = always ask, absent = inherit. */
  categories: Partial<Record<ApprovalCategory, boolean>>;
  /** Command prefixes that run without asking. */
  shellAllow: string[];
  /** Command prefixes that are refused outright. */
  shellDeny: string[];
}

/** Stream event payloads emitted by the backend over the `stream` event. */
export type StreamEvent =
  | { type: "user_message_saved"; message: Message }
  | { type: "assistant_start"; messageId: string }
  | { type: "token"; delta: string }
  | { type: "thinking_token"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args_delta"; index: number; delta: string }
  | { type: "routing_started" }
  | { type: "routing_done"; zoneId: string; zoneName: string }
  | { type: "tool_approval_required"; index: number; name: string; arguments: string; diff: FileDiff | null }
  | { type: "tool_call_executing"; index: number; name: string }
  | { type: "tool_call_result"; index: number; name: string; result: string }
  | { type: "tool_message_saved"; message: Message }
  | { type: "assistant_saved"; message: Message }
  | { type: "steer_delivered"; id: string; message: Message }
  | { type: "pending_cleared"; ids: string[] }
  | { type: "cancelled" }
  /** Loop detection stopped the run (0.14.1); one tool-free step still follows. */
  | { type: "runaway"; kind: "repeat" | "stuck_error" | "oscillation"; label: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** One labelled component of a chat's fixed per-turn cost. */
export interface OverheadPart {
  label: string;
  tokens: number;
}

/** One chat's share of a sub-agent session's context (see commands::usage). */
export interface AgentUsage {
  chatId: string;
  title: string;
  zoneName: string | null;
  isCurrent: boolean;
  /** Subchat levels below the session root; 0 for the root itself. */
  depth: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  /** Conversation only. */
  messageTokens: number;
  /** System prompt: zone prompt, skills catalog, memories, project/tag context. */
  systemTokens: number;
  /** Tool schemas sent alongside it. */
  toolsTokens: number;
  toolCount: number;
  /** systemTokens + toolsTokens — what a turn costs before anyone speaks. */
  overheadTokens: number;
  /** The system prompt by what put each piece there, largest first. */
  overheadParts: OverheadPart[];
  totalTokens: number;
  /** What this chat has actually sent, measured on the requests themselves. */
  spent: SpentUsage;
}

/**
 * Tokens actually sent and received, accumulated one request at a time.
 *
 * Not the same quantity as the context figures above, and the difference is
 * large: every step of an agentic turn re-sends the whole context, so a chat
 * carrying 50k over ten steps has spent 500k. The context number answers "will
 * this fit in the window"; this one answers "what did it cost".
 */
export interface SpentUsage {
  /** API calls, not turns — one turn is many. */
  requests: number;
  /** How many of those carried the provider's own counts rather than our
   *  estimate. Below `requests` means the totals are partly estimated. */
  reportedRequests: number;
  inputTokens: number;
  /** Of `inputTokens`, the part served from the provider's prompt cache, which
   *  bills at a fraction of the rate. */
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** The most recent request's size — what the next one will carry. */
  lastInputTokens: number;
}

/**
 * Everything the app has ever sent, across every chat.
 *
 * Session spend answers "what is this conversation costing"; this answers "what
 * has all of it cost", which is the question the provider's monthly bill asks
 * and which no per-chat figure could be added up into by hand. Counted from the
 * request ledger, so a deleted chat's spend stays in the total.
 *
 * A standing figure about the install rather than about a conversation, so it
 * lives in Settings → Data, not in the chat header's context meter.
 */
export interface LifetimeUsage {
  /** Chats that have ever sent a request, including since-deleted ones. */
  chats: number;
  spent: SpentUsage;
}

/** Context carried by every chat in one sub-agent family. */
export interface SessionUsage {
  rootChatId: string;
  /** Root first, then descendants in creation order. */
  agents: AgentUsage[];
  inputTokens: number;
  outputTokens: number;
  overheadTokens: number;
  totalTokens: number;
  /** Every member's spend added up — the figure a provider's dashboard shows. */
  spent: SpentUsage;
}

/** How a message queued mid-turn reaches the model (see commands::pending). */
export type PendingMode = "steer" | "next";

/** A message the user sent while a turn was still running, not yet delivered. */
export interface PendingMessage {
  id: string;
  text: string;
  mode: PendingMode;
}

export interface StreamEnvelope {
  chatId: string;
  /** Present when this event belongs to a perspective zone's stream. */
  perspectiveZoneId?: string;
  event: StreamEvent;
}

export interface AppSettings {
  /** Which key combination triggers a send. */
  sendKey: "enter" | "ctrl_enter";
  /** Automatically generate a chat title after the first assistant response. */
  autoTitle: boolean;
  /** Start thinking/reasoning blocks expanded instead of collapsed. */
  expandThinkingByDefault: boolean;
  /**
   * Collapse a turn's thinking and tool steps into a single compact activity
   * rail instead of stacking one card per step. The rail names whatever the
   * model is doing right now ("Reading file · notes.md") and expands to the
   * full per-step cards on click. Results people actually asked for — plans,
   * diagrams, plots, presented files, questions — are lifted out of the rail
   * and stay visible either way. On by default: the step-by-step trace is a
   * power-user view, not the answer.
   */
  compactSteps: boolean;
  /** Base font size for message text (px). */
  fontSize: number;
  /**
   * Base font size for the interface itself (px, default 16). Sets the root
   * font size, so every rem-based size in the UI — text and spacing — scales
   * with it.
   */
  uiFontSize: number;
  /** When true, the interface size follows the message size. */
  fontSizeLinked: boolean;
  /** Font family for message text. Empty string = Inter (default). */
  fontFamily: string;
  /**
   * Fallback filesystem directory when a chat has no project with a directory
   * set. Defaulted to the OS Downloads folder on first run (see App.tsx) so the
   * file tools work out of the box; machine-local, so never exported.
   */
  defaultDirectory: string;
  /** Set once the one-time starter-zone seeding has run, so it never repeats. */
  seededStarterZones: boolean;
  /** Set once the curated zone library has been written to disk, so it never repeats. */
  seededLibrary: boolean;
  /** Highest curated-library version seeded to disk; re-seeds when the shipped set grows. */
  libraryCuratedVersion: number;
  /** Zone-library cards shown per page. One of 6 / 9 / 12 / 15 / 30. */
  zoneLibraryPageSize: number;
  /** When true, the embedded local HTTP API server runs. */
  apiEnabled: boolean;
  /** Port the API server binds to on 127.0.0.1. */
  apiPort: number;
  /** Bearer token required by the API server. */
  apiToken: string;
  /**
   * Which tool safety classes are auto-approved without showing an approval prompt.
   * "all"           — approve everything (default, preserves old behavior)
   * "safe_moderate" — auto-approve safe (0) and moderate (1); prompt for dangerous (2)
   * "safe"          — auto-approve safe (0) only
   * "none"          — prompt for every tool call
   */
  autoApproveLevel: "none" | "safe" | "safe_moderate" | "all";
  /**
   * How many tool steps one turn may take before the model is forced to give a
   * final answer (0.9.6). A step is one assistant message, which can carry
   * several parallel tool calls — so this is far more than N tool calls.
   *
   * The last two steps of the budget are spent finishing: the model is warned
   * it is running out, then called once with tools switched off. Raising this
   * lets longer tasks complete in a single turn; lowering it caps how long a
   * runaway model can churn before it has to report back. Clamped to 4–200.
   */
  /**
   * Per-category approval policy (0.14.2), which is the axis
   * `autoApproveLevel` above could never express: "how dangerous is this tool"
   * and "do I want to be asked about this kind of work" are different
   * questions. A category left out falls back to the slider, so an install that
   * never opens this panel behaves exactly as it did.
   *
   * `shellAllow` / `shellDeny` are command prefixes, longest match wins — so
   * "allow `git`, deny `git push`" resolves the way it reads. A deny is a
   * refusal rather than a prompt: writing the rule down *is* the answer.
   */
  approvals: ApprovalPolicy;
  maxToolSteps: number;
  /**
   * Ceiling on the billed tokens one session — a chat plus every sub-agent
   * under it — may spend before the run is stopped and made to report (0.14.1).
   *
   * `0` (the default) is no limit. Off by default because the usual case here is
   * a model on the same machine, where a long session costs time rather than
   * money; the cap is for the case where a panel is spending someone's budget
   * unattended. Checked at step boundaries, never mid-call.
   */
  maxSessionTokens: number;
  /**
   * How PDF files are processed when attached in the input bar.
   * "images" — render each page to a JPEG and send visually (default)
   * "text"   — extract text content from pages and send as text
   */
  pdfMode: "images" | "text";
  /**
   * How much of the run a chat's PDF export spells out (1.0).
   * "steps" — a card per tool call and reasoning block (the full trace)
   * "rails" — each run of steps condensed to one line, as the chat does with
   *           compact steps on; plans, diagrams, plots and files still drawn
   * "text"  — the conversation only: questions, attachments, answers
   */
  pdfExportDetail: "steps" | "rails" | "text";
  /**
   * Theme the PDF export is drawn in (1.0). "app" follows the interface; the
   * other two override it, for someone who works in dark mode but documents in
   * light (or the reverse).
   */
  pdfExportTheme: "app" | "dark" | "light";
  /**
   * Whether a chat's PDF export closes with the session log — the run as it was
   * *recorded*: every turn started and finished, every tool run, the approvals
   * declined, the failures the prose never mentions.
   *
   * Off by default (0.13.4). It is evidence rather than reading, and on a long
   * run it is a table of hundreds of rows appended to a document usually being
   * exported for someone who wants the conversation. Turn it on when the export
   * is a record — a bug report, an audit, showing what an agent actually did.
   *
   * PDF only: the Markdown export keeps its own log section, since a markdown
   * file is far more often the machine-readable copy.
   */
  pdfExportSessionLog: boolean;
  /**
   * Whether a chat export folds in the sub-agent conversations the run spawned
   * (0.9.11), nested under the turns that started them and labelled as
   * agent-to-agent throughout.
   *
   * On by default: in a Multizone run the delegated conversations *are* the
   * work, and an export without them reads as if the leader's answer arrived
   * from nowhere. Worth turning off when handing a transcript to someone who
   * only wants the conversation they were part of — a seven-zone run can carry
   * far more sub-agent text than primary text.
   *
   * Applies to both the Markdown and PDF exports.
   */
  exportSubchats: boolean;
  /**
   * Default execution mode for perspective zones (overridable per chat).
   * "parallel"   — run all perspective zones at once (default; how most people
   *                use several models — ask once, compare the answers together)
   * "sequential" — run one zone at a time; gentler on local model VRAM
   */
  perspectiveMode: "sequential" | "parallel";
  /**
   * How multiple model responses are laid out in the chat.
   * "stacked" — full-width response blocks stacked vertically (default)
   * "columns" — side-by-side columns for direct comparison
   */
  perspectiveLayout: "stacked" | "columns";
  /**
  /**
   * The zone that answers a Quick Chat — the app-wide default assistant, and
   * the single answer to "what runs when no zone is chosen?" (0.9.9; the old
   * `defaultProviderId` setting sat one rung under this asking the same thing).
   * Null = no zone: the first provider's `defaultModel` answers, with no system
   * prompt and only the safe tools. See `resolveBaseProvider`.
   */
  baseZoneId: string | null;
  /** Soft cap on memory entries per scope; oldest are trimmed past this. */
  memoryScopeLimit: number;
  /** Set once the built-in skill templates have been seeded, so it never repeats. */
  seededSkills: boolean;
  /**
   * Highest version of the built-in skill set this install has seeded. When the
   * shipped set grows, this falls behind `SKILL_SEED_VERSION` and the missing
   * ones are created — matched by name, so edited or deleted originals are not
   * disturbed. Mirrors `libraryCuratedVersion`, which does the same job for the
   * curated zone library.
   */
  seededSkillsVersion: number;
  /**
   * Extra folders scanned for folder-backed skills, on top of the app's managed
   * skills folder (0.9.9). Point one at a repo that already ran an installer
   * (`npx impeccable install`) and its packs are picked up in place — each root
   * is checked for `<name>/SKILL.md`, `skills/<name>/SKILL.md`, and the harness
   * layouts (`.claude/skills/<name>/`, `.agents/skills/<name>/`, …).
   */
  skillPackDirs: string[];
  /**
   * Names of discovered skill packs the user has switched off. Packs default to
   * enabled — installing one into a scanned folder is the deliberate act, so a
   * second opt-in would just be a step to forget.
   */
  disabledSkillPacks: string[];
  /**
   * OCR language hint used when falling back to text extraction for
   * vision-incapable models (0.4.0). Tesseract-style 3-letter code, e.g. "eng".
   */
  ocrLanguage: string;
  /**
   * When true (default), indexed knowledge directories are watched on disk and
   * re-indexed automatically as files change (0.4.3 live auto re-index).
   */
  autoReindex: boolean;
  /**
   * When true, new chats start with knowledge enabled (the search_local_files tool
   * is offered from the first message). Projects can override this per-project.
   */
  knowledgeDefaultEnabled: boolean;
  /**
   * Maximum subchat nesting depth (0.5.1). A zone can spawn subagents up to this
   * many levels deep; deeper spawn_subagent calls are refused. Prevents runaway
   * recursion. Default 3.
   */
  subchatDepthLimit: number;
  /**
   * When true (0.9.12), the context meter also reports the whole sub-agent
   * session's context — the leader plus every subchat under it — beside the
   * open chat's own. Only ever shown when the chat actually has sub-agents, so
   * turning it off only matters to people running teams.
   */
  teamContextMeter: boolean;
  /**
   * When true (0.7.2), every chat is mirrored to a `.md` file under
   * `markdownMirrorDir` and kept in sync on each message save, with zone
   * configs written as JSON in a `zones/` subdirectory alongside.
   */
  markdownMirrorEnabled: boolean;
  /** Output directory for the markdown mirror. Empty = unset (mirror is a no-op). */
  markdownMirrorDir: string;
  /**
   * Checkpoint retention (0.10.0). The store grows on every turn that writes a
   * file and nothing ever took anything away, so both limits ship with a real
   * value rather than "keep forever". `0` on either means no limit; the newest
   * checkpoint is never pruned whatever these say, so the turn that just ran is
   * always revertible.
   */
  checkpointRetentionDays: number;
  /**
   * Review before apply (0.10.2). When on, a zone's `create_file` / `edit_file`
   * writes stage in a review queue instead of landing, and the user applies the
   * batch after reading it. Reads are served the staged version, so an agent
   * editing one file repeatedly works against its own last version rather than
   * silently against the stale disk.
   */
  reviewQueue: boolean;
  /** Size ceiling for the checkpoint store, in MB. 0 = no ceiling. */
  checkpointMaxMb: number;
  /**
   * Per-model manual override for image input (0.7.4), keyed by exact model
   * name. "on" = always send images, "off" = always OCR to text. Models absent
   * from the map use the automatic name heuristic (lib/vision.ts).
   */
  visionOverrides: Record<string, "on" | "off">;
  /**
   * Dictation input (0.8.0). The id of one of this app's own `Provider` rows —
   * the same providers zones already point at — so any provider exposing an
   * OpenAI-compatible transcription endpoint (OpenAI itself, or a local server
   * like LM Studio serving a whisper model) works the same way. There's no
   * fixed vendor list. Null = no dictation provider configured yet; the mic
   * prompts the user to pick one in Settings → Voice.
   */
  sttProviderId: string | null;
  /** Model name requested from sttProviderId (e.g. "whisper-1"). */
  sttModel: string;
  /** BCP-47-ish language code (e.g. "en"), or "" for auto-detect. */
  sttLanguage: string;
  /** Remembered input device by name; null = system default. */
  sttInputDevice: string | null;
  /** "hold" = push-to-talk (mic button must be held); "toggle" = click to start/stop. */
  sttActivationMode: "hold" | "toggle";
  /** Where the committed transcript goes relative to the textarea's content. */
  sttInsertionMode: "cursor" | "replace";
  /** Auto-send the message after this many ms of sustained silence while dictating; 0 = off. */
  sttAutoSendSilenceMs: number;
  /**
   * Live partials (0.11.5): re-transcribe the recording so far every this many
   * ms while the user is still speaking, so words appear as they are said.
   * 0 = off (the default), because each pass is a full request to the provider
   * — cheap and private against a local server, billable against a hosted one.
   */
  sttLivePartialMs: number;
  /**
   * Audio upload → auto-transcribe (0.12.0). Dropping an audio file into a
   * composer transcribes it through the same STT provider dictation uses, which
   * is what lets a text-only model receive spoken input: the model sees text, so
   * it never needs an audio channel of its own.
   *
   * "quick" injects the transcript the moment it arrives. "review" holds it in
   * the chip for the user to read and correct first — worth the extra step for a
   * recording that matters, wrong as a default for a ten-second voice note.
   */
  sttUploadMode: "quick" | "review";
  /**
   * Where a finished transcript goes. "message" makes it the user's own text in
   * the composer, ready to edit or send. "context" keeps it as an attachment —
   * the model gets the full transcript as hidden context while the composer stays
   * free for the actual instruction ("summarise this meeting"), which is the only
   * workable shape for an hour-long recording.
   *
   * There is no "system message" option because MultiZone has no per-turn system
   * message to inject into — system prompts belong to a zone. "context" is the
   * same effect: content the model reads, not presented as the user's utterance.
   */
  sttUploadInjection: "message" | "context";
  /**
   * Ask the endpoint for `verbose_json` and prepend a header carrying duration,
   * detected language and per-segment timestamps. Off by default: most turns
   * don't want it, and some OpenAI-compatible shims only implement plain JSON.
   */
  sttUploadMetadata: boolean;
  /** Refuse audio uploads larger than this many MB. OpenAI's own ceiling is 25. */
  sttUploadMaxMb: number;
  /** Refuse audio longer than this many minutes; 0 = no duration limit. */
  sttUploadMaxMinutes: number;
  /**
   * Text-to-speech (0.8.1). The id of one of this app's `Provider` rows — the
   * same providers zones point at — so any provider exposing an
   * OpenAI-compatible `/audio/speech` endpoint (OpenAI, or a local server)
   * works. Null = no speech provider configured yet.
   */
  ttsProviderId: string | null;
  /** Model name requested from ttsProviderId (e.g. "tts-1"). */
  ttsModel: string;
  /** Default voice name (e.g. "alloy"). Zones may override per-zone. */
  ttsVoice: string;
  /** Playback speed multiplier passed to the endpoint (0.25–4.0). */
  ttsRate: number;
  /** Condense long responses via the LLM before speaking them. */
  ttsAutoSummarize: boolean;
  /** Character count above which auto-summarize kicks in (when enabled). */
  ttsSummarizeThreshold: number;
  /** Automatically speak assistant responses as they stream in. */
  ttsAutoSpeak: boolean;
  /**
   * How many sentences to synthesize in parallel ahead of playback (1–8). Higher
   * values start later clips sooner (less gap between sentences) at the cost of
   * more concurrent requests to the provider.
   */
  ttsPrefetch: number;
  /**
   * Whether the selected speech provider supports voice cloning via an
   * OpenAI-shim `/audio/voices` upload endpoint (e.g. a local F5-TTS server).
   * Gates the voice-cloning UI; most hosted providers (OpenAI) do not.
   */
  ttsSupportsCloning: boolean;
  /**
   * Hands-free conversation mode (0.8.2): after a spoken response finishes,
   * automatically start listening again so the user can reply by voice, chaining
   * STT → send → TTS → STT into a continuous loop.
   */
  voiceConversationEnabled: boolean;
  /**
   * Set when the user dismisses first-run setup without configuring a provider
   * (1.0). Onboarding is a helpful default, not a toll gate — someone who wants
   * to look around first, or who is about to drop in a settings export, gets to.
   * A standing banner offers both routes back until a provider exists, so the
   * app can't quietly sit in a state where nothing will ever send.
   *
   * Machine-local: it describes this install's first run, not a preference worth
   * carrying to another machine.
   */
  onboardingSkipped: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  sendKey: "enter",
  autoTitle: true,
  expandThinkingByDefault: false,
  compactSteps: true,
  fontSize: 14,
  uiFontSize: 16,
  fontSizeLinked: false,
  fontFamily: "",
  defaultDirectory: "",
  seededStarterZones: false,
  seededLibrary: false,
  libraryCuratedVersion: 0,
  zoneLibraryPageSize: 6,
  apiEnabled: false,
  apiPort: 8765,
  apiToken: "",
  autoApproveLevel: "all",
  approvals: { categories: {}, shellAllow: [], shellDeny: [] },
  maxToolSteps: 30,
  maxSessionTokens: 0,
  pdfMode: "images",
  pdfExportDetail: "steps",
  pdfExportTheme: "app",
  pdfExportSessionLog: false,
  exportSubchats: true,
  perspectiveMode: "parallel",
  perspectiveLayout: "stacked",
  baseZoneId: null,
  memoryScopeLimit: 50,
  seededSkills: false,
  seededSkillsVersion: 0,
  skillPackDirs: [],
  disabledSkillPacks: [],
  ocrLanguage: "eng",
  autoReindex: true,
  knowledgeDefaultEnabled: false,
  subchatDepthLimit: 3,
  teamContextMeter: true,
  markdownMirrorEnabled: false,
  markdownMirrorDir: "",
  checkpointRetentionDays: 30,
  reviewQueue: false,
  checkpointMaxMb: 512,
  visionOverrides: {},
  onboardingSkipped: false,
  sttProviderId: null,
  sttModel: "",
  sttLanguage: "",
  sttInputDevice: null,
  sttActivationMode: "toggle",
  sttInsertionMode: "cursor",
  sttAutoSendSilenceMs: 0,
  sttLivePartialMs: 0,
  sttUploadMode: "quick",
  sttUploadInjection: "message",
  sttUploadMetadata: false,
  sttUploadMaxMb: 25,
  sttUploadMaxMinutes: 120,
  ttsProviderId: null,
  ttsModel: "",
  ttsVoice: "",
  ttsRate: 1.0,
  ttsAutoSummarize: false,
  ttsSummarizeThreshold: 800,
  ttsAutoSpeak: false,
  ttsPrefetch: 3,
  ttsSupportsCloning: false,
  voiceConversationEnabled: false,
};

export interface DbStats {
  chats: number;
  messages: number;
  zones: number;
  projects: number;
  tags: number;
}

/** A microphone input device, from `cpal::Host::input_devices()` (0.8.0). */
export interface VoiceInputDevice {
  name: string;
  isDefault: boolean;
}

/** 0 = safe, 1 = moderate, 2 = dangerous — mirrors the Rust backend. */
export type ToolSafety = 0 | 1 | 2;

/**
 * One callable function inside a tool group, as reported by Rust (0.9.3). A group
 * (`file_system`) can expose several functions (`read_file`, `edit_file`, …), and
 * a per-zone description override is keyed by function name.
 */
export interface ToolFunctionInfo {
  /** The group id stored in a zone's `toolsEnabled`. */
  toolId: string;
  /** The function name the model calls. */
  name: string;
  /** The shipped description an override replaces. */
  description: string;
}

/**
 * Per-zone, per-tool call counters (0.9.3). Every tool in a zone's set costs
 * context on every turn, so these exist to show which ones actually earn it.
 */
export interface ToolUsage {
  zoneId: string;
  /** The function name the model called, e.g. "read_file". */
  toolName: string;
  calls: number;
  errors: number;
  lastUsedAt: number;
}

/** One path a checkpoint covers (0.10.1). */
export interface CheckpointFile {
  /** Absolute, normalised — the key a restore is addressed by. */
  path: string;
  /** The path as the assistant wrote it, which is what the user recognises. */
  displayPath: string;
  /** What the turn did: `created` · `changed` · `deleted`. */
  change: "created" | "changed" | "deleted";
  /** Set when the prior contents could not be captured, and why. */
  unstorable: string | null;
  /** The file has been edited since the assistant left it — restoring would
   *  discard that edit, so the UI says so before offering the button. */
  diverged: boolean;
}

/** A turn's worth of file changes, revertible as one (0.10.1). */
export interface Checkpoint {
  id: string;
  chatId: string;
  /** The assistant message the turn opened with — where the revert hangs. */
  messageId: string | null;
  /** The participant that did the mutating; null in a single-zone chat. */
  zoneId: string | null;
  createdAt: number;
  /** The tool that opened the checkpoint. */
  label: string | null;
  restoredAt: number | null;
  files: CheckpointFile[];
}

/** What a restore actually did to each path it was asked about. */
export interface RestoredFile {
  path: string;
  displayPath: string;
  /** `restored` · `deleted` · `unchanged` · `conflict` · `skipped`. */
  outcome: string;
  detail: string | null;
}

// ─── Review before apply (0.10.2) ────────────────────────────────────────────

/** One line of a diff. */
export interface DiffLine {
  kind: "context" | "add" | "remove";
  /** 1-based old-side line number; absent for an addition. */
  oldLine: number | null;
  /** 1-based new-side line number; absent for a removal. */
  newLine: number | null;
  text: string;
}

/** A run of changes plus its context — what a reviewer takes or leaves whole. */
export interface Hunk {
  index: number;
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  added: number;
  removed: number;
  lines: DiffLine[];
}

/** A proposed change to one path, as the approval prompt shows it. */
export interface FileDiff {
  path: string;
  displayPath: string;
  change: "create" | "modify" | "delete" | "rename";
  hunks: Hunk[];
  added: number;
  removed: number;
  /** Why there is no diff: binary, too large, or nothing changed. */
  note: string | null;
}

/** A change queued by review mode, waiting for the user to apply or discard. */
export interface StagedEdit {
  id: string;
  chatId: string;
  zoneId: string | null;
  path: string;
  displayPath: string;
  /** The tool that proposed it: `create_file` or `edit_file`. */
  tool: string;
  createdAt: number;
  /** The file changed on disk after this was queued — applying discards that. */
  diverged: boolean;
  diff: FileDiff;
}

/** What applying a queued change did. */
export interface ApplyOutcome {
  id: string;
  displayPath: string;
  outcome: "applied" | "conflict" | "failed";
  detail: string | null;
}

/**
 * What happened the last time the app tried to bind the API socket (0.11.0).
 * Persisted rather than reported once, so "enabled" and "actually listening"
 * stop being the same claim.
 */
export interface ApiBindState {
  ok: boolean;
  port: number;
  /** Why the bind failed, in the OS's own words. */
  error: string | null;
  at: number;
}

/** What the checkpoint store is holding, for Settings → Data (0.10.0). */
export interface CheckpointUsage {
  checkpoints: number;
  files: number;
  /** Bytes on disk, counting content shared between checkpoints once. */
  bytes: number;
  /** Creation time of the oldest checkpoint held; null when the store is empty. */
  oldestAt: number | null;
}

/** What a retention pass took away. */
export interface PruneOutcome {
  removedCheckpoints: number;
  removedBlobs: number;
  freedBytes: number;
}

export interface RestoreReport {
  checkpointId: string;
  files: RestoredFile[];
  /** The checkpoint taken of the restore itself, so undo is undoable. */
  undoCheckpointId: string | null;
}

/** The outcome of a rewind: what moved, and the mark it can be undone from. */
export interface RewindReport {
  /** Null when the rewind found nothing to undo, and so left no trace. */
  markId: string | null;
  reports: RestoreReport[];
}

/** Whether a chat has a rewind that can be walked forward again. */
export interface RewindStatus {
  canForward: boolean;
  /** Paths the forward step would put back. */
  forwardFiles: number;
  /** When the rewind that left this mark was taken. */
  forwardAt: number | null;
  /** The message it was taken at — the way forward is offered in the same place
   *  the user asked to go back. */
  forwardMessageId: string | null;
}

/** Groups the zone editor's tool list is sorted into, in display order (0.9.0). */
export const TOOL_CATEGORIES = ["Files", "Web", "Knowledge", "Agents", "System"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export interface ToolInfo {
  /** Machine id stored in a zone's `toolsEnabled`. Must match Rust's `ToolId::as_str`. */
  id: string;
  /** Human-facing name shown in the UI — never sent to the model. */
  label: string;
  description: string;
  safety: ToolSafety;
  category: ToolCategory;
  /** Deprecated tools kept only so existing zones/history still resolve their
   *  label. Hidden from the tool picker; never offered on new or edited zones. */
  hidden?: boolean;
}

/**
 * Every built-in tool a zone can enable. `label`/`description` are for the user;
 * the model sees the machine names and the descriptions written in the Rust tool
 * definitions. Renamed ids keep working via the alias map in Rust's
 * `ToolId::from_str`, so a zone saved before a rename still resolves.
 */
export const ALL_TOOLS: ToolInfo[] = [
  // Files
  { id: "file_system",  label: "Read & write files",  category: "Files", safety: 1, description: "Read a file, list a folder, create a file, and make targeted edits — within the project directory and any allowed paths." },
  { id: "file_search",  label: "Find files by name or contents", category: "Files", safety: 1, description: "Find files by name pattern, or search inside files for an exact word, string, or symbol. Exact search — the counterpart to the meaning-based search in Knowledge." },
  { id: "file_manage",  label: "Rename, move & delete files",    category: "Files", safety: 2, description: "Rename or move a file, copy it, create a folder, and delete files. Every delete asks for your approval." },
  { id: "present_file", label: "Show a file in the chat",        category: "Files", safety: 0, description: "Display a file the assistant has produced, inline in the conversation — HTML reports get a live preview with an open-in-browser button; other files get a card that opens them." },

  // Web
  // The single-provider `web_search` and the `extract` page reader were removed
  // at 1.0 — `smart_search` and `smart_fetch` below do the same jobs keylessly
  // and more reliably. Their ids still resolve (to the replacements) in the Rust
  // `ToolId::from_str`, so a zone that predates the change keeps its capability;
  // for a paid provider, connect a search MCP.
  // Hound-based searching tools — https://github.com/dondai1234/master-fetch
  { id: "smart_search", label: "Search the web",      category: "Web", safety: 1, description: "Search several independent engines at once (DuckDuckGo, Bing, Brave, Yandex, Ecosia, Yahoo, Wikipedia) and merge the results, so one engine being rate-limited doesn't come back empty. Keyless — no API key or paid service. For a paid provider like Tavily, connect a search MCP." },
  { id: "smart_fetch",  label: "Fetch a page or PDF", category: "Web", safety: 1, description: "Read one or more web pages or PDFs in full as clean markdown. Handles PDFs, and can focus a long page on a relevance query. HTTP-only — honest when a page needs JavaScript instead of returning it blank." },
  { id: "smart_crawl",  label: "Crawl a site",        category: "Web", safety: 1, description: "Follow links within one site and read several pages at once, visiting the most relevant first. Good for pulling a topic off a documentation site in a single call." },
  { id: "http_request", label: "Call an API",         category: "Web", safety: 2, description: "Make an HTTP request to any URL and get back the raw status, headers, and body — for talking to an API rather than reading a page. You approve each request, and can see the method, URL, and body first." },

  // Knowledge
  { id: "skills",       label: "Skills",              category: "Knowledge", safety: 0, description: "Load a set of instructions from your Skills catalog when a task calls for it, including the reference files of installed multi-file skills — and write a new skill when the assistant works out a procedure worth keeping (saved disabled for your review)." },
  { id: "memory",       label: "Remember things",     category: "Knowledge", safety: 0, description: "Save, read, and delete facts that persist across turns — scoped to this chat, this project, or everywhere." },
  { id: "compact",      label: "Condense a long chat", category: "Knowledge", safety: 1, description: "When a conversation grows long, let the assistant summarize the earlier turns so it keeps its thread instead of quietly losing the oldest messages. You still see the whole conversation — only what the model re-reads is condensed." },

  // Agents
  { id: "subchat",      label: "Delegate to other zones", category: "Agents", safety: 1, description: "Hand a task to another zone in its own subchat, exchange messages with it, and read the transcript — the basis of Multizone mode. Sub-agents can run in the background, so one leader can put a whole panel to work at once and keep going while they think." },
  { id: "teamwork",     label: "Work alongside other zones", category: "Agents", safety: 0, description: "Lets several zones edit one project at the same time without overwriting each other: each claims the files it is about to change, and posts decisions to a board every agent reads. A write to a file another agent has claimed is refused rather than silently clobbering it. Enable it on every member of a team." },
  { id: "plan",         label: "Plan a multi-step task",  category: "Agents", safety: 0, description: "Keep a visible checklist of the steps in a long task, ticking them off as it goes. Helps the assistant stay on track and shows you what it is doing." },
  { id: "ask_user",     label: "Ask you a question",      category: "Agents", safety: 0, description: "Pause and ask you a clarifying question, with answer buttons, instead of guessing." },
  { id: "switch_zone",  label: "Switch zone",             category: "Agents", safety: 1, description: "List your zones and switch this chat to a better-suited one mid-conversation." },

  // System
  { id: "render_graph", label: "Draw a chart or diagram",  category: "System", safety: 0, description: "Render a diagram or plot a maths function inline in the chat." },
  { id: "date_time",    label: "Check the date & time",    category: "System", safety: 0, description: "Look up the current date and time." },
  { id: "manage_tags",  label: "Tag this chat",            category: "System", safety: 0, description: "Create tags and apply them to this chat so it is easier to find later." },
  { id: "code_exec",    label: "Run code",                 category: "System", safety: 2, description: "Run a code snippet in a sandboxed subprocess (Python, Node, Bash, PowerShell)." },
  { id: "shell_exec",   label: "Run terminal commands",    category: "System", safety: 2, description: "Run any shell command in the chat's working directory. The most powerful and most dangerous tool here." },
  { id: "terminal",     label: "Keep terminals open",      category: "System", safety: 2, description: "Start terminals that keep running between messages — a dev server, a REPL, a log to follow — then read what they print and type into them, with control over the timing. Answers a prompt that appears part-way through, which a plain command cannot. Terminals stay open until stopped or until you close the app." },
  { id: "wsl_exec",     label: "Run Linux commands (WSL)", category: "System", safety: 2, description: "Run Linux commands in WSL. Each call is independent by default; the assistant can opt into a shell that persists for this chat, so working directory, environment and virtualenvs carry across steps. Requires WSL to be installed." },
  { id: "app_control",  label: "Change MultiZone itself",  category: "System", safety: 2, description: "Let the assistant read and change the app you are talking to it in — switch to dark mode, create a zone, add a provider, file a chat under a project, turn a skill on. It goes through the same API a script would use, so it can do what you can do in the app and no more. You approve every change; reading is free." },
];
