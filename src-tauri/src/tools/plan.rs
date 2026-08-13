//! `update_plan` — a scratch checklist the model keeps across a long, multi-step
//! turn (0.9.3).
//!
//! Deliberately stateless on the backend: the plan lives in the conversation as
//! tool calls and results, so it survives reload, branching, and export with no
//! new table, and a sub-agent's plan can't collide with its leader's. Each call
//! replaces the whole list — the model restates every step with its current
//! status, which also keeps the plan in its own context window where it does the
//! most good.
//!
//! The result carries `rendered: "plan"` so the frontend can draw it as a
//! checklist rather than a raw tool-output blob (mirroring `present_file`).

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use crate::plans;
use serde_json::{json, Value};
use sqlx::SqlitePool;

const MAX_STEPS: usize = 30;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "update_plan".into(),
            description:
                "Call this when a task takes several distinct steps or tool calls — once up front \
                 with the whole plan, then after each step to mark progress. Skip it for anything \
                 you can answer in one step. Each call replaces the list, so always send every \
                 step; keep exactly one `in_progress`, and finish by marking the last one `done`."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "description": "The full checklist, in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "step": {
                                    "type": "string",
                                    "description": "What is being done, in a few words."
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "done", "skipped"],
                                    "description": "Current status of this step.",
                                    "default": "pending"
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

pub async fn run(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
) -> AppResult<String> {
    // With an approved plan in force (0.12.1), this call is no longer scratch
    // bookkeeping — it is the live state of the task list the user agreed to,
    // and it is written back to the plan row so the checklist on screen ticks
    // off as the turn works. It is also where the plan stops being negotiable:
    // the steps are the user's, so a call that renames, drops or invents one is
    // refused with the approved list attached rather than quietly accepted.
    if let Some(plan) = plans::active_plan(db, chat_id, zone_id).await {
        return sync_active_plan(args, db, plan).await;
    }

    let raw = match args.get("steps").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() => a,
        _ => return Ok(json!({ "error": "update_plan needs a non-empty 'steps' array" }).to_string()),
    };
    if raw.len() > MAX_STEPS {
        return Ok(json!({
            "error": format!("Too many steps ({}); keep the plan to {MAX_STEPS} or fewer by grouping them.", raw.len())
        })
        .to_string());
    }

    let mut steps: Vec<Value> = Vec::with_capacity(raw.len());
    for item in raw {
        // Accept both {step, status} and a bare string, since models reliably
        // shortcut to the latter.
        let (text, status) = match item {
            Value::String(s) => (s.trim().to_string(), "pending".to_string()),
            Value::Object(_) => {
                let text = item
                    .get("step")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let status = item
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("pending")
                    .trim()
                    .to_ascii_lowercase();
                (text, status)
            }
            _ => continue,
        };
        if text.is_empty() {
            continue;
        }
        let status = match status.as_str() {
            "in_progress" | "done" | "skipped" | "pending" => status,
            // Tolerate near-misses rather than failing the call over a synonym.
            "doing" | "active" | "current" => "in_progress".to_string(),
            "complete" | "completed" | "finished" => "done".to_string(),
            _ => "pending".to_string(),
        };
        steps.push(json!({ "step": text, "status": status }));
    }

    if steps.is_empty() {
        return Ok(json!({ "error": "no valid steps — each step needs a non-empty 'step' string" }).to_string());
    }

    let done = steps.iter().filter(|s| s["status"] == "done").count();
    let total = steps.len();
    let next = steps
        .iter()
        .find(|s| s["status"] == "in_progress")
        .or_else(|| steps.iter().find(|s| s["status"] == "pending"))
        .and_then(|s| s["step"].as_str())
        .map(str::to_string);

    Ok(json!({
        "rendered": "plan",
        "ok": true,
        "steps": steps,
        "done": done,
        "total": total,
        "current": next,
    })
    .to_string())
}

/// Fold an `update_plan` call into the approved plan it is reporting progress
/// against.
///
/// Statuses are the model's to change; step text is not. Matching is positional
/// with a text check, which is the strictest thing that still tolerates the
/// paraphrasing every model does — a step whose wording drifts is accepted with
/// the approved text kept, but a different *number* of steps, or a step that
/// matches nothing, is the model having rewritten the plan, and that is the one
/// thing the approval was supposed to prevent.
async fn sync_active_plan(args: &Value, db: &SqlitePool, plan: plans::Plan) -> AppResult<String> {
    let approved = plan.parsed_steps();
    let incoming = args
        .get("steps")
        .and_then(|v| v.as_array())
        .map(|a| plans::sanitize_steps(a))
        .unwrap_or_default();

    if incoming.len() != approved.len() {
        return Ok(json!({
            "error": format!(
                "This chat is executing a plan the user approved, of {} steps — you sent {}. \
                 The steps are fixed; only their statuses are yours to change.",
                approved.len(),
                incoming.len()
            ),
            "approvedSteps": approved.iter().map(|s| &s.step).collect::<Vec<_>>(),
            "hint": "Resend the approved steps in order with updated statuses. If the plan is \
                     genuinely wrong, stop and tell the user rather than editing it yourself.",
        })
        .to_string());
    }

    // Match by id where the model echoed one, else positionally.
    let mut merged = approved.clone();
    for (i, step) in merged.iter_mut().enumerate() {
        let src = incoming
            .iter()
            .find(|s| s.id == step.id)
            .unwrap_or(&incoming[i]);
        step.status = src.status.clone();
        if src.note.is_some() {
            step.note = src.note.clone();
        }
        if src.error.is_some() {
            step.error = src.error.clone();
        }
        // A step reported as failed with no reason is worse than useless
        // afterwards — the replay shows a red mark and nothing else.
        if step.status == "failed" && step.error.is_none() {
            step.error = Some("the model reported this step as failed without a reason".into());
        }
    }

    plans::write_steps(db, &plan.id, &merged).await?;
    let terminal = merged
        .iter()
        .all(|s| matches!(s.status.as_str(), "done" | "skipped" | "failed"));
    let status = if terminal { "done" } else { "executing" };
    plans::set_status(db, &plan.id, status).await?;
    // Keep the document on disk in step with the run, so opening it mid-task
    // shows where the work actually is rather than where it started.
    plans::refresh_doc(db, &plan.id).await;

    let done = merged.iter().filter(|s| s.status == "done").count();
    let current_step = merged
        .iter()
        .find(|s| s.status == "in_progress")
        .or_else(|| merged.iter().find(|s| s.status == "pending"));
    let current = current_step.map(|s| s.step.clone());

    Ok(json!({
        "rendered": "plan",
        "ok": true,
        "planId": plan.id,
        "approved": true,
        "steps": merged,
        "done": done,
        "total": merged.len(),
        "current": current,
        // The specification of the step now in hand, handed back unasked. It is
        // the one thing the model is about to need and the first thing context
        // compaction takes away — cheaper here than a `read_plan` round trip at
        // every step boundary.
        "currentDetail": current_step.and_then(|s| s.detail.clone()),
        "currentAcceptance": current_step.and_then(|s| s.acceptance.clone()),
    })
    .to_string())
}
