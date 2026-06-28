import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  McpServer,
  McpServerView,
  Memory,
  Message,
  Project,
  Provider,
  Skill,
  StreamEnvelope,
  Tag,
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
export const deleteChat = (id: string) => invoke<void>("delete_chat", { id });
/** Fork a chat at `messageId` into a new chat copying history up to & including it. */
export const branchChat = (chatId: string, messageId: string) =>
  invoke<Chat>("branch_chat", { chatId, messageId });

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

// Skills (global, on-demand catalog)
export const listSkills = () => invoke<Skill[]>("list_skills");
export const upsertSkill = (skill: Partial<Skill> & { name: string }) =>
  invoke<Skill>("upsert_skill", { skill });
export const setSkillEnabled = (id: string, enabled: boolean) =>
  invoke<void>("set_skill_enabled", { id, enabled });
export const deleteSkill = (id: string) => invoke<void>("delete_skill", { id });

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
/** Open a file or URL in the OS default app / browser (Tauri shell open). */
export const openPath = (path: string) => invoke<void>("open_path", { path });

export const deleteMessagesFrom = (chatId: string, messageId: string) =>
  invoke<void>("delete_messages_from", { chatId, messageId });
export const getMessages = (chatId: string) =>
  invoke<Message[]>("get_messages", { chatId });
/** Replace a message's text content in place and flag it as user-edited. */
export const updateMessage = (chatId: string, messageId: string, text: string) =>
  invoke<Message>("update_message", { chatId, messageId, text });
export const generateTitle = (chatId: string) =>
  invoke<string>("generate_title", { chatId });

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
export const respondToolApproval = (
  chatId: string,
  zoneId: string | null,
  approved: boolean,
) => invoke<void>("respond_tool_approval", { chatId, zoneId, approved });

// Settings
export const getSetting = (key: string) =>
  invoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) =>
  invoke<void>("set_setting", { key, value });
export const getDbStats = () => invoke<DbStats>("get_db_stats");
export const resetDatabase = () => invoke<void>("reset_database");

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
/** Emitted after the watcher auto re-indexes a knowledge scope. */
export function onKnowledgeUpdated(
  handler: (e: { scope: string; global: boolean; indexed: number; removed: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ scope: string; global: boolean; indexed: number; removed: number }>(
    "knowledge-updated",
    (e) => handler(e.payload),
  );
}
