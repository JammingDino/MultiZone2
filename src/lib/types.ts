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
  /**
   * Context compaction (0.9.3): the model's summary of this chat's older turns,
   * written by `compact_context`. Messages at or before `contextSummaryThrough`
   * are replaced by it in the history sent to the model — they are never deleted,
   * and the UI still shows the whole conversation.
   */
  contextSummary: string | null;
  contextSummaryThrough: number | null;
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
  | { type: "steer_delivered"; id: string; message: Message }
  | { type: "pending_cleared"; ids: string[] }
  | { type: "cancelled" }
  | { type: "done" }
  | { type: "error"; message: string };

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
  totalTokens: number;
}

/** Context carried by every chat in one sub-agent family. */
export interface SessionUsage {
  rootChatId: string;
  /** Root first, then descendants in creation order. */
  agents: AgentUsage[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
  maxToolSteps: number;
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
   * Web search provider used by all zones.
   * "duckduckgo" (default, no key required) | "searxng" (self-hosted) |
   * "brave" | "tavily" | "serper" (all key-based).
   * Legacy "multi"/"marginalia" values are migrated to "duckduckgo" on load.
   */
  webSearchProvider: string;
  /** SearXNG instance URL — only used when webSearchProvider is "searxng". */
  webSearchEndpoint: string;
  /** API key — only used for providers that require one (brave, tavily, serper). */
  webSearchApiKey: string;
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
  maxToolSteps: 30,
  pdfMode: "images",
  pdfExportDetail: "steps",
  pdfExportTheme: "app",
  exportSubchats: true,
  perspectiveMode: "parallel",
  perspectiveLayout: "stacked",
  webSearchProvider: "duckduckgo",
  webSearchEndpoint: "",
  webSearchApiKey: "",
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
  visionOverrides: {},
  onboardingSkipped: false,
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
  // `web_search` is superseded by `smart_search` — kept (hidden) only so zones
  // and chat history that still reference it resolve a label. Connect a search
  // MCP (e.g. Tavily) if you want a paid provider instead.
  { id: "web_search",   label: "Search the web (legacy)", category: "Web", safety: 1, hidden: true, description: "Legacy single-provider web search, replaced by the built-in multi-engine search. For a paid provider, connect a search MCP instead." },
  { id: "extract",      label: "Read a web page",     category: "Web", safety: 1, description: "Open one or more web pages and read them in full, not just the search snippet." },
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
];
