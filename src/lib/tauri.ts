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
  DbStats,
  IndexSummary,
  InputPart,
  GlobalKbView,
  KbDocument,
  KnowledgeStatus,
  LifetimeUsage,
  McpServer,
  McpServerView,
  Memory,
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
export const listChats = () => invoke<Chat[]>("list_chats");
export const createChat = (zoneId: string | null, projectId?: string | null) =>
  invoke<Chat>("create_chat", { zoneId, projectId: projectId ?? null });
export const renameChat = (id: string, title: string) =>
  invoke<void>("rename_chat", { id, title });
export const setChatZone = (id: string, zoneId: string | null) =>
  invoke<void>("set_chat_zone", { id, zoneId });
export const setChatSmart = (id: string, smart: boolean) =>
  invoke<void>("set_chat_smart", { id, smart });
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
) => invoke<Chat>("branch_chat", { chatId, messageId, solo, zoneId });

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
  enabled?: boolean;
}) => invoke<McpServer>("upsert_mcp_server", { server });
export const deleteMcpServer = (id: string) => invoke<void>("delete_mcp_server", { id });
export const connectMcpServer = (id: string) =>
  invoke<McpServerView>("connect_mcp_server", { id });
export const disconnectMcpServer = (id: string) =>
  invoke<void>("disconnect_mcp_server", { id });
export const setMcpToolDanger = (toolId: string, dangerLevel: number) =>
  invoke<void>("set_mcp_tool_danger", { toolId, dangerLevel });

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
export const respondToolApproval = (
  chatId: string,
  zoneId: string | null,
  approved: boolean,
) => invoke<void>("respond_tool_approval", { chatId, zoneId, approved });

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
export const setSetting = (key: string, value: string) =>
  invoke<void>("set_setting", { key, value });
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
