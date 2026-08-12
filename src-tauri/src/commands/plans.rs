//! Plan mode and plan artifacts, from the frontend's side (0.12.0).
//!
//! The mode is a per-chat toggle either the user or the model can move; the
//! plan is a row the user edits before agreeing to it. Approval is the only
//! path out of a draft that ends with work happening — rejecting keeps the chat
//! in plan mode with the model's next turn spent revising, which is what makes
//! "no, but" cheaper than cancelling the whole thing.

use crate::error::AppResult;
use crate::plans::{self, Plan, PlanStep};
use crate::state::AppState;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn set_chat_plan_mode(
    state: State<'_, AppState>,
    chat_id: String,
    on: bool,
) -> AppResult<()> {
    plans::set_plan_mode(&state.db, &chat_id, on).await?;
    crate::events::record(
        &state.db,
        &chat_id,
        None,
        None,
        "plan_mode",
        if on { "You turned plan mode on" } else { "You turned plan mode off" },
        None,
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn list_plans(state: State<'_, AppState>, chat_id: String) -> AppResult<Vec<Plan>> {
    plans::list_for_chat(&state.db, &chat_id).await
}

/// The plan waiting on the user in this chat, if any. The chat can be reopened
/// days later and still find its unanswered plan, which a widget rendered only
/// from the live stream could not.
#[tauri::command]
pub async fn pending_plan(state: State<'_, AppState>, chat_id: String) -> AppResult<Option<Plan>> {
    Ok(plans::pending_draft(&state.db, &chat_id).await)
}

/// Approve a plan — optionally the user's edited version of it.
///
/// `steps` arrives as the raw JSON the editor produced and is sanitised here
/// rather than trusted: it is the same shape the model sends, and the same
/// normalisation (unknown risk, empty step, thirty-first entry) should apply
/// whichever end it came from.
#[tauri::command]
pub async fn approve_plan(
    state: State<'_, AppState>,
    plan_id: String,
    steps: Option<Vec<Value>>,
    edited: bool,
) -> AppResult<Plan> {
    let parsed: Option<Vec<PlanStep>> = steps.as_ref().map(|s| plans::sanitize_steps(s));
    let plan = plans::approve(&state.db, &plan_id, parsed.as_deref(), edited).await?;
    crate::events::record(
        &state.db,
        &plan.chat_id,
        None,
        plan.zone_id.as_deref(),
        "plan_approved",
        if edited {
            format!("You approved an edited version of “{}”", plan.title)
        } else {
            format!("You approved “{}”", plan.title)
        },
        Some(plan.to_json()),
    )
    .await;
    Ok(plan)
}

/// Turn a plan down. The chat stays in plan mode: the user's objection is the
/// next message, and the model revises rather than starting again from nothing.
#[tauri::command]
pub async fn reject_plan(state: State<'_, AppState>, plan_id: String) -> AppResult<()> {
    let plan = plans::get(&state.db, &plan_id).await?;
    plans::set_status(&state.db, &plan_id, "rejected").await?;
    plans::set_plan_mode(&state.db, &plan.chat_id, true).await?;
    crate::events::record(
        &state.db,
        &plan.chat_id,
        None,
        plan.zone_id.as_deref(),
        "plan_rejected",
        format!("You turned down “{}” — still planning", plan.title),
        None,
    )
    .await;
    Ok(())
}

/// Rewrite a plan's steps without changing its status — the user striking or
/// adding a step mid-run (0.12.1).
#[tauri::command]
pub async fn update_plan_steps(
    state: State<'_, AppState>,
    plan_id: String,
    steps: Vec<Value>,
) -> AppResult<Plan> {
    let parsed = plans::sanitize_steps(&steps);
    let before = plans::get(&state.db, &plan_id).await?.parsed_steps().len();
    plans::write_steps(&state.db, &plan_id, &parsed).await?;
    let plan = plans::get(&state.db, &plan_id).await?;
    crate::events::record(
        &state.db,
        &plan.chat_id,
        None,
        plan.zone_id.as_deref(),
        "plan_edit",
        if parsed.len() > before {
            "You added a step to the plan"
        } else if parsed.len() < before {
            "You removed a step from the plan"
        } else {
            "You edited the plan"
        },
        Some(plan.to_json()),
    )
    .await;
    Ok(plan)
}

/// "Finish the step you are on, then stop" (0.12.1) — the control that sits
/// between letting a run finish and cancelling it, which until now was the only
/// option and threw away everything in flight.
#[tauri::command]
pub async fn request_plan_stop(state: State<'_, AppState>, plan_id: String) -> AppResult<()> {
    plans::request_stop(&state.db, &plan_id).await?;
    if let Ok(plan) = plans::get(&state.db, &plan_id).await {
        crate::events::record(
            &state.db,
            &plan.chat_id,
            None,
            plan.zone_id.as_deref(),
            "plan_stop",
            "You asked the run to stop after the current step",
            None,
        )
        .await;
    }
    Ok(())
}

/// A chat's plans and those of every subchat under it — a Multizone leader's
/// plan and its sub-agents' in one list, which the UI renders as a tree.
#[tauri::command]
pub async fn plan_tree(state: State<'_, AppState>, chat_id: String) -> AppResult<Vec<Plan>> {
    plans::tree_for_chat(&state.db, &chat_id).await
}

/// The chat's event log — the ordered record a replay steps through (0.12.2).
#[tauri::command]
pub async fn list_session_events(
    state: State<'_, AppState>,
    chat_id: String,
    limit: Option<i64>,
) -> AppResult<Vec<crate::events::SessionEvent>> {
    crate::events::list(&state.db, &chat_id, limit).await
}
