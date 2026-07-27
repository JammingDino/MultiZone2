//! Mermaid auto-repair (0.9.8).
//!
//! When a `draw_diagram` result fails to render in the frontend, the UI asks the
//! model to fix that one diagram through this command instead of posting a
//! correction message into the conversation. The request is deliberately
//! context-free: the model sees only the source it produced and the parser
//! error, is handed a single tool (`draw_diagram`), and is forced to call it.
//! Nothing about the repair reaches the chat history — the corrected source is
//! written back over the original tool call, so a reload shows the fixed
//! diagram with no trace of the failure.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::db::models::Message;
use crate::error::{AppError, AppResult};
use crate::llm::client::LlmClient;
use crate::llm::types::{
    ChatMessage, ChatRequest, ContentPart, MessageContent, Tool, ToolFunction,
};
use crate::state::AppState;

const MSG_COLS: &str =
    "id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, edited, created_at";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramFix {
    /// Corrected Mermaid source to render.
    pub source: String,
    /// True when the corrected source was written back over the stored tool call.
    pub persisted: bool,
}

/// Ask the chat's own model to repair one broken Mermaid diagram.
///
/// `message_id` / `tool_call_id` identify the stored `draw_diagram` call. When
/// both are supplied the fix is persisted in place; when either is missing (a
/// diagram from a fenced code block, say) the corrected source is returned for
/// display only.
#[tauri::command]
pub async fn fix_diagram(
    state: State<'_, AppState>,
    chat_id: String,
    message_id: Option<String>,
    tool_call_id: Option<String>,
    source: String,
    error: String,
) -> AppResult<DiagramFix> {
    let source = source.trim();
    if source.is_empty() {
        return Err(AppError::Invalid("no diagram source to fix".into()));
    }

    let (zone, provider) =
        crate::commands::messages::effective_zone_and_provider(&state.db, &chat_id).await?;

    let req = ChatRequest {
        model: zone.model.clone(),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: Some(MessageContent::Text(repair_prompt(source, error.trim()))),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }],
        // Deterministic: this is a syntax repair, not a creative task.
        temperature: Some(0.0),
        max_tokens: Some(4096),
        top_p: None,
        tools: Some(vec![draw_diagram_tool()]),
        // Force the call rather than hoping for it — the whole request exists to
        // produce one `draw_diagram` invocation.
        tool_choice: Some(json!({
            "type": "function",
            "function": { "name": "draw_diagram" }
        })),
        reasoning_effort: None,
        chat_template_kwargs: None,
        stream: false,
    };

    let client = LlmClient::new(&state.http, &provider.base_url, provider.api_key.as_deref());
    let resp = client.chat_completion(&req).await?;
    let choice = resp
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Other("model returned no choices".into()))?;

    let fixed = extract_source(&choice.message)
        .ok_or_else(|| AppError::Other("model did not return a corrected diagram".into()))?;
    let fixed = fixed.trim().to_string();
    if fixed.is_empty() {
        return Err(AppError::Other("model returned an empty diagram".into()));
    }
    if fixed == source {
        // Re-rendering identical source would fail identically; report it as a
        // failed repair so the UI surfaces the original error to the user.
        return Err(AppError::Other(
            "model returned the same diagram unchanged".into(),
        ));
    }

    let persisted = match (message_id, tool_call_id) {
        (Some(mid), Some(tcid)) => {
            persist_fix(&state, &chat_id, &mid, &tcid, &fixed).await.unwrap_or(false)
        }
        _ => false,
    };

    Ok(DiagramFix { source: fixed, persisted })
}

/// The whole context the repair model gets: the source it produced, the parser
/// error, and the rules it most often breaks.
fn repair_prompt(source: &str, error: &str) -> String {
    format!(
        "A Mermaid diagram failed to render. Call `draw_diagram` exactly once with corrected \
Mermaid source. Preserve the diagram's meaning — the same nodes, edges and labels — and change \
only what is needed to make it parse.\n\n\
Parser error:\n```\n{error}\n```\n\n\
Source that failed:\n```mermaid\n{source}\n```\n\n\
Common causes to check:\n\
- LaTeX/MathJax (`$...$`, `\\frac`, …) inside node labels — Mermaid cannot parse it. Use plain text.\n\
- Unescaped parentheses, brackets, braces or quotes inside labels. Wrap the label in double quotes.\n\
- `\\n` used for a line break inside a label — use `<br/>`.\n\
- Subgraph titles containing special characters must be wrapped in double quotes.\n\
- A diagram-type keyword (`graph TD`, `sequenceDiagram`, …) missing from the first line.\n\
- Reserved words such as `end`, `graph` or `class` used as bare node ids.\n\n\
Respond with the tool call only — no prose."
    )
}

/// The `draw_diagram` schema, standalone. Kept apart from
/// `tools::render_graph::definitions` because the repair request has no
/// `ToolContext` and wants no theme guidance — only the corrected syntax.
fn draw_diagram_tool() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "draw_diagram".into(),
            description: "Render a Mermaid diagram. Pass the corrected Mermaid source.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "Corrected, valid Mermaid source code."
                    },
                    "caption": { "type": "string" }
                },
                "required": ["source"]
            }),
        },
    }
}

/// Pull the corrected source out of the response: the forced tool call if the
/// provider honoured `tool_choice`, otherwise a fenced Mermaid block in the
/// message text (some OpenAI-compatible servers ignore forced tool choice).
fn extract_source(msg: &ChatMessage) -> Option<String> {
    if let Some(calls) = &msg.tool_calls {
        for call in calls {
            if call.function.name != "draw_diagram" {
                continue;
            }
            if let Ok(args) = serde_json::from_str::<Value>(&call.function.arguments) {
                if let Some(s) = args.get("source").and_then(|v| v.as_str()) {
                    if !s.trim().is_empty() {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }

    let text = match msg.content.as_ref()? {
        MessageContent::Text(s) => s.clone(),
        MessageContent::Parts(parts) => parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text { text } | ContentPart::HiddenText { text } => {
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    };
    fenced_mermaid(&text)
}

/// Extract the body of the first ``` fenced block (mermaid-tagged or not).
fn fenced_mermaid(text: &str) -> Option<String> {
    let start = text.find("```")?;
    let after = &text[start + 3..];
    let body_start = after.find('\n')? + 1;
    let body = &after[body_start..];
    let end = body.find("```").unwrap_or(body.len());
    let block = body[..end].trim();
    if block.is_empty() { None } else { Some(block.to_string()) }
}

/// Rewrite the stored `draw_diagram` call and its result with the corrected
/// source, so the repair survives a reload. Best-effort: a failure here only
/// costs persistence, the caller still gets a diagram to render.
async fn persist_fix(
    state: &State<'_, AppState>,
    chat_id: &str,
    message_id: &str,
    tool_call_id: &str,
    fixed: &str,
) -> AppResult<bool> {
    let assistant = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE id = ?1 AND chat_id = ?2"
    ))
    .bind(message_id)
    .bind(chat_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(assistant) = assistant else { return Ok(false) };

    // ── The assistant message's tool_calls: patch arguments.source ──
    let Some(raw_calls) = assistant.tool_calls.as_deref() else { return Ok(false) };
    let mut calls: Value = serde_json::from_str(raw_calls)?;
    let mut patched = false;
    if let Some(arr) = calls.as_array_mut() {
        for call in arr {
            if call.get("id").and_then(|v| v.as_str()) != Some(tool_call_id) {
                continue;
            }
            let Some(func) = call.get_mut("function") else { continue };
            let raw_args = func.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
            let mut args: Value =
                serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
            if !args.is_object() {
                args = json!({});
            }
            args["source"] = json!(fixed);
            func["arguments"] = json!(serde_json::to_string(&args)?);
            patched = true;
            break;
        }
    }
    if !patched {
        return Ok(false);
    }
    sqlx::query("UPDATE messages SET tool_calls = ?1 WHERE id = ?2")
        .bind(serde_json::to_string(&calls)?)
        .bind(message_id)
        .execute(&state.db)
        .await?;

    // ── The tool result message: patch the `source` field of its JSON body ──
    let result_msg = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE chat_id = ?1 AND role = 'tool' AND tool_call_id = ?2"
    ))
    .bind(chat_id)
    .bind(tool_call_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some(result_msg) = result_msg {
        if let Some(content) = patch_result_content(&result_msg.content, fixed) {
            sqlx::query("UPDATE messages SET content = ?1 WHERE id = ?2")
                .bind(content)
                .bind(&result_msg.id)
                .execute(&state.db)
                .await?;
        }
    }

    crate::commands::mirror::mirror_chat_best_effort(&state.db, chat_id).await;
    Ok(true)
}

/// A tool message's content is a `ContentPart[]` whose single text part holds
/// the tool's JSON result. Swap `source` inside that inner JSON.
fn patch_result_content(content: &str, fixed: &str) -> Option<String> {
    let mut parts: Vec<ContentPart> = serde_json::from_str(content).ok()?;
    let mut changed = false;
    for part in parts.iter_mut() {
        let ContentPart::Text { text } = part else { continue };
        let Ok(mut body) = serde_json::from_str::<Value>(text) else { continue };
        if body.get("rendered").and_then(|v| v.as_str()) != Some("draw_diagram") {
            continue;
        }
        body["source"] = json!(fixed);
        *text = body.to_string();
        changed = true;
    }
    if !changed {
        return None;
    }
    serde_json::to_string(&parts).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fenced_block_is_extracted_when_tool_choice_is_ignored() {
        let text = "Here you go:\n```mermaid\ngraph TD\n  A --> B\n```\n";
        assert_eq!(fenced_mermaid(text).unwrap(), "graph TD\n  A --> B");
    }

    #[test]
    fn untagged_fence_still_parses() {
        assert_eq!(fenced_mermaid("```\ngraph LR\n  A --> B\n```").unwrap(), "graph LR\n  A --> B");
    }

    #[test]
    fn prose_without_a_fence_yields_nothing() {
        assert!(fenced_mermaid("I could not fix it.").is_none());
    }

    #[test]
    fn result_content_source_is_swapped() {
        let content = serde_json::to_string(&vec![ContentPart::Text {
            text: json!({ "rendered": "draw_diagram", "source": "bad", "caption": "c" }).to_string(),
        }])
        .unwrap();
        let patched = patch_result_content(&content, "graph TD\n  A --> B").unwrap();
        assert!(patched.contains("graph TD"));
        assert!(!patched.contains("\\\"bad\\\""));
        assert!(patched.contains("caption"));
    }

    #[test]
    fn non_diagram_results_are_left_alone() {
        let content = serde_json::to_string(&vec![ContentPart::Text {
            text: json!({ "rendered": "present_file" }).to_string(),
        }])
        .unwrap();
        assert!(patch_result_content(&content, "graph TD").is_none());
    }
}
