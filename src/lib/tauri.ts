import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PdfReadPage } from "@/lib/pdf";
import type {
  Attachment,
  Chat,
  ChatTagEntry,
  ChatTagLink,
  ChatZone,
  LibraryEntry,
  ApiBindState,
  ApplyOutcome,
  Checkpoint,
  CheckpointUsage,
  StagedEdit,
  PruneOutcome,
  RestoreReport,
  RewindReport,
  RewindStatus,
  SearchHit,
  ForkScope,
  McpResource,
  SavedRun,
  RunParam,
  RenderedRun,
  McpPrompt,
  DbStats,
  IndexSummary,
  InputPart,
  GlobalKbView,
  KbDocument,
  KnowledgeStatus,
  LifetimeUsage,
  ConnectorCatalog,
  ConnectorEntry,
  McpDiagnosis,
  McpServer,
  McpServerView,
  Memory,
  Plan,
  PlanStep,
  SessionEvent,
  Message,
  PendingMode,
  Project,
  Provider,
  SessionUsage,
  Skill,
  SkillPack,
  StreamEnvelope,
  SubchatNode,
  Tag,
  ToolFunctionInfo,
  ToolUsage,
  VoiceInputDevice,
  Zone,
} from "./types";

// Providers
export const listProviders = () => invoke<Provider[]>("list_providers");
export const upsertProvider = (provider: Partial<Provider> & { name: string; baseUrl: string }) =>
  invoke<Provider>("upsert_provider", { provider });
export const deleteProvider = (id: string) => invoke<void>("delete_provider", { id });
export const fetchModels = (providerId: string) =>
  invoke<string[]>("fetch_models", { providerId });

// Zones
export const listZones = () => invoke<Zone[]>("list_zones");
export const upsertZone = (zone: Partial<Zone> & { name: string; model: string }) =>
  invoke<Zone>("upsert_zone", { zone });
export const deleteZone = (id: string) => invoke<void>("delete_zone", { id });

// Chats
// MCP resources and prompts (0.15.3). The list calls answer with an empty array
// for a server that does not implement the method, which is most of them.
export const listMcpResources = (id: string) =>
  invoke<McpResource[]>("list_mcp_resources", { id });
export const readMcpResource = (id: string, uri: string) =>
  invoke<string>("read_mcp_resource", { id, uri });
export const listMcpPrompts = (id: string) =>
  invoke<McpPrompt[]>("list_mcp_prompts", { id });
export const getMcpPrompt = (id: string, name: string, args: Record<string, string> = {}) =>
  invoke<string>("get_mcp_prompt", { id, name, arguments: args });

// Saved parameterised runs (0.15.4).
export const listSavedRuns = () => invoke<SavedRun[]>("list_saved_runs");
export const upsertSavedRun = (run: {
  id?: string;
  name: string;
  description?: string | null;
  template: string;
  params?: RunParam[];
  zoneId?: string | null;
}) => invoke<SavedRun>("upsert_saved_run", { run });
export const deleteSavedRun = (id: string) => invoke<void>("delete_saved_run", { id });
export const renderSavedRun = (id: string, values: Record<string, string> = {}) =>
  invoke<RenderedRun>("render_saved_run", { id, values });

export const listChats = () => invoke<Chat[]>("list_chats");
/** Cross-chat message search (0.15.0). Safe to call on every keystroke. */
export const searchMessages = (query: string) =>
  invoke<SearchHit[]>("search_messages", { query });
export const createChat = (zoneId: string | null, projectId?: string | null) =>
  invoke<Chat>("create_chat", { zoneId, projectId: projectId ?? null });
export const renameChat = (id: string, title: string) =>
  invoke<void>("rename_chat", { id, title });
export const setChatZone = (id: string, zoneId: string | null) =>
  invoke<void>("set_chat_zone", { id, zoneId });
export const setChatSmart = (id: string, smart: boolean) =>
  invoke<void>("set_chat_smart", { id, smart });
/**
 * This session's own spend ceiling (0.14.4). `null` hands it back to the global
 * default; `0` means unmetered. Written to the session root, so setting it from
 * a sub-agent's chat still describes the whole session.
 */
export const setChatSpendLimit = (chatId: string, limit: number | null) =>
  invoke<void>("set_chat_spend_limit", { chatId, limit });
// Plan mode & plans (0.12.0)
export const setChatPlanMode = (chatId: string, on: boolean) =>
  invoke<void>("set_chat_plan_mode", { chatId, on });
export const listPlans = (chatId: string) =>
  invoke<Plan[]>("list_plans", { chatId });
export const pendingPlan = (chatId: string) =>
  invoke<Plan | null>("pending_plan", { chatId });
export const approvePlan = (planId: string, steps: PlanStep[] | null, edited: boolean) =>
  invoke<Plan>("approve_plan", { planId, steps, edited });
export const rejectPlan = (planId: string) =>
  invoke<void>("reject_plan", { planId });
export const updatePlanSteps = (planId: string, steps: PlanStep[]) =>
  invoke<Plan>("update_plan_steps", { planId, steps });
export const requestPlanStop = (planId: string) =>
  invoke<void>("request_plan_stop", { planId });
export const planTree = (chatId: string) =>
  invoke<Plan[]>("plan_tree", { chatId });
export const listSessionEvents = (chatId: string, limit?: number) =>
  invoke<SessionEvent[]>("list_session_events", { chatId, limit: limit ?? null });

export const setChatProject = (chatId: string, projectId: string | null) =>
  invoke<void>("set_chat_project", { chatId, projectId });
export const setChatProjectContext = (chatId: string, enabled: boolean) =>
  invoke<void>("set_chat_project_context", { chatId, enabled });
export const getChatTags = (chatId: string) =>
  invoke<ChatTagEntry[]>("get_chat_tags", { chatId });
export const getAllChatTags = () =>
  invoke<ChatTagLink[]>("get_all_chat_tags");
export const addChatTag = (chatId: string, tagId: string) =>
  invoke<void>("add_chat_tag", { chatId, tagId });
export const removeChatTag = (chatId: string, tagId: string) =>
  invoke<void>("remove_chat_tag", { chatId, tagId });
export const setChatTagContext = (chatId: string, tagId: string, enabled: boolean) =>
  invoke<void>("set_chat_tag_context", { chatId, tagId, enabled });
export const getChatZones = (chatId: string) =>
  invoke<ChatZone[]>("get_chat_zones", { chatId });
export const addPerspectiveZone = (chatId: string, zoneId: string) =>
  invoke<void>("add_perspective_zone", { chatId, zoneId });
export const removePerspectiveZone = (chatId: string, zoneId: string) =>
  invoke<void>("remove_perspective_zone", { chatId, zoneId });
export const setChatPerspectiveMode = (
  chatId: string,
  mode: "sequential" | "parallel" | null,
) => invoke<void>("set_chat_perspective_mode", { chatId, mode });
/** Multizone sub-agent roster: zones the leader may delegate to. */
export const getChatSubagents = (chatId: string) =>
  invoke<ChatZone[]>("get_chat_subagents", { chatId });
export const setChatSubagents = (chatId: string, zoneIds: string[]) =>
  invoke<void>("set_chat_subagents", { chatId, zoneIds });
/** The leader→sub-agent(→nested) call tree for a chat (0.6.1 stack tracer). */
export const getSubchatTree = (chatId: string) =>
  invoke<SubchatNode[]>("get_subchat_tree", { chatId });
export const deleteChat = (id: string) => invoke<void>("delete_chat", { id });
/**
 * Fork a chat at `messageId` into a new chat copying history up to that point.
 * `solo` follows a single participant out of a multi-responder chat: the branch
 * keeps every zone's answers in its history but continues with one responder —
 * `zoneId` for a perspective, or null to pin the chat's own primary zone.
 */
export const branchChat = (
  chatId: string,
  messageId: string,
  solo = false,
  zoneId: string | null = null,
  scope: ForkScope = "visible",
  standalone = false,
) => invoke<Chat>("branch_chat", { chatId, messageId, solo, zoneId, scope, standalone });

// Projects
export const listProjects = () => invoke<Project[]>("list_projects");
export const upsertProject = (project: Partial<Project> & { name: string }) =>
  invoke<Project>("upsert_project", { project });
/** Delete a project. `deleteChats` false (default) moves its chats to Ungrouped; true deletes them too. */
export const deleteProject = (id: string, deleteChats = false) =>
  invoke<void>("delete_project", { id, deleteChats });

// Knowledge (RAG) — project-scoped, sourced from the project directory.
export const setProjectKbConfig = (
  projectId: string,
  providerId: string | null,
  embeddingModel: string | null,
) =>
  invoke<Project>("set_project_kb_config", { projectId, providerId, embeddingModel });
export const indexProjectKnowledge = (projectId: string) =>
  invoke<IndexSummary>("index_project_knowledge", { projectId });
export const getKnowledgeStatus = (projectId: string) =>
  invoke<KnowledgeStatus>("get_knowledge_status", { projectId });
export const listKnowledgeDocuments = (projectId: string) =>
  invoke<KbDocument[]>("list_knowledge_documents", { projectId });
export const removeKnowledgeDocument = (documentId: string) =>
  invoke<void>("remove_knowledge_document", { documentId });
export const clearProjectKnowledge = (projectId: string) =>
  invoke<void>("clear_project_knowledge", { projectId });
export const setChatKnowledge = (chatId: string, enabled: boolean) =>
  invoke<void>("set_chat_knowledge", { chatId, enabled });
/** Per-project default for knowledge in new chats. null = inherit global. */
export const setProjectKbDefault = (projectId: string, enabled: boolean | null) =>
  invoke<Project>("set_project_kb_default", { projectId, enabled });

// Global knowledge base (app default directory) + default embedding config.
export const getGlobalKb = () => invoke<GlobalKbView>("get_global_kb");
export const setGlobalKbConfig = (
  providerId: string | null,
  embeddingModel: string | null,
) => invoke<GlobalKbView>("set_global_kb_config", { providerId, embeddingModel });
export const indexGlobalKnowledge = () =>
  invoke<IndexSummary>("index_global_knowledge");
export const listGlobalKbDocuments = () =>
  invoke<KbDocument[]>("list_global_kb_documents");
export const clearGlobalKnowledge = () => invoke<void>("clear_global_knowledge");

// Tags
export const listTags = () => invoke<Tag[]>("list_tags");
export const upsertTag = (tag: Partial<Tag> & { name: string }) =>
  invoke<Tag>("upsert_tag", { tag });
export const deleteTag = (id: string) => invoke<void>("delete_tag", { id });

/**
 * Every callable tool function, flattened out of the tool groups (0.9.3). A group
 * id like `file_system` exposes several functions (`read_file`, `edit_file`, …),
 * and a description override is per function — so the zone editor reads the list
 * from Rust rather than duplicating it, keeping one source of truth for what the
 * model actually sees.
 */
export const listToolFunctions = () => invoke<ToolFunctionInfo[]>("list_tool_functions");

/** Per-zone tool call counters (0.9.3). Omit `zoneId` for every zone. */
export const getToolUsage = (zoneId?: string) =>
  invoke<ToolUsage[]>("get_tool_usage", { zoneId: zoneId ?? null });
export const resetToolUsage = (zoneId?: string) =>
  invoke<void>("reset_tool_usage", { zoneId: zoneId ?? null });

/** Every turn in this chat that changed files, newest first (0.10.1). */
export const listCheckpoints = (chatId: string) =>
  invoke<Checkpoint[]>("list_checkpoints", { chatId });

/**
 * Put a checkpoint's paths back. `paths` restores a subset; `force` proceeds
 * past a file that changed after the assistant left it, which is otherwise
 * reported as a conflict and left exactly as found.
 */
export const restoreCheckpoint = (
  checkpointId: string,
  paths?: string[],
  force?: boolean,
) =>
  invoke<RestoreReport>("restore_checkpoint", {
    checkpointId,
    paths: paths ?? null,
    force: force ?? false,
  });

/**
 * The turns that changed files after this message — what rewinding to it would
 * undo. Read before offering the choice, so "branch from here" can say how many
 * turns and files are involved instead of asking in the abstract.
 */
export const checkpointsSinceMessage = (chatId: string, messageId: string) =>
  invoke<Checkpoint[]>("checkpoints_since_message", { chatId, messageId });

/**
 * Put the working tree back to how it stood at `messageId` — the file-side
 * counterpart to branching from a message. Restores newest-first; a file edited
 * outside the app is still reported as a conflict and left as found.
 */
export const restoreToMessage = (chatId: string, messageId: string, force?: boolean) =>
  invoke<RestoreReport[]>("restore_to_message", { chatId, messageId, force: force ?? false });

/**
 * Rewind the tree to how it stood at `messageId`, reversibly (1.1). Unlike
 * `restoreToMessage` it leaves a mark, so `rewindForward` can put the tree back
 * the way it was.
 */
export const rewindToMessage = (chatId: string, messageId: string, force?: boolean) =>
  invoke<RewindReport>("rewind_to_message", { chatId, messageId, force: force ?? false });

/** Walk the most recent rewind forward again. Null when there is none. */
export const rewindForward = (chatId: string, force?: boolean) =>
  invoke<RestoreReport | null>("rewind_forward", { chatId, force: force ?? false });

/** Whether this chat has a rewind that can be walked forward. */
export const rewindStatus = (chatId: string) =>
  invoke<RewindStatus>("rewind_status", { chatId });

/**
 * The last bind outcome — the same row `/api/health` reports, so the panel and
 * the API cannot tell different stories about whether the server is up.
 */
export const apiBindState = () => invoke<ApiBindState | null>("api_bind_state");

/** What the checkpoint store is holding, for Settings → Data (0.10.0). */
export const checkpointUsage = () => invoke<CheckpointUsage>("checkpoint_usage");

/**
 * Apply the configured retention limits now. The same prune that runs at
 * startup and after a turn that changed files — exposed as a button because a
 * user who has just lowered the ceiling wants the number to move now, not on
 * their next agentic turn.
 */
export const pruneCheckpoints = () => invoke<PruneOutcome>("prune_checkpoints");

/**
 * Estimated context carried by every chat in this chat's sub-agent session —
 * the session root plus every descendant subchat. Answers the same from
 * anywhere in the family, so the total doesn't depend on which pane is open.
 */
export const sessionContextUsage = (chatId: string) =>
  invoke<SessionUsage>("session_context_usage", { chatId });

/**
 * Every request this install has ever made, added up — including from chats
 * since deleted. A standing figure, shown in Settings → Data rather than beside
 * a live context meter, where it read as a fact about the current conversation.
 */
export const lifetimeTokenUsage = () => invoke<LifetimeUsage>("lifetime_token_usage");

// Skills (global, on-demand catalog)
export const listSkills = () => invoke<Skill[]>("list_skills");
export const upsertSkill = (skill: Partial<Skill> & { name: string }) =>
  invoke<Skill>("upsert_skill", { skill });
export const setSkillEnabled = (id: string, enabled: boolean) =>
  invoke<void>("set_skill_enabled", { id, enabled });
export const deleteSkill = (id: string) => invoke<void>("delete_skill", { id });

// Folder-backed skills installed on disk. Read-only here — an installer owns
// the tree; the app only discovers it and remembers which ones are switched on.
export const listSkillPacks = () => invoke<SkillPack[]>("list_skill_packs");
export const skillPacksRoot = () => invoke<string>("skill_packs_root");

// MCP (Model Context Protocol) servers + tools
export const listMcpServers = () => invoke<McpServerView[]>("list_mcp_servers");
export const upsertMcpServer = (server: {
  id?: string;
  name: string;
  transport: string;
  command?: string | null;
  url?: string | null;
  env?: string | null;
  headers?: string | null;
  catalogId?: string | null;
  enabled?: boolean;
}) => invoke<McpServer>("upsert_mcp_server", { server });
export const deleteMcpServer = (id: string) => invoke<void>("delete_mcp_server", { id });
export const connectMcpServer = (id: string) =>
  invoke<McpServerView>("connect_mcp_server", { id });
export const disconnectMcpServer = (id: string) =>
  invoke<void>("disconnect_mcp_server", { id });
export const setMcpToolDanger = (toolId: string, dangerLevel: number) =>
  invoke<void>("set_mcp_tool_danger", { toolId, dangerLevel });
/**
 * Emitted as each enabled server settles during the launch autostart (0.14.0).
 * Servers connect in parallel and a stdio one can take several seconds of npx,
 * so Settings → MCP subscribes rather than reading status once on mount — which
 * would otherwise show every row as "Disconnected" for as long as the window
 * happened to open before the servers came up.
 */
export function onMcpStatusChanged(
  handler: (e: { serverId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ serverId: string }>("mcp-status-changed", (e) => handler(e.payload));
}

// Connectors (0.11.2) — the catalog an MCP server is installed from, and the
// diagnosis for one that will not connect.
export const listConnectors = () => invoke<ConnectorCatalog>("list_connectors");
export const installConnector = (input: {
  entryId: string;
  values?: Record<string, string>;
  name?: string | null;
  commandSuffix?: string | null;
  replace?: boolean;
}) => invoke<McpServer>("install_connector", { input });
export const importConnectors = (input: { url?: string; json?: string }) =>
  invoke<ConnectorEntry[]>("import_connectors", { input });
export const deleteConnector = (entryId: string) =>
  invoke<void>("delete_connector", { entryId });
export const diagnoseMcpServer = (id: string) =>
  invoke<McpDiagnosis>("diagnose_mcp_server", { id });

// Memory
export const listMemories = () => invoke<Memory[]>("list_memories");
export const upsertMemory = (
  memory: Partial<Memory> & { scope: Memory["scope"]; content: string },
) => invoke<Memory>("upsert_memory", { memory });
export const deleteMemory = (id: string) => invoke<void>("delete_memory", { id });

// Zone library
export const listLibraryEntries = () => invoke<LibraryEntry[]>("list_library_entries");
export const upsertLibraryEntry = (entry: LibraryEntry) =>
  invoke<LibraryEntry>("upsert_library_entry", { entry });
export const deleteLibraryEntry = (id: string) =>
  invoke<void>("delete_library_entry", { id });

// File presentation (0.5.2)
/** Read a saved output file as text for the inline HTML report preview. */
export const readOutputFile = (path: string) =>
  invoke<string>("read_output_file", { path });
/**
 * Read a text file the user picked in a native dialog (the fs plugin's scope
 * rejects arbitrary dialog-chosen paths). Shares the bounded reader behind
 * `readOutputFile` — same size cap, same lossy-UTF-8 handling.
 */
export const readTextFile = (path: string) =>
  invoke<string>("read_output_file", { path });
/** Open a file or URL in the OS default app / browser (Tauri shell open). */
export const openPath = (path: string) => invoke<void>("open_path", { path });
/**
 * Show a file in the OS file manager with the item selected, rather than
 * opening it. What a citation wants: "where did this come from" is answered by
 * the file in its folder, not by launching whatever app owns the extension.
 */
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });

export const deleteMessagesFrom = (chatId: string, messageId: string) =>
  invoke<void>("delete_messages_from", { chatId, messageId });
export const getMessages = (chatId: string) =>
  invoke<Message[]>("get_messages", { chatId });
/** Replace a message's text content in place and flag it as user-edited. */
export const updateMessage = (chatId: string, messageId: string, text: string) =>
  invoke<Message>("update_message", { chatId, messageId, text });
/**
 * Name the chat. `wholeConversation` titles the chat as it now stands (a forced
 * regenerate); the default only reads the opening message, which is all that
 * exists when the automatic first-turn pass fires.
 */
export const generateTitle = (chatId: string, wholeConversation = false) =>
  invoke<string>("generate_title", { chatId, wholeConversation });

/** Corrected Mermaid source from a background repair request (0.9.8). */
export interface DiagramFix {
  source: string;
  /** True when the fix was written back over the stored tool call. */
  persisted: boolean;
}
/**
 * Repair one broken Mermaid diagram out of band. The model sees only the source
 * and the parser error — nothing is added to the conversation. Rejects if the
 * model can't produce a corrected diagram, so the caller can surface the
 * original error instead of pretending nothing happened.
 */
export const fixDiagram = (args: {
  chatId: string;
  messageId?: string | null;
  toolCallId?: string | null;
  source: string;
  error: string;
}) => invoke<DiagramFix>("fix_diagram", args);

// Messages
/**
 * Send a message. `override` applies to this turn only (the chat's stored zone
 * is untouched): `zoneId` "__simple__" forces a Quick turn, any other id picks
 * a one-off zone; `model` overrides the resolved zone's model.
 */
export const sendMessage = (
  chatId: string,
  parts: InputPart[],
  override?: { zoneId?: string | null; model?: string | null },
) =>
  invoke<void>("send_message", {
    chatId,
    parts,
    overrideZoneId: override?.zoneId ?? null,
    overrideModel: override?.model ?? null,
  });
export const regenerateResponse = (chatId: string) =>
  invoke<void>("regenerate_response", { chatId });
/** Re-run a single participant for the latest round: null = primary, otherwise a perspective zone. */
export const regenerateParticipant = (chatId: string, zoneId: string | null) =>
  invoke<void>("regenerate_participant", { chatId, zoneId });
/** Delete one participant's latest-round messages (null = primary, otherwise a perspective zone). */
export const deleteParticipantMessages = (chatId: string, zoneId: string | null) =>
  invoke<void>("delete_participant_messages", { chatId, zoneId });
export const cancelStream = (chatId: string) =>
  invoke<void>("cancel_stream", { chatId });
/**
 * Queue a message for a chat whose turn is already running. `steer` reaches the
 * model at its next step inside the current turn; `next` waits for the turn to
 * finish and then sends normally.
 *
 * `running: false` means the turn ended first and nothing was queued — send the
 * message the ordinary way instead.
 */
export const queueChatMessage = (
  chatId: string,
  id: string,
  text: string,
  mode: PendingMode,
) => invoke<{ running: boolean; id: string | null }>("queue_chat_message", { chatId, id, text, mode });
/** Drop a queued message that hasn't reached the model yet. */
export const cancelPendingMessage = (chatId: string, id: string) =>
  invoke<boolean>("cancel_pending_message", { chatId, id });
/**
 * `hunks` (0.10.2) approves only part of a previewed file change: the call still
 * runs, with its arguments rewritten to exactly the content the user agreed to.
 */
export const respondToolApproval = (
  chatId: string,
  zoneId: string | null,
  approved: boolean,
  hunks?: number[],
) => invoke<void>("respond_tool_approval", { chatId, zoneId, approved, hunks: hunks ?? null });

// ─── Review queue (0.10.2) ───────────────────────────────────────────────────

/** Every change queued in this chat, each diffed against the disk right now. */
export const listStagedEdits = (chatId: string) =>
  invoke<StagedEdit[]>("list_staged_edits", { chatId });

/** Write one queued change to disk; `hunks` applies only part of it. */
export const applyStagedEdit = (id: string, hunks?: number[], force?: boolean) =>
  invoke<ApplyOutcome>("apply_staged_edit", { id, hunks: hunks ?? null, force: force ?? false });

export const discardStagedEdit = (id: string) =>
  invoke<void>("discard_staged_edit", { id });

/** Apply the whole batch, in the order the changes were proposed. */
export const applyAllStagedEdits = (chatId: string, force?: boolean) =>
  invoke<ApplyOutcome[]>("apply_all_staged_edits", { chatId, force: force ?? false });

export const discardAllStagedEdits = (chatId: string) =>
  invoke<void>("discard_all_staged_edits", { chatId });

// PDF reads for the `read_file` tool (1.0). Rasterizing is PDF.js's job, so the
// backend asks the window to do it and waits for `resolve_pdf_read`.
export interface PdfReadRequest {
  id: string;
  path: string;
  /** Page spec as the model wrote it: "3", "1-4,9", "all". */
  spec: string;
  mode: "images" | "text";
  maxPages: number;
  /** The PDF itself, base64-encoded. */
  data: string;
}
export const resolvePdfRead = (
  id: string,
  result: { pageCount: number; pages: PdfReadPage[]; truncated: boolean } | null,
  error: string | null,
) => invoke<void>("resolve_pdf_read", { id, result, error });
export function onPdfReadRequest(
  handler: (req: PdfReadRequest) => void,
): Promise<UnlistenFn> {
  return listen<PdfReadRequest>("pdf-read-request", (e) => handler(e.payload));
}

// Settings
export const getSetting = (key: string) =>
  invoke<string | null>("get_setting", { key });
/**
 * When this window last wrote each key. The `settings-updated` event fires for
 * every write including our own, and re-reading the row behind a write the user
 * is still making (dragging a slider, typing in a field) would fight them with
 * a value one keystroke old. An echo of our own write within [`ECHO_MS`] is
 * therefore ignored — the state it would restore is the state we already have.
 */
const lastLocalWrite = new Map<string, number>();
const ECHO_MS = 1500;

/** True when this event is this window hearing its own recent write back. */
export function isOwnSettingsEcho(key: string): boolean {
  const at = lastLocalWrite.get(key);
  return at !== undefined && Date.now() - at < ECHO_MS;
}

export const setSetting = (key: string, value: string) => {
  lastLocalWrite.set(key, Date.now());
  return invoke<void>("set_setting", { key, value });
};
/**
 * Emitted after any settings row is written — including by the HTTP API or the
 * `app_control` tool, which is the case this exists for. Without it a model
 * asked to switch to dark mode changes the database and nothing else, and the
 * window overwrites the change the next time the user touches a preference.
 */
export function onSettingsUpdated(
  handler: (e: { key: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ key: string }>("settings-updated", (e) => handler(e.payload));
}
/**
 * Emitted after any write through the HTTP API or the `app_control` tool, with
 * the route that did it. The window reads the path to decide what to re-fetch,
 * so a zone a model creates appears in the sidebar the moment it exists.
 */
export function onAppDataChanged(
  handler: (e: { method: string; path: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ method: string; path: string }>("app-data-changed", (e) => handler(e.payload));
}
export const getDbStats = () => invoke<DbStats>("get_db_stats");
export const resetDatabase = () => invoke<void>("reset_database");
/** Re-write every chat's markdown mirror (used after enabling it / changing the dir). Returns the count. */
export const mirrorAllChats = () => invoke<number>("mirror_all_chats");
/** Read a mirrored `.md` file back into the DB as a new chat. */
export const importChatFromMarkdown = (path: string) =>
  invoke<Chat>("import_chat_from_markdown", { path });

// API server
export const applyApiSettings = (enabled: boolean, port: number, token: string) =>
  invoke<void>("apply_api_settings", { enabled, port, token });
export const generateApiToken = () => invoke<string>("generate_api_token");

// Attachments
export const uploadAttachment = (chatId: string, filePath: string) =>
  invoke<Attachment>("upload_attachment", { chatId, filePath });
export const savePdfAttachment = (chatId: string, fileName: string, pagesB64: string[]) =>
  invoke<Attachment>("save_pdf_attachment", { chatId, fileName, pagesB64 });
export const getAttachmentImages = (attachmentId: string) =>
  invoke<string[]>("get_attachment_images", { attachmentId });

// Events
export function onStream(handler: (env: StreamEnvelope) => void): Promise<UnlistenFn> {
  return listen<StreamEnvelope>("stream", (e) => handler(e.payload));
}
export function onChatTitleUpdated(
  handler: (e: { chatId: string; title: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ chatId: string; title: string }>("chat-title-updated", (e) =>
    handler(e.payload),
  );
}
export function onChatTagsUpdated(
  handler: (e: { chatId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ chatId: string }>("chat-tags-updated", (e) => handler(e.payload));
}
export function onMemoryUpdated(
  handler: (e: { chatId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ chatId: string }>("memory-updated", (e) => handler(e.payload));
}
export function onChatZoneUpdated(
  handler: (e: { chatId: string; zoneId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ chatId: string; zoneId: string }>("chat-zone-updated", (e) =>
    handler(e.payload),
  );
}
/** Emitted when the chat list changes server-side (e.g. a subchat was spawned). */
export function onChatsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("chats-changed", () => handler());
}
/** Emitted after an external edit to a mirrored `.md` was synced into the DB (0.7.2). */
export function onChatFileSynced(
  handler: (e: { chatId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ chatId: string }>("chat-file-synced", (e) => handler(e.payload));
}
/** Emitted after the watcher auto re-indexes a knowledge scope. */
export function onKnowledgeUpdated(
  handler: (e: { scope: string; global: boolean; indexed: number; removed: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ scope: string; global: boolean; indexed: number; removed: number }>(
    "knowledge-updated",
    (e) => handler(e.payload),
  );
}

// Voice / dictation (0.8.0)
export const listVoiceInputDevices = () =>
  invoke<VoiceInputDevice[]>("list_voice_input_devices");
export const startDictation = (deviceName: string | null) =>
  invoke<string>("start_dictation", { deviceName });
export const stopDictation = (sessionId: string) =>
  invoke<string>("stop_dictation", { sessionId });
export const cancelDictation = (sessionId: string) =>
  invoke<void>("cancel_dictation", { sessionId });
/** Live input peak (0–1) for a recording session, polled to drive the meter. */
export const dictationLevel = (sessionId: string) =>
  invoke<number>("dictation_level", { sessionId });
/**
 * Provisional transcript of what has been recorded so far, without stopping the
 * recording (0.11.5). Each call transcribes the whole utterance from the start,
 * so the answer replaces the previous partial rather than extending it. Empty
 * while there is too little audio, or once the session has ended.
 */
export const dictationPartial = (sessionId: string) =>
  invoke<string>("dictation_partial", { sessionId });

// Text-to-speech (0.8.1)
/** Synthesized audio: base64 payload plus its MIME type (e.g. audio/mpeg, audio/wav). */
export interface SynthesizedAudio { audio: string; mime: string }
/** Synthesize `text` to speech. `voice` overrides the global default. */
export const synthesizeSpeech = (text: string, voice: string | null) =>
  invoke<SynthesizedAudio>("synthesize_speech", { text, voice });
/** Condense a long response into a short spoken summary via the chat's model. */
export const summarizeForSpeech = (chatId: string, text: string) =>
  invoke<string>("summarize_for_speech", { chatId, text });
/** List voices offered by the configured speech provider (empty if unsupported). */
export const listTtsVoices = () => invoke<string[]>("list_tts_voices");
/** A cloned voice stored in-app: its name and reference transcript. */
export interface ClonedVoice { name: string; refText: string }
/** The in-app cloned voices catalog. */
export const listClonedVoices = () => invoke<ClonedVoice[]>("list_cloned_voices");
/** Register a cloned voice from a reference audio file + optional transcript (stored in-app). */
export const createClonedVoice = (name: string, audioPath: string, refText: string) =>
  invoke<string>("create_cloned_voice", { name, audioPath, refText });
/** Delete a cloned voice and its stored reference clip. */
export const deleteClonedVoice = (name: string) =>
  invoke<void>("delete_cloned_voice", { name });
/** Transcribe an audio file via the STT provider (auto-fill a clone's transcript). */
export const transcribeAudioFile = (audioPath: string) =>
  invoke<string>("transcribe_audio_file", { audioPath });

// Audio upload → auto-transcribe (0.12.0)
/** One timed span of a transcript. `noSpeechProb` is whisper's confidence that
 *  the span is *not* speech — the endpoint's only per-segment confidence signal. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  noSpeechProb: number | null;
}
/** A finished transcription. Everything past `text` needs `withMetadata` *and* a
 *  provider that implements `verbose_json`, so treat it all as optional. */
export interface Transcription {
  text: string;
  language: string | null;
  durationSecs: number | null;
  segments: TranscriptSegment[];
}
/**
 * Transcribe an uploaded audio file through the configured STT provider.
 *
 * The bytes go as base64 because the webview holds a `File` (dropped, picked or
 * pasted) and not necessarily a path on disk. `language` overrides the global
 * Settings → Voice language for this one upload; null auto-detects.
 */
export const transcribeAudioUpload = (
  fileName: string,
  audioB64: string,
  withMetadata: boolean,
  language: string | null,
) => invoke<Transcription>("transcribe_audio_upload", { fileName, audioB64, withMetadata, language });
