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
  temperature: number;
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
  createdAt: number;
  updatedAt: number;
}

export interface Chat {
  id: string;
  title: string;
  zoneId: string | null;
  projectId: string | null;
  projectContextEnabled: boolean;
  /** Per-chat opt-in for project knowledge (RAG); offers the search_knowledge tool. */
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
  createdAt: number;
  updatedAt: number;
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
  temperature: number;
  maxTokens: number | null;
  topP: number | null;
  /** JSON array string of tool ids. */
  toolsEnabled: string;
  /** JSON object string of per-tool config. */
  toolConfig: string;
  thinkingEnabled: boolean;
  includeThinkingInContext: boolean;
  description: string | null;
  /** Library-detail metadata (cosmetic). */
  author: string | null;
  source: string | null;
  version: string | null;
  examples: string[];
  /** True for shipped MultiZone presets; false for user imports/snapshots. */
  curatedTeam: boolean;
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
  createdAt: number;
  updatedAt: number;
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
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
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
  | { type: "tool_approval_required"; index: number; name: string; arguments: string }
  | { type: "tool_call_executing"; index: number; name: string }
  | { type: "tool_call_result"; index: number; name: string; result: string }
  | { type: "tool_message_saved"; message: Message }
  | { type: "assistant_saved"; message: Message }
  | { type: "cancelled" }
  | { type: "done" }
  | { type: "error"; message: string };

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
  /** Base font size for message text (px). */
  fontSize: number;
  /** Font family for message text. Empty string = Inter (default). */
  fontFamily: string;
  /** Fallback filesystem directory when a chat has no project with a directory set. */
  defaultDirectory: string;
  /**
   * Provider used for quick/simple chats that aren't bound to a zone. Its
   * `defaultModel` is what answers those chats. Null = use the oldest provider.
   */
  defaultProviderId: string | null;
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
   * How PDF files are processed when attached in the input bar.
   * "images" — render each page to a JPEG and send visually (default)
   * "text"   — extract text content from pages and send as text
   */
  pdfMode: "images" | "text";
  /**
   * Default execution mode for perspective zones (overridable per chat).
   * "sequential" — run one zone at a time (default; gentler on local model VRAM)
   * "parallel"   — run all perspective zones at once
   */
  perspectiveMode: "sequential" | "parallel";
  /**
   * How multiple model responses are laid out in the chat.
   * "stacked" — full-width response blocks stacked vertically (default)
   * "columns" — side-by-side columns for direct comparison
   */
  perspectiveLayout: "stacked" | "columns";
  /**
   * Web search provider used by all zones.
   * "multi" = DDG + Marginalia (default, no key required).
   */
  webSearchProvider: string;
  /** SearXNG instance URL — only used when webSearchProvider is "searxng". */
  webSearchEndpoint: string;
  /** API key — only used for providers that require one (brave, tavily, serper). */
  webSearchApiKey: string;
  /**
   * Zone used by Quick Chat as a fallback when no specific zone is chosen.
   * Null = legacy fallback: use defaultProviderId + its defaultModel.
   */
  baseZoneId: string | null;
  /** Soft cap on memory entries per scope; oldest are trimmed past this. */
  memoryScopeLimit: number;
  /** Set once the built-in skill templates have been seeded, so it never repeats. */
  seededSkills: boolean;
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
   * When true, new chats start with knowledge enabled (the search_knowledge tool
   * is offered from the first message). Projects can override this per-project.
   */
  knowledgeDefaultEnabled: boolean;
  /**
   * Maximum subchat nesting depth (0.5.1). A zone can spawn subagents up to this
   * many levels deep; deeper spawn_subagent calls are refused. Prevents runaway
   * recursion. Default 3.
   */
  subchatDepthLimit: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  sendKey: "enter",
  autoTitle: true,
  expandThinkingByDefault: false,
  fontSize: 14,
  fontFamily: "",
  defaultDirectory: "",
  defaultProviderId: null,
  seededStarterZones: false,
  seededLibrary: false,
  libraryCuratedVersion: 0,
  zoneLibraryPageSize: 6,
  apiEnabled: false,
  apiPort: 8765,
  apiToken: "",
  autoApproveLevel: "all",
  pdfMode: "images",
  perspectiveMode: "sequential",
  perspectiveLayout: "stacked",
  webSearchProvider: "multi",
  webSearchEndpoint: "",
  webSearchApiKey: "",
  baseZoneId: null,
  memoryScopeLimit: 50,
  seededSkills: false,
  ocrLanguage: "eng",
  autoReindex: true,
  knowledgeDefaultEnabled: false,
  subchatDepthLimit: 3,
};

export interface DbStats {
  chats: number;
  messages: number;
  zones: number;
  projects: number;
  tags: number;
}

/** 0 = safe, 1 = moderate, 2 = dangerous — mirrors the Rust backend. */
export type ToolSafety = 0 | 1 | 2;

export const ALL_TOOLS: { id: string; label: string; description: string; safety: ToolSafety }[] = [
  { id: "date_time",    label: "Date / time",      description: "Returns the current date and time.",                                                              safety: 0 },
  { id: "ask_user",     label: "Ask user",          description: "Lets the model pause and ask the user a clarifying question with answer buttons.",               safety: 0 },
  { id: "manage_tags",  label: "Tag chat",          description: "Lets the model create tags and assign them to the current chat to categorize it.",               safety: 0 },
  { id: "memory",       label: "Memory",            description: "Lets the model save, read, and delete long-term memories scoped to the chat, project, or globally.", safety: 0 },
  { id: "skills",       label: "Skills",            description: "Lets the model load specialized instruction sets on demand from your global Skills catalog.",       safety: 0 },
  { id: "render_graph", label: "Graph / diagram",   description: "Render Mermaid diagrams or math plots inline.",                                                  safety: 0 },
  { id: "web_search",   label: "Web search",        description: "Search the web via a configured provider.",                                                      safety: 1 },
  { id: "file_system",  label: "File system",       description: "Read, write, and list files within allowed paths.",                                              safety: 1 },
  { id: "switch_zone",  label: "Switch zone",       description: "Lets the model list zones and switch the chat to a different zone mid-conversation.",            safety: 1 },
  { id: "subchat",      label: "Subagents",         description: "Lets the model spawn subchats driven by other zones, send them messages, and read their transcripts (delegation).", safety: 1 },
  { id: "code_exec",    label: "Code execution",    description: "Run code snippets in a sandboxed subprocess (Python, Node, Bash, PowerShell).",                  safety: 2 },
  { id: "shell_exec",   label: "Shell / terminal",  description: "Run arbitrary shell commands in the chat's working directory (cmd, PowerShell, bash).",          safety: 2 },
];
