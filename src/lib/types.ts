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
  /** Response Leader: a zone configured to coordinate sub-agents. Shown with a
   * dedicated indicator in the library/editor; gets the orchestration preamble. */
  isLeader: boolean;
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
  temperature: number;
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
   * When true (0.7.2), every chat is mirrored to a `.md` file under
   * `markdownMirrorDir` and kept in sync on each message save, with zone
   * configs written as JSON in a `zones/` subdirectory alongside.
   */
  markdownMirrorEnabled: boolean;
  /** Output directory for the markdown mirror. Empty = unset (mirror is a no-op). */
  markdownMirrorDir: string;
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
  markdownMirrorEnabled: false,
  markdownMirrorDir: "",
  visionOverrides: {},
  sttProviderId: null,
  sttModel: "",
  sttLanguage: "",
  sttInputDevice: null,
  sttActivationMode: "toggle",
  sttInsertionMode: "cursor",
  sttAutoSendSilenceMs: 0,
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
  { id: "web_search",   label: "Search the web",      category: "Web", safety: 1, description: "Search the web through your configured search provider and read the result snippets." },
  { id: "extract",      label: "Read a web page",     category: "Web", safety: 1, description: "Open one or more web pages and read them in full, not just the search snippet." },
  { id: "http_request", label: "Call an API",         category: "Web", safety: 2, description: "Make an HTTP request to any URL and get back the raw status, headers, and body — for talking to an API rather than reading a page. You approve each request, and can see the method, URL, and body first." },

  // Knowledge
  { id: "skills",       label: "Skills",              category: "Knowledge", safety: 0, description: "Load a set of instructions from your Skills catalog when a task calls for it — and write a new skill when the assistant works out a procedure worth keeping (saved disabled for your review)." },
  { id: "memory",       label: "Remember things",     category: "Knowledge", safety: 0, description: "Save, read, and delete facts that persist across turns — scoped to this chat, this project, or everywhere." },

  // Agents
  { id: "subchat",      label: "Delegate to other zones", category: "Agents", safety: 1, description: "Hand a task to another zone in its own subchat, exchange messages with it, and read the transcript — the basis of Multizone mode." },
  { id: "plan",         label: "Plan a multi-step task",  category: "Agents", safety: 0, description: "Keep a visible checklist of the steps in a long task, ticking them off as it goes. Helps the assistant stay on track and shows you what it is doing." },
  { id: "ask_user",     label: "Ask you a question",      category: "Agents", safety: 0, description: "Pause and ask you a clarifying question, with answer buttons, instead of guessing." },
  { id: "switch_zone",  label: "Switch zone",             category: "Agents", safety: 1, description: "List your zones and switch this chat to a better-suited one mid-conversation." },

  // System
  { id: "render_graph", label: "Draw a chart or diagram",  category: "System", safety: 0, description: "Render a diagram or plot a maths function inline in the chat." },
  { id: "date_time",    label: "Check the date & time",    category: "System", safety: 0, description: "Look up the current date and time." },
  { id: "manage_tags",  label: "Tag this chat",            category: "System", safety: 0, description: "Create tags and apply them to this chat so it is easier to find later." },
  { id: "code_exec",    label: "Run code",                 category: "System", safety: 2, description: "Run a code snippet in a sandboxed subprocess (Python, Node, Bash, PowerShell)." },
  { id: "shell_exec",   label: "Run terminal commands",    category: "System", safety: 2, description: "Run any shell command in the chat's working directory. The most powerful and most dangerous tool here." },
];
