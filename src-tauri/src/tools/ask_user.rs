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
                let options = option_labels(q.get("options"));
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
    let options = option_labels(args.get("options"));
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

/// The options as strings, whatever shape the model sent them in (0.17.9).
///
/// The schema says `string[]`, and models mostly comply — but a model that
/// has seen enough form libraries will send `{label, value}` objects, and
/// the card used to hand each one to React as a child, which took the whole
/// chat panel down with "objects are not valid as a React child". An object
/// is read for its `label`, `value`, `text` or `title`; a number is written
/// out; anything else is dropped rather than shown as `[object Object]`.
fn option_labels(raw: Option<&Value>) -> Vec<String> {
    raw.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|o| match o {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    Value::Bool(b) => Some(b.to_string()),
                    Value::Object(m) => ["label", "value", "text", "title", "option"]
                        .iter()
                        .find_map(|k| m.get(*k))
                        .and_then(|v| match v {
                            Value::String(s) => Some(s.clone()),
                            Value::Number(n) => Some(n.to_string()),
                            _ => None,
                        }),
                    _ => None,
                })
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_come_out_as_strings_whatever_went_in() {
        let raw = json!(["Yes", { "label": "No", "value": "n" }, { "value": "maybe" }, 3, null, { "x": 1 }, "  "]);
        assert_eq!(option_labels(Some(&raw)), vec!["Yes", "No", "maybe", "3"]);
        assert!(option_labels(None).is_empty());
        assert!(option_labels(Some(&json!("not a list"))).is_empty());
    }

    #[tokio::test]
    async fn object_options_reach_the_card_as_labels() {
        let out = run(&json!({ "question": "Which?", "options": [{ "label": "A", "value": "a" }, "B"] })).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["options"], json!(["A", "B"]));
        let out = run(&json!({ "questions": [{ "question": "Q1", "options": [{ "label": "A", "value": "a" }] }] })).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["questions"][0]["options"], json!(["A"]));
    }
}
