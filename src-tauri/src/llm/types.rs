use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    #[serde(rename = "image_url")]
    ImageUrl {
        image_url: ImageUrl,
    },
    /// Stored in the DB but hidden from the chat UI. Converted to `Text` when
    /// building API requests so the model still receives the content.
    HiddenText {
        text: String,
    },
    /// Stored in the DB but hidden from the chat UI. Converted to `ImageUrl`
    /// when building API requests so the model still receives the image.
    HiddenImage {
        image_url: ImageUrl,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<MessageContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "default_tool_type")]
    pub call_type: String,
    pub function: FunctionCall,
}

fn default_tool_type() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    /// JSON-encoded arguments string (OpenAI returns a string here, not an object)
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    #[serde(rename = "type", default = "default_tool_type")]
    pub tool_type: String,
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Tool>>,
    /// Raw OpenAI `tool_choice` value, e.g. `{"type":"function","function":{"name":"x"}}`
    /// to force one specific call. Left unset on ordinary turns so the model
    /// decides for itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Extra arguments passed to the server's chat template, e.g.
    /// `{"enable_thinking": false}` — how vLLM, SGLang, llama.cpp and LM Studio
    /// turn a thinking model's reasoning off. Hosted APIs reject unknown request
    /// fields, so anything that sets this must be able to retry without it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_template_kwargs: Option<Value>,
    /// OpenAI's `stream_options`, set to `{"include_usage": true}` so the
    /// provider appends a final chunk carrying its own token counts. Those are
    /// exact where ours are estimated, and they are the only way to see prompt
    /// cache hits at all. Not universally supported — a provider that 400s on it
    /// is retried without (see `LlmClient::chat_stream`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<Value>,
    pub stream: bool,
}

/// The provider's own token counts for one request.
///
/// Field names follow OpenAI's `usage` block, which every compatible provider
/// mirrors. The cache figures are the exception: DeepSeek reports them as flat
/// `prompt_cache_{hit,miss}_tokens`, OpenAI nests the same idea under
/// `prompt_tokens_details.cached_tokens`, and most local servers omit both.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: i64,
    #[serde(default)]
    pub completion_tokens: i64,
    #[serde(default)]
    pub prompt_cache_hit_tokens: Option<i64>,
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: Option<i64>,
}

impl Usage {
    /// Prompt tokens the provider served from cache, in whichever dialect it
    /// reported them. Zero when it reported neither — which reads the same as a
    /// cold prompt, and is the safe way round: a session is never made to look
    /// cheaper than it was.
    pub fn cached_prompt_tokens(&self) -> i64 {
        self.prompt_cache_hit_tokens
            .or_else(|| self.prompt_tokens_details.as_ref().and_then(|d| d.cached_tokens))
            .unwrap_or(0)
            .clamp(0, self.prompt_tokens)
    }

    /// A usage block that says nothing is not worth recording over our own
    /// estimate — some providers send the field with every counter at zero.
    pub fn is_empty(&self) -> bool {
        self.prompt_tokens <= 0 && self.completion_tokens <= 0
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamChunk {
    /// Empty on the final usage-only chunk, which several providers send after
    /// the last content delta. It used to be required, so that chunk failed to
    /// parse and was skipped — taking the token counts with it.
    #[serde(default)]
    pub choices: Vec<StreamChoice>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamChoice {
    pub delta: StreamDelta,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StreamDelta {
    /// Sent on the first delta of a choice; captured to mirror the wire format
    /// but not consumed (role is fixed to "assistant" on our side).
    #[allow(dead_code)]
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<StreamToolCall>>,
    /// Some providers (DeepSeek, vLLM, etc.) stream model reasoning here.
    #[serde(default)]
    pub reasoning_content: Option<String>,
    /// Alternate field name used by some providers / OpenRouter pass-throughs.
    #[serde(default)]
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamToolCall {
    pub index: usize,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default, rename = "type")]
    pub call_type: Option<String>,
    #[serde(default)]
    pub function: Option<StreamFunction>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamFunction {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatResponse {
    pub choices: Vec<ChatChoice>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatChoice {
    pub message: ChatMessage,
    /// Captured to mirror the wire format; not consumed for non-streaming reads.
    #[allow(dead_code)]
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelList {
    pub data: Vec<ModelEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelEntry {
    pub id: String,
}
