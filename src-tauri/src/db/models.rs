use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    /// Model used for "quick"/simple chats that aren't bound to a zone. Chosen
    /// alongside the provider during onboarding. None until set.
    pub default_model: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub id: String,
    pub name: String,
    pub provider_id: Option<String>,
    pub model: String,
    pub system_prompt: Option<String>,
    pub temperature: f64,
    pub max_tokens: Option<i64>,
    pub top_p: Option<f64>,
    /// JSON array of tool IDs
    pub tools_enabled: String,
    /// JSON object of per-tool config
    pub tool_config: String,
    pub thinking_enabled: bool,
    /// If false, inline thinking blocks (`<think>…</think>` and variants) in
    /// assistant content are stripped before this message is fed back to the
    /// model on subsequent turns. Off by default to keep context tight.
    pub include_thinking_in_context: bool,
    /// Lucide icon name (e.g. "Brain", "Bot"). None = default.
    pub icon: Option<String>,
    /// Hex accent color (e.g. "#3b82f6"). None = use global accent.
    pub accent_color: Option<String>,
    /// Response Leader: a zone configured to coordinate sub-agents. When true,
    /// the engine injects an orchestration preamble (listing the session's
    /// sub-agent roster) and the library/editor show a leader indicator.
    pub is_leader: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub zone_id: Option<String>,
    pub project_id: Option<String>,
    pub project_context_enabled: bool,
    /// Per-chat opt-in for project knowledge (RAG). When true and the chat's
    /// project has a non-empty index, the `search_knowledge` tool is offered.
    pub knowledge_enabled: bool,
    /// Per-chat override for how perspective zones run: `Some("sequential")`,
    /// `Some("parallel")`, or `None` to inherit the global app setting.
    pub perspective_mode: Option<String>,
    /// When true, a router model picks the best zone to answer each turn
    /// (Smart chat). `zone_id` stays NULL while this is on.
    pub smart_routing: bool,
    /// Set on chats created via "Branch from here" — the chat this was forked
    /// from. Null for ordinary chats. Cleared to NULL if the parent is deleted.
    pub parent_chat_id: Option<String>,
    /// The message in the parent that this branch was forked at (history was
    /// copied up to and including it). Null for ordinary chats.
    pub branched_from_message_id: Option<String>,
    /// Set on subchats — the zone that spawned and drives this chat. A child
    /// chat with this set is a subchat (vs. a branch, which sets
    /// `branched_from_message_id` instead). Subchats are read-only from the
    /// user's perspective. Cleared to NULL if the owning zone is deleted.
    pub initiated_by_zone_id: Option<String>,
    /// Context compaction (0.9.3): the model's summary of this chat's older
    /// turns, written by `compact_context`. When set, every message created at
    /// or before `context_summary_through` is replaced by this summary in the
    /// history sent to the model. The messages themselves are never deleted —
    /// they stay in the DB and on screen.
    pub context_summary: Option<String>,
    pub context_summary_through: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub accent_color: Option<String>,
    pub default_zone_id: Option<String>,
    pub context_snippet: Option<String>,
    /// Local filesystem directory the project is rooted at. Filesystem tools
    /// run relative to (and are scoped within) this directory when set.
    pub directory: Option<String>,
    /// When true, new chats created inside this project start with project
    /// context enabled automatically.
    pub default_context_enabled: bool,
    /// Knowledge (RAG) embedding config, bound to the index. The provider+model
    /// define the vector space; `kb_dimensions` is the embedding length captured
    /// at index time. `kb_indexed_at` is the last successful index (None if the
    /// project has never been indexed).
    pub kb_provider_id: Option<String>,
    pub kb_embedding_model: Option<String>,
    pub kb_dimensions: Option<i64>,
    pub kb_indexed_at: Option<i64>,
    /// Per-project override for whether new chats start with knowledge enabled.
    /// None = inherit the global `knowledgeDefaultEnabled` setting.
    pub kb_default_enabled: Option<bool>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub context_snippet: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Joined row: tag info + per-chat context toggle.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ChatTagEntry {
    pub tag_id: String,
    pub name: String,
    pub color: Option<String>,
    pub context_snippet: Option<String>,
    pub context_enabled: bool,
}

/// A flat chat↔tag link for the sidebar — every chat's tags in one query so
/// chips and tag-filtering don't need a per-chat round trip.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ChatTagLink {
    pub chat_id: String,
    pub tag_id: String,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ChatZone {
    pub chat_id: String,
    pub zone_id: String,
}

/// A node in a chat's sub-agent call tree (0.6.1 stack tracer). One row per
/// subchat descended (recursively) from a root chat, carrying the answering
/// zone, the owning/spawning zone, the parent link, and the conversational
/// message count — enough for the UI to assemble the leader→sub-agent(→nested)
/// tree and show each node's transcript on demand.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SubchatNode {
    pub id: String,
    pub title: String,
    /// The zone that answers in this subchat (the sub-agent).
    pub zone_id: Option<String>,
    /// The zone that spawned and drives this subchat (the caller/leader).
    pub initiated_by_zone_id: Option<String>,
    pub parent_chat_id: Option<String>,
    /// Count of primary (zone_id IS NULL) user/assistant turns in the subchat.
    pub message_count: i64,
    pub created_at: i64,
}

/// A global, on-demand instruction set (Anthropic Agent Skills model). The
/// `name` + `description` of every enabled skill is shown to agents that have
/// the skills tool; the agent loads `content` on demand via `load_skill`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub content: String,
    /// When true, the skill appears in the catalog offered to agents.
    pub enabled: bool,
    /// Set when a zone wrote this skill itself via `create_skill` (0.9.2); NULL
    /// when the user wrote it. Self-authored skills are created disabled and stay
    /// out of every catalog until the user reviews and enables them.
    pub authored_by_zone_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A model-managed memory entry. `scope` is "global" | "project" | "chat";
/// `scope_id` is the owning project/chat id (NULL for global).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub scope: String,
    pub scope_id: Option<String>,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Per-zone, per-tool call counters (0.9.3). Surfaced in the zone editor so a
/// user can see which tools a zone actually reaches for — every tool in a zone's
/// set costs context on every turn, so an unused one is pure tax.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    pub zone_id: String,
    /// The function name the model called, e.g. "read_file".
    pub tool_name: String,
    pub calls: i64,
    pub errors: i64,
    pub last_used_at: i64,
}

/// A registered MCP (Model Context Protocol) server. `transport` is "stdio"
/// (spawn `command` as a local subprocess) or "sse" (connect to the remote
/// `url`). Connection status is runtime-only and not stored here.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub url: Option<String>,
    /// JSON object of environment variables for the stdio child process.
    pub env: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A tool advertised by an MCP server, captured at connect time. `danger_level`
/// (0 safe / 1 moderate / 2 dangerous) is user-assigned and feeds the same
/// approval pipeline as built-in tools.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub description: Option<String>,
    /// JSON schema string describing the tool's input.
    pub input_schema: Option<String>,
    pub danger_level: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    /// JSON array of content parts (text/image/etc)
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    /// Reasoning / thinking text emitted by the model, if any.
    pub reasoning: Option<String>,
    /// Non-null for perspective assistant messages; identifies the zone that
    /// produced this turn. Null for all primary-conversation messages.
    pub zone_id: Option<String>,
    /// Zone that answered this primary assistant message. Null for user/tool
    /// messages and for messages saved before migration 012.
    pub active_zone_id: Option<String>,
    /// True when the user hand-edited this message's content after it was saved.
    pub edited: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub message_id: Option<String>,
    pub chat_id: Option<String>,
    pub file_name: String,
    pub file_type: String,
    pub storage_path: String,
    pub content: Option<String>,
    pub page_count: Option<i64>,
    pub created_at: i64,
}
