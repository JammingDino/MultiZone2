use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "ask_user".into(),
            description:
                "Pause and ask the user one or more clarifying questions with optional \
                 multiple-choice answers. IMPORTANT: always call this as a proper tool call — \
                 never write the call inline in your text response. The user's reply arrives as \
                 the next message; do not produce any other output or call any other tools in \
                 this turn.\n\n\
                 • Single question: set `question` (and optionally `options` / `allow_free_text`).\n\
                 • Multiple questions at once: set `questions` — an array where each item has \
                   `question`, optional `options`, and optional `allow_free_text`. All answers are \
                   collected before the model receives them."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "Single question to ask the user. Omit when using `questions`."
                    },
                    "options": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Suggested answer options for the single-question form (max 6).",
                        "maxItems": 6
                    },
                    "allow_free_text": {
                        "type": "boolean",
                        "description": "Whether the user may type a custom answer (default true).",
                        "default": true
                    },
                    "questions": {
                        "type": "array",
                        "description": "Use instead of `question` to ask multiple questions at once. Each entry: { question, options?, allow_free_text? }.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": { "type": "string" },
                                "options": { "type": "array", "items": { "type": "string" }, "maxItems": 6 },
                                "allow_free_text": { "type": "boolean", "default": true }
                            },
                            "required": ["question"]
                        },
                        "maxItems": 6
                    }
                }
            }),
        },
    }
}

/// Returns the question/options structure so the UI can render an interactive widget.
/// The agentic loop in messages.rs special-cases this tool and terminates the turn
/// instead of looping into another assistant response.
pub async fn run(args: &Value) -> AppResult<String> {
    // Multi-question mode: `questions` array takes precedence.
    if let Some(questions) = args.get("questions").and_then(|v| v.as_array()) {
        if questions.is_empty() {
            return Ok(json!({ "error": "ask_user: questions array must not be empty" }).to_string());
        }
        let q_list: Vec<Value> = questions
            .iter()
            .map(|q| {
                let question = q.get("question").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let options = q
                    .get("options")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let allow_free_text = q
                    .get("allow_free_text")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                json!({
                    "question": question,
                    "options": options,
                    "allow_free_text": allow_free_text
                })
            })
            .collect();
        return Ok(json!({
            "rendered": "ask_user",
            "mode": "multi",
            "questions": q_list,
            "status": "waiting_for_user"
        })
        .to_string());
    }

    // Single-question mode (existing behaviour).
    let question = args.get("question").and_then(|v| v.as_str()).unwrap_or("");
    if question.is_empty() {
        return Ok(json!({ "error": "ask_user requires a question" }).to_string());
    }
    let options = args
        .get("options")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let allow_free_text = args
        .get("allow_free_text")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    Ok(json!({
        "rendered": "ask_user",
        "mode": "single",
        "question": question,
        "options": options,
        "allow_free_text": allow_free_text,
        "status": "waiting_for_user"
    })
    .to_string())
}
