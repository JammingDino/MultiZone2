use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
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
    /// Per-chat override for how perspective zones run: `Some("sequential")`,
    /// `Some("parallel")`, or `None` to inherit the global app setting.
    pub perspective_mode: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ChatZone {
    pub chat_id: String,
    pub zone_id: String,
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
