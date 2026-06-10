export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
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
  createdAt: number;
  updatedAt: number;
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

/** Joined tag info + per-chat context toggle returned by get_chat_tags. */
export interface ChatTagEntry {
  tagId: string;
  name: string;
  color: string | null;
  contextSnippet: string | null;
  contextEnabled: boolean;
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
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  sendKey: "enter",
  autoTitle: true,
  expandThinkingByDefault: false,
  fontSize: 14,
  fontFamily: "",
  defaultDirectory: "",
  apiEnabled: false,
  apiPort: 8765,
  apiToken: "",
  autoApproveLevel: "all",
  pdfMode: "images",
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
  { id: "render_graph", label: "Graph / diagram",   description: "Render Mermaid diagrams or math plots inline.",                                                  safety: 0 },
  { id: "web_search",   label: "Web search",        description: "Search the web via a configured provider.",                                                      safety: 1 },
  { id: "file_system",  label: "File system",       description: "Read, write, and list files within allowed paths.",                                              safety: 1 },
  { id: "switch_zone",  label: "Switch zone",       description: "Lets the model list zones and switch the chat to a different zone mid-conversation.",            safety: 1 },
  { id: "code_exec",    label: "Code execution",    description: "Run code snippets in a sandboxed subprocess (Python, Node, Bash, PowerShell).",                  safety: 2 },
  { id: "shell_exec",   label: "Shell / terminal",  description: "Run arbitrary shell commands in the chat's working directory (cmd, PowerShell, bash).",          safety: 2 },
];
