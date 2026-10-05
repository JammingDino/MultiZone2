//! `make_flashcards`, `make_quiz`, `study_progress` — the study tools. See
//! `crate::study` for the mode they belong to.
//!
//! Not a zone tool group: they are offered by the mode, to every chat in a
//! study project and to no other, the way plan mode's tools are. A deck made
//! outside a study project would have nowhere to be reviewed.
//!
//! The results carry `cards` / `questions`, never `results`, so the citation
//! renumbering in `citations.rs` leaves them alone: a card's `source` names a
//! file, and is not a `[n]` the answer cites.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use crate::study::{self, NewCard, NewQuestion};
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub fn definitions() -> Vec<Tool> {
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "make_flashcards".into(),
                description: "Make a deck of flashcards from the project's sources. The deck is \
                    shown to the user, kept, and scheduled for spaced-repetition review. Search \
                    the sources first; every card should be something they say."
                    .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Short name for the deck, e.g. the topic or chapter." },
                        "cards": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": study::MAX_ITEMS,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "front": { "type": "string", "description": "A question or cue with one answer." },
                                    "back": { "type": "string", "description": "The answer, briefly. Markdown and $math$ are fine." },
                                    "source": { "type": "string", "description": "The source file it came from." }
                                },
                                "required": ["front", "back"]
                            }
                        }
                    },
                    "required": ["title", "cards"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "make_quiz".into(),
                description: "Make a multiple-choice quiz from the project's sources. The user \
                    answers it in the app and every answer is recorded. One correct option per \
                    question; distractors should be plausible to someone who half-knows the material."
                    .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "questions": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": study::MAX_ITEMS,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "question": { "type": "string" },
                                    "options": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 6 },
                                    "answer_index": { "type": "integer", "description": "0-based index of the correct option." },
                                    "explanation": { "type": "string", "description": "Why it is right, shown after answering." },
                                    "source": { "type": "string", "description": "The source file it came from." }
                                },
                                "required": ["question", "options", "answer_index"]
                            }
                        }
                    },
                    "required": ["title", "questions"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "study_progress".into(),
                description: "How the user is doing in this project: decks, cards due, quiz \
                    scores, and the questions and cards they keep getting wrong."
                    .into(),
                parameters: json!({ "type": "object", "properties": {} }),
            },
        },
    ]
}

async fn project_or_refusal(db: &SqlitePool, chat_id: &str) -> Result<String, String> {
    study::study_project_for_chat(db, chat_id).await.ok_or_else(|| {
        json!({ "error": "This chat is not in a study project, so there is nowhere to keep a study set." })
            .to_string()
    })
}

fn invalid(e: impl std::fmt::Display) -> String {
    json!({ "error": e.to_string() }).to_string()
}

pub async fn make_flashcards(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let project_id = match project_or_refusal(db, chat_id).await {
        Ok(p) => p,
        Err(refusal) => return Ok(refusal),
    };
    let title = args.get("title").and_then(Value::as_str).unwrap_or("");
    let cards: Vec<NewCard> = match args.get("cards").cloned().map(serde_json::from_value) {
        Some(Ok(c)) => c,
        Some(Err(e)) => return Ok(invalid(format!("cards: {e}"))),
        None => return Ok(invalid("cards is required")),
    };
    match study::create_deck(db, &project_id, Some(chat_id), title, &cards).await {
        Ok(deck) => Ok(json!({
            "set_id": deck.set.id,
            "kind": "flashcards",
            "title": deck.set.title,
            "cards": deck.cards.iter().map(|c| json!({
                "id": c.id, "front": c.front, "back": c.back, "source": c.source,
            })).collect::<Vec<_>>(),
            "note": "The deck is saved to the project and due for review now. Do not repeat the \
                     cards in your reply; the user can see them.",
        })
        .to_string()),
        Err(e) => Ok(invalid(e)),
    }
}

pub async fn make_quiz(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let project_id = match project_or_refusal(db, chat_id).await {
        Ok(p) => p,
        Err(refusal) => return Ok(refusal),
    };
    let title = args.get("title").and_then(Value::as_str).unwrap_or("");
    let questions: Vec<NewQuestion> = match args.get("questions").cloned().map(serde_json::from_value) {
        Some(Ok(q)) => q,
        Some(Err(e)) => return Ok(invalid(format!("questions: {e}"))),
        None => return Ok(invalid("questions is required")),
    };
    match study::create_quiz(db, &project_id, Some(chat_id), title, &questions).await {
        Ok(quiz) => Ok(json!({
            "set_id": quiz.set.id,
            "kind": "quiz",
            "title": quiz.set.title,
            "questions": quiz.questions.iter().map(|q| json!({
                "id": q.id,
                "question": q.question,
                "options": q.options,
                "answer_index": q.answer_index,
                "explanation": q.explanation,
                "source": q.source,
            })).collect::<Vec<_>>(),
            "note": "The quiz is shown to the user to answer. Do not reveal or repeat the answers \
                     in your reply; call `study_progress` later to see how they did.",
        })
        .to_string()),
        Err(e) => Ok(invalid(e)),
    }
}

pub async fn progress(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let project_id = match project_or_refusal(db, chat_id).await {
        Ok(p) => p,
        Err(refusal) => return Ok(refusal),
    };
    Ok(study::progress_report(db, &project_id).await?.to_string())
}
