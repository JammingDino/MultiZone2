use crate::error::AppResult;
use crate::llm::types::{StreamChunk, StreamToolCall, ToolCall, FunctionCall};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Aggregated state produced from streaming a single completion.
#[derive(Debug, Default)]
pub struct StreamAggregate {
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    /// True if the caller signalled cancellation mid-stream.
    pub cancelled: bool,
}

/// Callback signatures: invoked for each meaningful stream event.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Token { delta: String },
    ThinkingToken { delta: String },
    ToolCallStart { index: usize, name: String, id: String },
    ToolCallDeltaArgs { index: usize, delta: String },
    Done { finish_reason: Option<String> },
    Error { message: String },
}

/// Stateful parser that splits inline `<think>…</think>` blocks out of the
/// content token stream. Used for models (e.g. Gemma) that embed thinking in
/// the normal content field rather than a dedicated `reasoning_content` field.
struct InlineThinkParser {
    in_think: bool,
    /// Bytes that might be the start of an opening or closing tag.
    pending: String,
}

impl InlineThinkParser {
    fn new() -> Self {
        Self { in_think: false, pending: String::new() }
    }

    /// Feed a new text delta; emits to `on_event` and accumulates into `agg`.
    fn push<F>(&mut self, text: &str, agg: &mut StreamAggregate, on_event: &mut F)
    where
        F: FnMut(StreamEvent),
    {
        self.pending.push_str(text);
        self.drain(agg, on_event);
    }

    /// Call after the stream ends to flush any remaining buffered text.
    fn flush<F>(&mut self, agg: &mut StreamAggregate, on_event: &mut F)
    where
        F: FnMut(StreamEvent),
    {
        if !self.pending.is_empty() {
            let text = std::mem::take(&mut self.pending);
            if self.in_think {
                agg.reasoning.push_str(&text);
                on_event(StreamEvent::ThinkingToken { delta: text });
            } else {
                agg.content.push_str(&text);
                on_event(StreamEvent::Token { delta: text });
            }
        }
    }

    fn drain<F>(&mut self, agg: &mut StreamAggregate, on_event: &mut F)
    where
        F: FnMut(StreamEvent),
    {
        const OPEN: &str = "<think>";
        const CLOSE: &str = "</think>";

        loop {
            if !self.in_think {
                if let Some(pos) = self.pending.find(OPEN) {
                    if pos > 0 {
                        let before = self.pending[..pos].to_string();
                        agg.content.push_str(&before);
                        on_event(StreamEvent::Token { delta: before });
                    }
                    self.pending = self.pending[pos + OPEN.len()..].to_string();
                    self.in_think = true;
                } else {
                    // Emit all but the last (tag_len - 1) bytes — they might be
                    // the start of a tag that spans chunk boundaries.
                    let safe = self.pending.len().saturating_sub(OPEN.len() - 1);
                    if safe > 0 {
                        let emit = self.pending[..safe].to_string();
                        agg.content.push_str(&emit);
                        on_event(StreamEvent::Token { delta: emit });
                        self.pending = self.pending[safe..].to_string();
                    }
                    break;
                }
            } else {
                if let Some(pos) = self.pending.find(CLOSE) {
                    if pos > 0 {
                        let think = self.pending[..pos].to_string();
                        agg.reasoning.push_str(&think);
                        on_event(StreamEvent::ThinkingToken { delta: think });
                    }
                    self.pending = self.pending[pos + CLOSE.len()..].to_string();
                    self.in_think = false;
                } else {
                    let safe = self.pending.len().saturating_sub(CLOSE.len() - 1);
                    if safe > 0 {
                        let think = self.pending[..safe].to_string();
                        agg.reasoning.push_str(&think);
                        on_event(StreamEvent::ThinkingToken { delta: think });
                        self.pending = self.pending[safe..].to_string();
                    }
                    break;
                }
            }
        }
    }
}

pub async fn consume_stream<F>(
    response: reqwest::Response,
    cancel: Arc<AtomicBool>,
    parse_inline_think: bool,
    mut on_event: F,
) -> AppResult<StreamAggregate>
where
    F: FnMut(StreamEvent),
{
    let mut agg = StreamAggregate::default();
    let mut tool_acc: HashMap<usize, ToolCall> = HashMap::new();
    let mut think_parser = if parse_inline_think { Some(InlineThinkParser::new()) } else { None };

    let mut stream = response.bytes_stream().eventsource();

    while let Some(event) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            agg.cancelled = true;
            break;
        }
        match event {
            Ok(ev) => {
                let data = ev.data;
                if data == "[DONE]" {
                    break;
                }
                if data.is_empty() {
                    continue;
                }
                let chunk: StreamChunk = match serde_json::from_str(&data) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                for choice in chunk.choices {
                    if let Some(reason) = &choice.finish_reason {
                        agg.finish_reason = Some(reason.clone());
                    }
                    let thinking = choice
                        .delta
                        .reasoning_content
                        .as_deref()
                        .or(choice.delta.reasoning.as_deref());
                    if let Some(text) = thinking {
                        if !text.is_empty() {
                            agg.reasoning.push_str(text);
                            on_event(StreamEvent::ThinkingToken { delta: text.to_string() });
                        }
                    }
                    if let Some(text) = &choice.delta.content {
                        if !text.is_empty() {
                            if let Some(parser) = &mut think_parser {
                                parser.push(text, &mut agg, &mut on_event);
                            } else {
                                agg.content.push_str(text);
                                on_event(StreamEvent::Token { delta: text.clone() });
                            }
                        }
                    }
                    if let Some(deltas) = choice.delta.tool_calls {
                        for d in deltas {
                            apply_tool_call_delta(&mut tool_acc, d, &mut on_event);
                        }
                    }
                }
            }
            Err(e) => {
                on_event(StreamEvent::Error { message: e.to_string() });
                return Err(crate::error::AppError::Other(e.to_string()));
            }
        }
    }

    // Flush any buffered tag fragments from the inline-think parser.
    if let Some(parser) = &mut think_parser {
        parser.flush(&mut agg, &mut on_event);
    }

    // Flatten tool calls in index order
    let mut keys: Vec<usize> = tool_acc.keys().copied().collect();
    keys.sort();
    agg.tool_calls = keys.into_iter().map(|k| tool_acc.remove(&k).unwrap()).collect();

    on_event(StreamEvent::Done { finish_reason: agg.finish_reason.clone() });
    Ok(agg)
}

fn apply_tool_call_delta<F>(
    acc: &mut HashMap<usize, ToolCall>,
    delta: StreamToolCall,
    on_event: &mut F,
) where
    F: FnMut(StreamEvent),
{
    let idx = delta.index;
    let entry = acc.entry(idx).or_insert_with(|| ToolCall {
        id: String::new(),
        call_type: "function".to_string(),
        function: FunctionCall {
            name: String::new(),
            arguments: String::new(),
        },
    });

    let mut is_start = false;
    if let Some(id) = delta.id {
        if entry.id.is_empty() && !id.is_empty() {
            entry.id = id;
            is_start = true;
        }
    }
    if let Some(t) = delta.call_type {
        entry.call_type = t;
    }
    if let Some(fnd) = delta.function {
        if let Some(name) = fnd.name {
            if !name.is_empty() {
                entry.function.name.push_str(&name);
                if is_start || !entry.function.name.is_empty() {
                    on_event(StreamEvent::ToolCallStart {
                        index: idx,
                        name: entry.function.name.clone(),
                        id: entry.id.clone(),
                    });
                }
            }
        }
        if let Some(args) = fnd.arguments {
            if !args.is_empty() {
                entry.function.arguments.push_str(&args);
                on_event(StreamEvent::ToolCallDeltaArgs {
                    index: idx,
                    delta: args,
                });
            }
        }
    }
}
