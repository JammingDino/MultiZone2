use crate::error::AppResult;
use crate::llm::client::LlmStream;
use crate::llm::responses::{Dialect, Translator};
use crate::llm::types::{FunctionCall, StreamChunk, StreamToolCall, ToolCall, Usage};
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
    /// Set when the transport failed part-way through — the provider hung up,
    /// the socket died, a chunk would not decode.
    ///
    /// A sibling of `cancelled` rather than an `Err` return, and deliberately:
    /// both mean "the stream stopped before the model was finished", and the
    /// half-answer that already arrived is worth exactly as much in either case.
    /// Returning `Err` discarded it, so a dropped connection silently threw away
    /// text the user had already watched appear, while pressing stop kept it.
    /// The caller decides what a partial is worth; this type's job is to still
    /// have it.
    pub error: Option<String>,
    /// The provider's own token counts, when it sent them. Arrives in a final
    /// chunk with no choices, after the last content delta — so a stream the
    /// user cancelled generally ends before it, and the caller falls back to the
    /// local estimate for that step.
    pub usage: Option<Usage>,
}

/// Callback signatures: invoked for each meaningful stream event.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Token {
        delta: String,
    },
    ThinkingToken {
        delta: String,
    },
    ToolCallStart {
        index: usize,
        name: String,
        id: String,
    },
    ToolCallDeltaArgs {
        index: usize,
        delta: String,
    },
    Done {
        finish_reason: Option<String>,
    },
    Error {
        message: String,
    },
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
        Self {
            in_think: false,
            pending: String::new(),
        }
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
    stream: LlmStream,
    cancel: Arc<AtomicBool>,
    parse_inline_think: bool,
    mut on_event: F,
) -> AppResult<StreamAggregate>
where
    F: FnMut(StreamEvent),
{
    let mut agg = StreamAggregate::default();
    let mut tool_acc: HashMap<usize, ToolCall> = HashMap::new();
    let mut think_parser = if parse_inline_think {
        Some(InlineThinkParser::new())
    } else {
        None
    };
    // A Responses stream is read through a translator that turns its events
    // into the chunks below; a chat stream is the chunks themselves.
    let mut translator = (stream.dialect == Dialect::Responses).then(Translator::default);

    let mut stream = stream.response.bytes_stream().eventsource();

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
                let chunks: Vec<StreamChunk> = match &mut translator {
                    Some(t) => match serde_json::from_str::<serde_json::Value>(&data) {
                        Ok(v) => match t.translate(&v) {
                            Ok(chunks) => chunks,
                            Err(message) => {
                                on_event(StreamEvent::Error {
                                    message: message.clone(),
                                });
                                agg.error = Some(message);
                                break;
                            }
                        },
                        Err(e) => {
                            tracing::debug!(
                                "skipping unparsable responses event: {e}; data: {data}"
                            );
                            continue;
                        }
                    },
                    None => match serde_json::from_str::<StreamChunk>(&data) {
                        Ok(c) => vec![c],
                        Err(e) => {
                            // Skipping the chunk is right — one unparsable frame
                            // shouldn't kill a working stream, and some providers
                            // interleave keep-alives and non-standard events. But a
                            // provider whose every frame we drop looks exactly like
                            // a model that answered with silence, so leave a trace.
                            tracing::debug!("skipping unparsable stream chunk: {e}; data: {data}");
                            continue;
                        }
                    },
                };
                for chunk in chunks {
                    // Providers disagree about where the usage block rides: most
                    // send it alone in a final chunk, some attach it to the chunk
                    // carrying `finish_reason`. Taking the last non-empty one either
                    // way — and never letting an empty block overwrite a real one.
                    if let Some(u) = chunk.usage {
                        if !u.is_empty() {
                            agg.usage = Some(u);
                        }
                    }
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
                                on_event(StreamEvent::ThinkingToken {
                                    delta: text.to_string(),
                                });
                            }
                        }
                        if let Some(text) = &choice.delta.content {
                            if !text.is_empty() {
                                if let Some(parser) = &mut think_parser {
                                    parser.push(text, &mut agg, &mut on_event);
                                } else {
                                    agg.content.push_str(text);
                                    on_event(StreamEvent::Token {
                                        delta: text.clone(),
                                    });
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
            }
            Err(e) => {
                // Break rather than return: the flush and flatten below still
                // run, so whatever arrived before the failure — text, reasoning,
                // half-accumulated tool calls — reaches the caller intact.
                on_event(StreamEvent::Error {
                    message: e.to_string(),
                });
                agg.error = Some(e.to_string());
                break;
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
    agg.tool_calls = keys
        .into_iter()
        .map(|k| tool_acc.remove(&k).unwrap())
        .collect();

    on_event(StreamEvent::Done {
        finish_reason: agg.finish_reason.clone(),
    });
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
    // `ToolCallStart` opens the UI block that the arg deltas then fill in, so it
    // has to be announced the moment this index first appears — NOT only once a
    // function name has arrived. Providers disagree about what the opening delta
    // carries: some send `{id, function:{name}}` and then args-only deltas,
    // others open with args and name the function later, or fragment the name
    // across chunks. Gating the start on a non-empty name meant the whole
    // build-up was dropped on the floor for the latter group, which is why tool
    // calls appeared to stream on some models and to materialise fully-formed on
    // others.
    let is_new = !acc.contains_key(&idx);
    let entry = acc.entry(idx).or_insert_with(|| ToolCall {
        id: String::new(),
        call_type: "function".to_string(),
        function: FunctionCall {
            name: String::new(),
            arguments: String::new(),
        },
    });
    let had_name = !entry.function.name.is_empty();

    if let Some(id) = delta.id {
        if entry.id.is_empty() && !id.is_empty() {
            entry.id = id;
        }
    }
    if let Some(t) = delta.call_type {
        entry.call_type = t;
    }

    let mut args_delta = None;
    if let Some(fnd) = delta.function {
        if let Some(name) = fnd.name {
            if !name.is_empty() {
                entry.function.name.push_str(&name);
            }
        }
        if let Some(args) = fnd.arguments {
            if !args.is_empty() {
                entry.function.arguments.push_str(&args);
                args_delta = Some(args);
            }
        }
    }

    // Open the block on first sight, and re-announce once the name is known so
    // a block opened as "unnamed" gets labelled. Both are idempotent by index
    // on the receiving end.
    if is_new || (!had_name && !entry.function.name.is_empty()) {
        on_event(StreamEvent::ToolCallStart {
            index: idx,
            name: entry.function.name.clone(),
            id: entry.id.clone(),
        });
    }
    if let Some(delta) = args_delta {
        on_event(StreamEvent::ToolCallDeltaArgs { index: idx, delta });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::StreamFunction;

    fn delta(
        index: usize,
        id: Option<&str>,
        name: Option<&str>,
        args: Option<&str>,
    ) -> StreamToolCall {
        StreamToolCall {
            index,
            id: id.map(str::to_string),
            call_type: None,
            function: Some(StreamFunction {
                name: name.map(str::to_string),
                arguments: args.map(str::to_string),
            }),
        }
    }

    /// Replay a provider's delta sequence, returning the events the UI sees.
    fn replay(deltas: Vec<StreamToolCall>) -> (Vec<StreamEvent>, HashMap<usize, ToolCall>) {
        let mut acc = HashMap::new();
        let mut events = Vec::new();
        for d in deltas {
            apply_tool_call_delta(&mut acc, d, &mut |e| events.push(e));
        }
        (events, acc)
    }

    fn streamed_args(events: &[StreamEvent], index: usize) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::ToolCallDeltaArgs { index: i, delta } if *i == index => {
                    Some(delta.as_str())
                }
                _ => None,
            })
            .collect()
    }

    fn started(events: &[StreamEvent]) -> bool {
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallStart { .. }))
    }

    /// The common shape: id + name up front, then arguments-only deltas.
    #[test]
    fn opens_on_id_and_name_then_streams_args() {
        let (events, acc) = replay(vec![
            delta(0, Some("call_1"), Some("write_file"), None),
            delta(0, None, None, Some("{\"path\":")),
            delta(0, None, None, Some("\"a.rs\"}")),
        ]);
        assert!(started(&events));
        assert_eq!(streamed_args(&events, 0), "{\"path\":\"a.rs\"}");
        assert_eq!(acc[&0].function.name, "write_file");
    }

    /// The shape that used to break: arguments begin before the name is known.
    /// The block must still open, and no argument text may be lost.
    #[test]
    fn opens_before_the_name_is_known() {
        let (events, _) = replay(vec![
            delta(0, Some("call_1"), None, Some("{\"path\":")),
            delta(0, None, Some("write_file"), None),
            delta(0, None, None, Some("\"a.rs\"}")),
        ]);
        assert!(started(&events), "block must open on the first delta");
        assert_eq!(streamed_args(&events, 0), "{\"path\":\"a.rs\"}");

        // Re-announced once the name lands, so the block can be labelled.
        let names: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::ToolCallStart { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(names, vec!["", "write_file"]);
    }

    /// A provider that never sends an id, only an index and arguments.
    #[test]
    fn opens_without_an_id() {
        let (events, _) = replay(vec![
            delta(0, None, None, Some("{\"a\":1")),
            delta(0, None, None, Some("}")),
        ]);
        assert!(started(&events));
        assert_eq!(streamed_args(&events, 0), "{\"a\":1}");
    }

    /// Parallel tool calls keep their argument streams separate.
    #[test]
    fn keeps_parallel_calls_separate() {
        let (events, acc) = replay(vec![
            delta(0, Some("c0"), Some("read"), None),
            delta(1, Some("c1"), Some("write_file"), None),
            delta(0, None, None, Some("{\"p\":0}")),
            delta(1, None, None, Some("{\"p\":1}")),
        ]);
        assert_eq!(streamed_args(&events, 0), "{\"p\":0}");
        assert_eq!(streamed_args(&events, 1), "{\"p\":1}");
        assert_eq!(acc[&0].function.name, "read");
        assert_eq!(acc[&1].function.name, "write_file");
    }

    /// A name split across chunks announces once, not per fragment.
    #[test]
    fn fragmented_name_announces_once() {
        let (events, acc) = replay(vec![
            delta(0, Some("c0"), Some("write"), None),
            delta(0, None, Some("_file"), None),
            delta(0, None, None, Some("{}")),
        ]);
        let starts = events
            .iter()
            .filter(|e| matches!(e, StreamEvent::ToolCallStart { .. }))
            .count();
        assert_eq!(starts, 1);
        assert_eq!(acc[&0].function.name, "write_file");
    }
}
