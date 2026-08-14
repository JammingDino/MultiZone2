//! `enter_plan_mode` / `exit_plan_mode` (0.12.0) — the model's own hand on the
//! mode switch.
//!
//! Plan mode is a state of the chat, and since 0.12.1 these two tools are the
//! only way a chat enters and leaves it — the composer toggle is gone. A button
//! asked the user to decide, before typing, whether what they were about to type
//! was big enough to need a plan; that is the judgement they came to the model
//! for. Asking for a plan does it instead, and so does the case that matters
//! most: a request that sounded small turns out to rewrite six files, and the
//! model is the first to know. Every harness worth copying gives the model that
//! move — PI's `EnterPlanMode()`, Claude Code's and Codex's exits — so it lives
//! here too, in both directions:
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

/// Offered whenever the chat is *not* in plan mode and the zone has any tools
/// (0.12.7 — it used to require a mutating one; see `apply_plan_mode`).
///
/// The description is written in the imperative and leads with the triggers,
/// because the failure this tool actually had was not misuse: it was never being
/// called. A model asked in plain words for a plan would write one in prose and
/// never touch the tool, so the user got an answer they could not edit, reorder
/// or approve — the whole point of the feature — unless they knew to type the
/// function name themselves.
pub fn enter_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "enter_plan_mode".into(),
            description:
                "Switch this chat into plan mode: the way to give the user a plan they can read, \
                 reorder, edit and approve before any of it happens.\n\n\
                 Call it whenever ANY of these is true:\n\
                 - The user asks for a plan, an approach, an outline, a strategy, or how you \
                   would go about something.\n\
                 - The user asks you to hold off, check with them first, or not start yet.\n\
                 - The request is a large deliverable — a report, a document, a design, a piece \
                   of research, a feature — where the shape of the thing should be agreed before \
                   you spend the effort.\n\
                 - The work turns out bigger or riskier than the user is likely to have pictured: \
                   several files, a migration, anything you would want agreed first.\n\n\
                 This tool is the ONLY way to produce a plan the user can act on. Writing the \
                 plan out in prose instead does not count and is the specific mistake to avoid — \
                 prose cannot be reordered, edited or approved, and nothing executes it. If you \
                 are about to write a numbered list of what you are going to do, call this \
                 instead.\n\n\
                 It costs little: your mutating tools (if any) are withheld from the next step \
                 onward, you keep every read-only tool, you investigate, and you finish with \
                 `exit_plan_mode`. Do not call it for a question you can simply answer, or for \
                 work you can simply do in a step or two."
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

/// The schema of one step, shared by `draft_plan_step` and `exit_plan_mode` so
/// the two cannot describe the same object differently — which they did for
/// about an hour, and the model believed whichever it had read most recently.
fn step_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "step": {
                "type": "string",
                "description": "What is done, in a few words. This is the heading, not the plan."
            },
            "intent": {
                "type": "string",
                "description": "One line: why this step exists — what it achieves."
            },
            "detail": {
                "type": "string",
                "description":
                    "The specification, as Markdown, and the part that matters. The approach and \
                     the alternatives you rejected with the reason; the concrete parameters — \
                     numbers, names, formats, thresholds, versions — not \"choose a suitable \
                     value\"; what specifically goes wrong here and what you would do about it; \
                     anything the user should push back on before it happens. Headings, lists and \
                     tables are all fine. Several paragraphs is normal."
            },
            "acceptance": {
                "type": "string",
                "description":
                    "How anyone tells this step is genuinely finished and correct, rather than \
                     nominally done."
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
    })
}

/// Offered only while the chat *is* in plan mode: build the plan a step at a
/// time instead of in one argument blob.
///
/// The one-shot shape is what produced the plans this release exists to fix. A
/// model asked for eight steps in a single call budgets its attention across all
/// eight, and the result is eight headings — because there is no point in the
/// call at which it is thinking about step 5 and nothing else. Here there is:
/// one call, one step, and the tool result says how many are down and asks for
/// the next.
pub fn draft_step_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "draft_plan_step".into(),
            description:
                "Write one step of your plan, in depth, and append it to the plan document. Call \
                 this once per step, in order — finish a step properly before you start thinking \
                 about the next one. The first call should also carry `title`, `goal` and \
                 `context`; later calls need only `step`. Use `replace_index` to rewrite a step \
                 you have already drafted. Nothing is shown to the user until you call \
                 `exit_plan_mode`, so drafting is free: a step you are unhappy with can be \
                 rewritten before anyone sees it."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "A few words naming the plan, e.g. \"Procedural animation report\"."
                    },
                    "goal": {
                        "type": "string",
                        "description": "One line: what is true once this is done."
                    },
                    "context": {
                        "type": "string",
                        "description":
                            "Markdown. The part of the plan that is not a step: the scope decision \
                             you made and the ones you rejected, the assumptions everything rests \
                             on, what your research turned up (with sources), and what is still \
                             open or guessed at. Send it on the first call; sending it again \
                             replaces it."
                    },
                    "step": step_schema(),
                    "replace_index": {
                        "type": "integer",
                        "description":
                            "Rewrite the step at this 1-based position instead of appending. \
                             Omit to append."
                    }
                },
                "required": []
            }),
        },
    }
}

/// Read a plan back — this chat's, or any plan by id.
///
/// Plan mode's own output outlives the context that produced it: the plan is a
/// row and a Markdown file, and by the time step 6 of it is running, the turn
/// that wrote step 6's specification may have been compacted away. This is how
/// the model gets it back, and it is deliberately not `read_file` — the plan
/// document lives in the app data directory, which is outside every zone's
/// allowed roots and should stay that way.
pub fn read_plan_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "read_plan".into(),
            description:
                "Read a plan back in full — every step with its specification, and the context it \
                 was agreed under. With no arguments it returns the plan currently in force for \
                 this chat (or the most recent one), plus an index of the others. Use it when you \
                 are executing a plan and need the detail of the step you are on, or when an \
                 earlier plan in this conversation has scrolled out of your context."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "plan_id": {
                        "type": "string",
                        "description": "A specific plan's id, from an earlier result or the index. Omit for this chat's current plan."
                    },
                    "step": {
                        "type": "integer",
                        "description": "Return only this 1-based step, in full. Omit for the whole plan."
                    }
                },
                "required": []
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
                "File your finished plan and hand it to the user, who reads, edits and approves \
                 it before anything runs. This call is the request for approval — do not also ask \
                 in prose, and do not restate the plan in your answer: they are looking at it. If \
                 you drafted with `draft_plan_step`, call this with no arguments and the draft is \
                 filed as it stands. Otherwise pass the whole plan here. Use it only once you \
                 have actually looked into the work — the files, the sources, whatever the \
                 request rests on. A question with a short answer does not need a plan; a \
                 substantial deliverable does, whether or not it changes a file. The turn ends \
                 here; execution begins when the user approves."
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
                    "context": {
                        "type": "string",
                        "description":
                            "Markdown. Scope decisions and the ones rejected, assumptions, what \
                             the research turned up, what is still open."
                    },
                    "steps": {
                        "type": "array",
                        "description":
                            "The plan, in order. Omit entirely if you drafted it with \
                             `draft_plan_step`. Each step needs a real `detail` — a list of \
                             headings is not a plan.",
                        "items": step_schema()
                    }
                },
                "required": []
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

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// `draft_plan_step` — one step, written properly, appended to the working
/// draft and to its document on disk.
pub async fn draft_step(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
) -> AppResult<String> {
    let title = str_arg(args, "title");
    let goal = str_arg(args, "goal");
    let context = str_arg(args, "context");
    let step_raw = args.get("step");

    if title.is_none() && goal.is_none() && context.is_none() && step_raw.is_none() {
        return Ok(json!({
            "error": "draft_plan_step needs at least one of `step`, `title`, `goal` or `context`.",
        })
        .to_string());
    }

    let mut plan = plans::open_working_draft(db, chat_id, zone_id, title, goal, context).await?;

    if let Some(raw) = step_raw {
        let Some(step) = plans::PlanStep::sanitize(raw) else {
            return Ok(json!({
                "error": "that step carried no `step` text — a step needs a name, however short.",
            })
            .to_string());
        };
        let thin = step.is_thin();
        let replace = args
            .get("replace_index")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        plan = match plans::put_draft_step(db, &plan.id, step, replace).await {
            Ok(p) => p,
            Err(e) => {
                return Ok(json!({
                    "error": e.to_string(),
                    "hint": "Rewrite an existing step with `replace_index`, or file what you have \
                             with `exit_plan_mode`.",
                })
                .to_string())
            }
        };
        let count = plan.parsed_steps().len();
        return Ok(json!({
            "ok": true,
            "rendered": "plan_draft",
            "planId": plan.id,
            "title": plan.title,
            "docPath": plan.doc_path,
            "steps": count,
            "note": if thin {
                "Step recorded, but its `detail` is very short — that is a heading, not a plan. \
                 Rewrite it with `replace_index` and give the approach, the alternatives you \
                 rejected, and the concrete parameters. Then draft the next step."
            } else {
                "Step recorded. Draft the next one, or call `exit_plan_mode` when the plan is \
                 complete. Nothing is shown to the user until you do."
            },
        })
        .to_string());
    }

    Ok(json!({
        "ok": true,
        "rendered": "plan_draft",
        "planId": plan.id,
        "title": plan.title,
        "docPath": plan.doc_path,
        "steps": plan.parsed_steps().len(),
        "note": "Header recorded. Now draft the steps, one call each.",
    })
    .to_string())
}

/// `read_plan` — a plan back in full, from the row rather than from memory.
pub async fn read(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let wanted = str_arg(args, "plan_id");
    let all = plans::list_for_chat(db, chat_id).await.unwrap_or_default();

    let plan = match wanted {
        Some(id) => plans::get(db, id).await.ok(),
        None => {
            // The one that matters now, in order: what is running, what the
            // user is being asked about, what is being written, then whatever
            // happened last.
            let pick = |status: &str| all.iter().rev().find(|p| p.status == status).cloned();
            pick("executing")
                .or_else(|| pick("approved"))
                .or_else(|| pick("draft"))
                .or_else(|| pick("drafting"))
                .or_else(|| all.last().cloned())
        }
    };

    let Some(plan) = plan else {
        return Ok(json!({
            "error": match wanted {
                Some(id) => format!("no plan with id `{id}`"),
                None => "this chat has no plans yet".to_string(),
            },
            "plans": all.iter().map(|p| json!({
                "planId": p.id, "title": p.title, "status": p.status,
            })).collect::<Vec<_>>(),
        })
        .to_string());
    };

    // A single step, when that is all that was asked for — the common case
    // mid-run, and far cheaper than re-reading a thirty-step plan to get one.
    if let Some(n) = args.get("step").and_then(|v| v.as_u64()).map(|n| n as usize) {
        let steps = plan.parsed_steps();
        let Some(step) = n.checked_sub(1).and_then(|i| steps.get(i)) else {
            return Ok(json!({
                "error": format!("step {n} is outside this plan (it has {} steps)", steps.len()),
            })
            .to_string());
        };
        return Ok(json!({
            "ok": true,
            "planId": plan.id,
            "title": plan.title,
            "index": n,
            "of": steps.len(),
            "step": step,
        })
        .to_string());
    }

    let mut payload = plan.to_json();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("ok".into(), json!(true));
        obj.insert("document".into(), json!(plans::render_doc(&plan)));
        if all.len() > 1 {
            obj.insert(
                "otherPlans".into(),
                json!(all
                    .iter()
                    .filter(|p| p.id != plan.id)
                    .map(|p| json!({
                        "planId": p.id, "title": p.title, "status": p.status,
                    }))
                    .collect::<Vec<_>>()),
            );
        }
    }
    Ok(payload.to_string())
}

/// File the plan. Returns the artifact with `status: "waiting_for_user"`; the
/// agentic loop ends the turn on it, the way it does for `ask_user`.
///
/// Two ways in. A plan drafted step by step with `draft_plan_step` is already a
/// row, and this call just files it. A plan passed here whole still works —
/// a model that never reached for the drafting tool, or one revising after a
/// rejection, should not be forced through a second round trip.
pub async fn exit(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
) -> AppResult<String> {
    let raw = args
        .get("steps")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty());

    let plan = match raw {
        Some(raw) => {
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
            let steps = plans::sanitize_steps(raw);
            if steps.is_empty() {
                return Ok(json!({
                    "error": "no valid steps — each step needs a non-empty 'step' string",
                })
                .to_string());
            }
            let title = str_arg(args, "title").unwrap_or("Plan");
            // A model can call this without ever having been in plan mode — it
            // decided on its own that the work wanted agreeing first. That is
            // the same request for approval, so it is honoured rather than
            // refused; the mode is set so the chat is visibly waiting on the
            // user rather than silently able to act.
            plans::set_plan_mode(db, chat_id, true).await?;
            plans::save_draft(
                db,
                chat_id,
                zone_id,
                title,
                str_arg(args, "goal"),
                str_arg(args, "context"),
                &steps,
            )
            .await?
        }
        None => {
            // No steps in the call: file the working draft, if there is one.
            let Some(draft) = plans::working_draft(db, chat_id, zone_id).await else {
                return Ok(json!({
                    "error": "there is no drafted plan to file, and this call carried no `steps`.",
                    "hint": "Draft the plan with `draft_plan_step` (one call per step), then call \
                             `exit_plan_mode` again — or pass the whole plan as `steps` here.",
                })
                .to_string());
            };
            if draft.parsed_steps().is_empty() {
                return Ok(json!({
                    "error": "the drafted plan has no steps yet.",
                    "hint": "Add them with `draft_plan_step`, one call each.",
                })
                .to_string());
            }
            // Late header fields are still worth taking — a model often names
            // the plan properly only once it can see the whole of it.
            plans::open_working_draft(
                db,
                chat_id,
                zone_id,
                str_arg(args, "title"),
                str_arg(args, "goal"),
                str_arg(args, "context"),
            )
            .await?;
            plans::set_plan_mode(db, chat_id, true).await?;
            plans::file_working_draft(db, &draft.id).await?
        }
    };

    let steps = plan.parsed_steps();
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
        format!("A plan was proposed: “{}” ({} steps)", plan.title, steps.len()),
        Some(plan.to_json()),
    )
    .await;

    let thin = steps.iter().filter(|s| s.is_thin()).count();
    let mut payload = plan.to_json();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("rendered".into(), json!("plan_proposal"));
        obj.insert("status".into(), json!("waiting_for_user"));
        obj.insert(
            "note".into(),
            json!(if thin * 2 > steps.len() {
                "Plan filed, though most of its steps carry little or no detail — the user is \
                 being asked to approve headings. Waiting for them now; say nothing further this \
                 turn, and if they send it back, add the specifications."
            } else {
                "Plan filed. Waiting for the user to edit and approve it — say nothing further \
                 this turn."
            }),
        );
    }
    Ok(payload.to_string())
}
