//! The OpenAI Responses API, spoken through the Chat Completions types (0.17.9).
//!
//! Everything in the engine is written against `/chat/completions` — the
//! request it builds, the SSE chunks it reads, the messages it stores. A few
//! models are only served on the newer `/responses` endpoint: OpenCode Zen's
//! Muse Spark "contributor-free" models are the case that prompted this (a
//! chat-completions call to them answers with a bare 500, which is why they
//! worked inside opencode and nowhere else). Rather than teach the engine a
//! second protocol, this module translates at the edge: [`request`] turns a
//! `ChatRequest` into a Responses body, [`Translator`] turns Responses SSE
//! events into the `StreamChunk`s the stream consumer already understands, and
//! [`response`] does the same for a non-streaming reply. Nothing above the
//! client knows which endpoint answered.
//!
//! What is deliberately not carried across: reasoning items. The Responses API
//! can hand back encrypted reasoning to be replayed on the next turn; the
//! engine stores reasoning as text and never replays it, so requests go out
//! with `store: false` and a plain function-call history, which every provider
//! that serves the endpoint accepts.

use crate::llm::types::{
    ChatChoice, ChatMessage, ChatRequest, ChatResponse, ContentPart, FunctionCall, MessageContent,
    PromptTokensDetails, StreamChoice, StreamChunk, StreamDelta, StreamFunction, StreamToolCall,
    ToolCall, Usage,
};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Which wire protocol a request should go out on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    ChatCompletions,
    Responses,
}

/// Models that are only served on `/responses`, by name and host.
///
/// Kept narrow on purpose: for every other model chat/completions is the
/// better-trodden path (usage reporting, thinking fields, the probes in the
/// client all assume it). A model that turns out to need this one is a line
/// here, and the translation does the rest.
pub fn dialect_for(model: &str, base_url: &str) -> Dialect {
    let m = model.to_lowercase();
    let host = base_url.to_lowercase();
    let zen = host.contains("opencode.ai");
    if zen && (m.contains("muse") || m.ends_with("-contributor-free")) {
        return Dialect::Responses;
    }
    Dialect::ChatCompletions
}

// ── Request ──────────────────────────────────────────────────────────────────

fn text_of(content: &Option<MessageContent>) -> String {
    match content {
        Some(MessageContent::Text(t)) => t.clone(),
        Some(MessageContent::Parts(parts)) => parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text { text } | ContentPart::HiddenText { text } => {
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        None => String::new(),
    }
}

/// A user message's parts in Responses vocabulary: `input_text` and
/// `input_image`. The hidden variants are already unhidden by the request
/// builder, but are mapped anyway so a stray one is never dropped.
fn input_parts(content: &Option<MessageContent>) -> Vec<Value> {
    match content {
        Some(MessageContent::Text(t)) => vec![json!({ "type": "input_text", "text": t })],
        Some(MessageContent::Parts(parts)) => parts
            .iter()
            .map(|p| match p {
                ContentPart::Text { text } | ContentPart::HiddenText { text } => {
                    json!({ "type": "input_text", "text": text })
                }
                ContentPart::ImageUrl { image_url } | ContentPart::HiddenImage { image_url } => {
                    let mut v = json!({ "type": "input_image", "image_url": image_url.url });
                    if let Some(d) = &image_url.detail {
                        v["detail"] = json!(d);
                    }
                    v
                }
            })
            .collect(),
        None => vec![],
    }
}

/// Build the `/responses` body for a chat request.
pub fn request(req: &ChatRequest) -> Value {
    let mut instructions: Vec<String> = Vec::new();
    let mut input: Vec<Value> = Vec::new();
    let mut leading = true;

    for m in &req.messages {
        match m.role.as_str() {
            // The leading run of system messages is the prompt proper; a
            // system note later in the transcript (a steer, a wrap-up nudge)
            // has to keep its place, so it travels as a message.
            "system" | "developer" if leading => instructions.push(text_of(&m.content)),
            "system" | "developer" => {
                leading = false;
                input.push(json!({
                    "role": "developer",
                    "content": [{ "type": "input_text", "text": text_of(&m.content) }]
                }));
            }
            "user" => {
                leading = false;
                input.push(json!({ "role": "user", "content": input_parts(&m.content) }));
            }
            "assistant" => {
                leading = false;
                let text = text_of(&m.content);
                if !text.is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }]
                    }));
                }
                for tc in m.tool_calls.iter().flatten() {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": tc.id,
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    }));
                }
            }
            "tool" => {
                leading = false;
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": m.tool_call_id.clone().unwrap_or_default(),
                    "output": text_of(&m.content),
                }));
            }
            _ => {}
        }
    }

    let mut body = json!({
        "model": req.model,
        "input": input,
        "stream": req.stream,
        "store": false,
    });
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions.join("\n\n"));
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(p) = req.top_p {
        body["top_p"] = json!(p);
    }
    if let Some(n) = req.max_tokens {
        body["max_output_tokens"] = json!(n);
    }
    if let Some(tools) = &req.tools {
        if !tools.is_empty() {
            body["tools"] = Value::Array(
                tools
                    .iter()
                    .map(|t| {
                        json!({
                            "type": "function",
                            "name": t.function.name,
                            "description": t.function.description,
                            "parameters": t.function.parameters,
                        })
                    })
                    .collect(),
            );
        }
    }
    if let Some(tc) = &req.tool_choice {
        // Chat's `{"type":"function","function":{"name":x}}` flattens here.
        body["tool_choice"] = match tc.get("function").and_then(|f| f.get("name")) {
            Some(name) => json!({ "type": "function", "name": name }),
            None => tc.clone(),
        };
    }
    if let Some(effort) = &req.reasoning_effort {
        body["reasoning"] = json!({ "effort": effort });
    }
    body
}

// ── Streaming ────────────────────────────────────────────────────────────────

/// Per-stream bookkeeping the translation needs: which chat-style tool index a
/// Responses item id was given, and whether its arguments arrived as deltas
/// (some servers send only the final `…arguments.done`).
#[derive(Debug, Default)]
pub struct Translator {
    index_of: HashMap<String, usize>,
    saw_delta: HashMap<String, bool>,
    any_tool: bool,
}

fn delta_chunk(delta: StreamDelta, finish: Option<String>) -> StreamChunk {
    StreamChunk {
        choices: vec![StreamChoice {
            delta,
            finish_reason: finish,
        }],
        usage: None,
    }
}

fn usage_of(v: &Value) -> Option<Usage> {
    let u = v.get("usage")?;
    let cached = u
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|c| c.as_i64());
    Some(Usage {
        prompt_tokens: u.get("input_tokens").and_then(|n| n.as_i64()).unwrap_or(0),
        completion_tokens: u.get("output_tokens").and_then(|n| n.as_i64()).unwrap_or(0),
        prompt_cache_hit_tokens: None,
        prompt_tokens_details: cached.map(|c| PromptTokensDetails {
            cached_tokens: Some(c),
        }),
    })
}

impl Translator {
    /// One Responses SSE event → zero or more chat-style chunks. `Err` carries
    /// a provider-reported failure to surface as a stream error.
    pub fn translate(&mut self, data: &Value) -> Result<Vec<StreamChunk>, String> {
        let kind = data.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let s = |k: &str| data.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let mut out = Vec::new();

        match kind {
            "response.output_text.delta" => {
                if let Some(d) = s("delta") {
                    out.push(delta_chunk(
                        StreamDelta {
                            content: Some(d),
                            ..Default::default()
                        },
                        None,
                    ));
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(d) = s("delta") {
                    out.push(delta_chunk(
                        StreamDelta {
                            reasoning_content: Some(d),
                            ..Default::default()
                        },
                        None,
                    ));
                }
            }
            "response.output_item.added" => {
                let item = data.get("item").cloned().unwrap_or(Value::Null);
                if item.get("type").and_then(|t| t.as_str()) == Some("function_call") {
                    let item_id = item
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let idx = self.index_of.len();
                    self.index_of.insert(item_id.clone(), idx);
                    self.any_tool = true;
                    out.push(delta_chunk(
                        StreamDelta {
                            tool_calls: Some(vec![StreamToolCall {
                                index: idx,
                                id: item
                                    .get("call_id")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                                call_type: Some("function".into()),
                                function: Some(StreamFunction {
                                    name: item
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .map(str::to_string),
                                    arguments: None,
                                }),
                            }]),
                            ..Default::default()
                        },
                        None,
                    ));
                }
            }
            "response.function_call_arguments.delta" => {
                let item_id = s("item_id").unwrap_or_default();
                if let (Some(&idx), Some(d)) = (self.index_of.get(&item_id), s("delta")) {
                    self.saw_delta.insert(item_id, true);
                    out.push(delta_chunk(
                        StreamDelta {
                            tool_calls: Some(vec![StreamToolCall {
                                index: idx,
                                id: None,
                                call_type: None,
                                function: Some(StreamFunction {
                                    name: None,
                                    arguments: Some(d),
                                }),
                            }]),
                            ..Default::default()
                        },
                        None,
                    ));
                }
            }
            "response.function_call_arguments.done" => {
                // Only worth anything when no deltas came: the consumer has
                // already accumulated them otherwise, and this would double.
                let item_id = s("item_id").unwrap_or_default();
                let streamed = self.saw_delta.get(&item_id).copied().unwrap_or(false);
                if let (Some(&idx), Some(args), false) =
                    (self.index_of.get(&item_id), s("arguments"), streamed)
                {
                    out.push(delta_chunk(
                        StreamDelta {
                            tool_calls: Some(vec![StreamToolCall {
                                index: idx,
                                id: None,
                                call_type: None,
                                function: Some(StreamFunction {
                                    name: None,
                                    arguments: Some(args),
                                }),
                            }]),
                            ..Default::default()
                        },
                        None,
                    ));
                }
            }
            "response.completed" | "response.incomplete" => {
                let resp = data.get("response").cloned().unwrap_or(Value::Null);
                let finish = if kind == "response.incomplete" {
                    "length"
                } else if self.any_tool {
                    "tool_calls"
                } else {
                    "stop"
                };
                out.push(StreamChunk {
                    choices: vec![StreamChoice {
                        delta: StreamDelta::default(),
                        finish_reason: Some(finish.into()),
                    }],
                    usage: usage_of(&resp),
                });
            }
            "response.failed" | "error" => {
                let msg = data
                    .pointer("/response/error/message")
                    .or_else(|| data.pointer("/error/message"))
                    .or_else(|| data.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("the provider reported a failure");
                return Err(msg.to_string());
            }
            _ => {}
        }
        Ok(out)
    }
}

// ── Non-streaming ────────────────────────────────────────────────────────────

/// A full `/responses` reply as a chat completion.
pub fn response(v: &Value) -> ChatResponse {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    for item in v
        .get("output")
        .and_then(|o| o.as_array())
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(|t| t.as_str()) {
            Some("message") => {
                for c in item
                    .get("content")
                    .and_then(|c| c.as_array())
                    .into_iter()
                    .flatten()
                {
                    if c.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                        text.push_str(c.get("text").and_then(|t| t.as_str()).unwrap_or(""));
                    }
                }
            }
            Some("function_call") => tool_calls.push(ToolCall {
                id: item
                    .get("call_id")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
                call_type: "function".into(),
                function: FunctionCall {
                    name: item
                        .get("name")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string(),
                    arguments: item
                        .get("arguments")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string(),
                },
            }),
            Some("reasoning") => {
                for c in item
                    .get("summary")
                    .and_then(|c| c.as_array())
                    .into_iter()
                    .flatten()
                {
                    reasoning.push_str(c.get("text").and_then(|t| t.as_str()).unwrap_or(""));
                }
            }
            _ => {}
        }
    }
    let _ = reasoning;
    ChatResponse {
        choices: vec![ChatChoice {
            message: ChatMessage {
                role: "assistant".into(),
                content: Some(MessageContent::Text(text)),
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                },
                tool_call_id: None,
                name: None,
            },
            finish_reason: None,
        }],
        usage: usage_of(v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::{Tool, ToolFunction};

    fn msg(role: &str, text: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: Some(MessageContent::Text(text.into())),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    #[test]
    fn muse_on_zen_is_responses_everything_else_is_chat() {
        assert_eq!(
            dialect_for(
                "muse-spark-1.3-contributor-free",
                "https://opencode.ai/zen/v1"
            ),
            Dialect::Responses
        );
        assert_eq!(
            dialect_for("gpt-5", "https://opencode.ai/zen/v1"),
            Dialect::ChatCompletions
        );
        assert_eq!(
            dialect_for("muse-spark", "https://api.openai.com/v1"),
            Dialect::ChatCompletions
        );
    }

    #[test]
    fn request_carries_prompt_history_and_tool_round_trip() {
        let req = ChatRequest {
            model: "m".into(),
            messages: vec![
                msg("system", "be brief"),
                msg("user", "hi"),
                ChatMessage {
                    role: "assistant".into(),
                    content: None,
                    tool_calls: Some(vec![ToolCall {
                        id: "call_1".into(),
                        call_type: "function".into(),
                        function: FunctionCall {
                            name: "date_time".into(),
                            arguments: "{}".into(),
                        },
                    }]),
                    tool_call_id: None,
                    name: None,
                },
                ChatMessage {
                    role: "tool".into(),
                    content: Some(MessageContent::Text("2026".into())),
                    tool_calls: None,
                    tool_call_id: Some("call_1".into()),
                    name: None,
                },
                msg("system", "wrap up"),
            ],
            temperature: Some(0.3),
            max_tokens: Some(100),
            top_p: None,
            tools: Some(vec![Tool {
                tool_type: "function".into(),
                function: ToolFunction {
                    name: "date_time".into(),
                    description: "now".into(),
                    parameters: json!({ "type": "object" }),
                },
            }]),
            tool_choice: None,
            reasoning_effort: Some("high".into()),
            chat_template_kwargs: None,
            stream_options: None,
            stream: true,
        };
        let body = request(&req);
        assert_eq!(body["instructions"], "be brief");
        assert_eq!(body["max_output_tokens"], 100);
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["tools"][0]["name"], "date_time");
        let input = body["input"].as_array().unwrap();
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(input[1]["call_id"], "call_1");
        assert_eq!(input[2]["type"], "function_call_output");
        assert_eq!(input[2]["output"], "2026");
        assert_eq!(
            input[3]["role"], "developer",
            "a late system note keeps its place"
        );
        assert_eq!(body["store"], false);
    }

    #[test]
    fn stream_events_become_chat_chunks() {
        let mut t = Translator::default();
        let c = t
            .translate(&json!({ "type": "response.output_text.delta", "delta": "Hel" }))
            .unwrap();
        assert_eq!(c[0].choices[0].delta.content.as_deref(), Some("Hel"));

        let c = t
            .translate(&json!({ "type": "response.output_item.added", "item": { "type": "function_call", "id": "fc_1", "call_id": "call_9", "name": "read_file" } }))
            .unwrap();
        let tc = &c[0].choices[0].delta.tool_calls.as_ref().unwrap()[0];
        assert_eq!(tc.index, 0);
        assert_eq!(tc.id.as_deref(), Some("call_9"));
        assert_eq!(
            tc.function.as_ref().unwrap().name.as_deref(),
            Some("read_file")
        );

        let c = t
            .translate(&json!({ "type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "{\"p\"" }))
            .unwrap();
        assert_eq!(
            c[0].choices[0].delta.tool_calls.as_ref().unwrap()[0]
                .function
                .as_ref()
                .unwrap()
                .arguments
                .as_deref(),
            Some("{\"p\"")
        );
        // Deltas were seen, so the final `done` adds nothing.
        let c = t
            .translate(&json!({ "type": "response.function_call_arguments.done", "item_id": "fc_1", "arguments": "{\"p\":1}" }))
            .unwrap();
        assert!(c.is_empty());

        let c = t
            .translate(&json!({ "type": "response.completed", "response": { "usage": { "input_tokens": 10, "output_tokens": 5, "input_tokens_details": { "cached_tokens": 4 } } } }))
            .unwrap();
        assert_eq!(c[0].choices[0].finish_reason.as_deref(), Some("tool_calls"));
        let u = c[0].usage.as_ref().unwrap();
        assert_eq!(
            (
                u.prompt_tokens,
                u.completion_tokens,
                u.cached_prompt_tokens()
            ),
            (10, 5, 4)
        );
    }

    #[test]
    fn arguments_done_without_deltas_still_lands() {
        let mut t = Translator::default();
        t.translate(&json!({ "type": "response.output_item.added", "item": { "type": "function_call", "id": "fc", "call_id": "c", "name": "f" } })).unwrap();
        let c = t
            .translate(&json!({ "type": "response.function_call_arguments.done", "item_id": "fc", "arguments": "{}" }))
            .unwrap();
        assert_eq!(
            c[0].choices[0].delta.tool_calls.as_ref().unwrap()[0]
                .function
                .as_ref()
                .unwrap()
                .arguments
                .as_deref(),
            Some("{}")
        );
    }

    #[test]
    fn failures_surface() {
        let mut t = Translator::default();
        let e = t.translate(
            &json!({ "type": "response.failed", "response": { "error": { "message": "nope" } } }),
        );
        assert_eq!(e.unwrap_err(), "nope");
    }

    #[test]
    fn full_reply_maps_to_a_choice() {
        let r = response(&json!({
            "output": [
                { "type": "reasoning", "summary": [{ "type": "summary_text", "text": "hm" }] },
                { "type": "message", "content": [{ "type": "output_text", "text": "Hello" }] },
                { "type": "function_call", "call_id": "c1", "name": "f", "arguments": "{}" }
            ],
            "usage": { "input_tokens": 3, "output_tokens": 2 }
        }));
        let m = &r.choices[0].message;
        assert!(matches!(&m.content, Some(MessageContent::Text(t)) if t == "Hello"));
        assert_eq!(m.tool_calls.as_ref().unwrap()[0].id, "c1");
        assert_eq!(r.usage.unwrap().prompt_tokens, 3);
    }
}
