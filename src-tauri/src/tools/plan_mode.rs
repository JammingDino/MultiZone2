//! `enter_plan_mode` / `exit_plan_mode` (0.12.0) — the model's own hand on the
//! mode switch.
//!
//! Plan mode is a chat mode the user can turn on, but the case it matters most
//! in is the one where they didn't: a request that sounded small turns out to
//! rewrite six files, and the model is the first to know. Every harness worth
//! copying gives the model that move — PI's `EnterPlanMode()`, Claude Code's and
//! Codex's exits — so it lives here too, in both directions:
//!
//! - `enter_plan_mode` takes the model *into* planning mid-turn: the mutating
//!   tools go away from the next step onward, and it keeps investigating with
//!   the reads it still has.
//! - `exit_plan_mode` is the way out, and it is not the model's decision to
//!   make alone — it files the plan and ends the turn. The user edits and
//!   approves it, exactly as `ask_user` hands control back for an answer.
//!
//! The asymmetry is deliberate. Taking away your own permissions needs nobody's
//! consent; handing them back to yourself needs the user's.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use crate::plans;
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// Offered when the chat is *not* in plan mode, and only to a zone that has
/// something to withhold — a read-only zone entering plan mode would change
/// nothing about what it can do.
pub fn enter_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "enter_plan_mode".into(),
            description:
                "Switch this chat into plan mode when a request turns out to need more \
                 changes, or riskier ones, than the user is likely to have pictured — several \
                 files, a migration, anything you would want agreed before it happens. Your \
                 mutating tools are withheld from the next step onward; you keep every \
                 read-only tool, investigate, and finish with `exit_plan_mode`. Do not call it \
                 for work you can simply do."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "One line for the user on why this needs a plan first."
                    }
                },
                "required": ["reason"]
            }),
        },
    }
}

/// Offered only while the chat *is* in plan mode.
pub fn exit_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "exit_plan_mode".into(),
            description:
                "File your finished plan and hand it to the user, who edits and approves it \
                 before anything runs. This call is the request for approval — do not also ask \
                 in prose. Use it only once you have actually read the files involved, and only \
                 for work that will change something: answer a question or a piece of research \
                 directly instead. The turn ends here; execution begins when the user approves."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "A few words naming the plan, e.g. \"Add plan mode\"."
                    },
                    "goal": {
                        "type": "string",
                        "description": "One line: what is true once this is done."
                    },
                    "steps": {
                        "type": "array",
                        "description": "The plan, in order. Small and checkable beats large and vague.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "step": {
                                    "type": "string",
                                    "description": "What is done, in a few words."
                                },
                                "intent": {
                                    "type": "string",
                                    "description": "Why this step exists — what it achieves."
                                },
                                "files": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "The files this step expects to touch."
                                },
                                "risk": {
                                    "type": "string",
                                    "enum": ["low", "medium", "high"],
                                    "description": "How much damage getting this step wrong does. Be honest.",
                                    "default": "low"
                                }
                            },
                            "required": ["step"]
                        }
                    }
                },
                "required": ["steps"]
            }),
        },
    }
}

pub async fn enter(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let reason = args
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if plans::in_plan_mode(db, chat_id).await {
        return Ok(json!({
            "ok": true,
            "rendered": "plan_mode",
            "planMode": true,
            "note": "Already in plan mode — carry on investigating, then call `exit_plan_mode`.",
        })
        .to_string());
    }
    plans::set_plan_mode(db, chat_id, true).await?;
    crate::events::record(
        db,
        chat_id,
        None,
        None,
        "plan_mode",
        "The model switched itself into plan mode",
        Some(json!({ "reason": reason })),
    )
    .await;
    Ok(json!({
        "ok": true,
        "rendered": "plan_mode",
        "planMode": true,
        "reason": reason,
        "note": "Plan mode is on. Your mutating tools are withheld from here on. Investigate \
                 with the read-only tools, then call `exit_plan_mode` with the plan.",
    })
    .to_string())
}

/// File the plan. Returns the artifact with `status: "waiting_for_user"`; the
/// agentic loop ends the turn on it, the way it does for `ask_user`.
pub async fn exit(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
) -> AppResult<String> {
    let raw = match args.get("steps").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() => a.clone(),
        _ => {
            return Ok(json!({
                "error": "exit_plan_mode needs a non-empty 'steps' array — the plan itself.",
            })
            .to_string())
        }
    };
    if raw.len() > plans::MAX_STEPS {
        return Ok(json!({
            "error": format!(
                "Too many steps ({}); a plan the user can read stops at {}. Group the small ones.",
                raw.len(),
                plans::MAX_STEPS
            ),
        })
        .to_string());
    }
    let steps = plans::sanitize_steps(&raw);
    if steps.is_empty() {
        return Ok(json!({
            "error": "no valid steps — each step needs a non-empty 'step' string",
        })
        .to_string());
    }

    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Plan");
    let goal = args
        .get("goal")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // A model can call this without ever having been in plan mode — it decided
    // on its own that the work wanted agreeing first. That is the same request
    // for approval, so it is honoured rather than refused; the mode is set so
    // the chat is visibly waiting on the user rather than silently able to act.
    plans::set_plan_mode(db, chat_id, true).await?;
    let plan = plans::save_draft(db, chat_id, zone_id, title, goal, &steps).await?;
    // In a Multizone run this chat may be a subchat, in which case the plan
    // belongs under the leader's rather than standing alone in a conversation
    // nobody is watching (0.12.1).
    plans::link_to_parent_plan(db, &plan.id, chat_id).await?;
    crate::events::record(
        db,
        chat_id,
        None,
        zone_id,
        "plan_filed",
        format!("A plan was proposed: “{}” ({} steps)", title, steps.len()),
        Some(plan.to_json()),
    )
    .await;

    let mut payload = plan.to_json();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("rendered".into(), json!("plan_proposal"));
        obj.insert("status".into(), json!("waiting_for_user"));
        obj.insert(
            "note".into(),
            json!("Plan filed. Waiting for the user to edit and approve it — say nothing \
                   further this turn."),
        );
    }
    Ok(payload.to_string())
}
