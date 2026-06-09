import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Attachment,
  Chat,
  ChatTagEntry,
  ChatZone,
  DbStats,
  InputPart,
  Message,
  Project,
  Provider,
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
export const setChatProject = (chatId: string, projectId: string | null) =>
  invoke<void>("set_chat_project", { chatId, projectId });
export const setChatProjectContext = (chatId: string, enabled: boolean) =>
  invoke<void>("set_chat_project_context", { chatId, enabled });
export const getChatTags = (chatId: string) =>
  invoke<ChatTagEntry[]>("get_chat_tags", { chatId });
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

// Projects
export const listProjects = () => invoke<Project[]>("list_projects");
export const upsertProject = (project: Partial<Project> & { name: string }) =>
  invoke<Project>("upsert_project", { project });
export const deleteProject = (id: string) => invoke<void>("delete_project", { id });

// Tags
export const listTags = () => invoke<Tag[]>("list_tags");
export const upsertTag = (tag: Partial<Tag> & { name: string }) =>
  invoke<Tag>("upsert_tag", { tag });
export const deleteTag = (id: string) => invoke<void>("delete_tag", { id });
export const deleteMessagesFrom = (chatId: string, messageId: string) =>
  invoke<void>("delete_messages_from", { chatId, messageId });
export const getMessages = (chatId: string) =>
  invoke<Message[]>("get_messages", { chatId });
export const generateTitle = (chatId: string) =>
  invoke<string>("generate_title", { chatId });

// Messages
export const sendMessage = (chatId: string, parts: InputPart[]) =>
  invoke<void>("send_message", { chatId, parts });
export const regenerateResponse = (chatId: string) =>
  invoke<void>("regenerate_response", { chatId });
export const cancelStream = (chatId: string) =>
  invoke<void>("cancel_stream", { chatId });
export const respondToolApproval = (chatId: string, approved: boolean) =>
  invoke<void>("respond_tool_approval", { chatId, approved });

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
export function onChatZoneUpdated(
  handler: (e: { chatId: string; zoneId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ chatId: string; zoneId: string }>("chat-zone-updated", (e) =>
    handler(e.payload),
  );
}
