//! Plan mode and the plan artifact (0.12.0).
//!
//! Three things live here:
//!
//! - **The mode.** A per-chat flag. While it is on, every tool that changes
//!   something is withheld from the request — not discouraged in the prompt,
//!   withheld — and the read-only ones stay, so a plan is grounded in the files
//!   as they actually are. This is the one place MultiZone deliberately differs
//!   from Claude Code, whose plan mode is prompt reinforcement over an unchanged
//!   toolset; a mode a model can talk itself out of is a mode the user cannot
//!   rely on. Belt and braces: the toolset is filtered *and* the executor
//!   refuses a withheld call, because a model can name a tool it was never
//!   offered and some providers will pass it straight through.
//!
//! - **The artifact.** Ordered steps, each with an intent, the files it expects
//!   to touch and a risk level — a row the user can rewrite before agreeing to
//!   it, rather than prose in the transcript. Codex and Claude Code both end
//!   planning with prose plus a yes/no; the edit is the part that makes it the
//!   user's plan rather than the model's.
//!
//! - **The handover.** An approved plan is the executing turn's task list, fed
//!   back in from this table rather than from anything the model remembers, so
//!   the plan that runs is the plan that was agreed to.

use crate::commands::{new_id, now_ts};
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// How many steps a plan may carry. Same ceiling as `update_plan`'s checklist —
/// past this a "plan" is a transcript of the work rather than a description of
/// it, and it stops being something a person can read and edit.
pub const MAX_STEPS: usize = 30;

/// One step of a plan.
///
/// `files` and `risk` are what turn a checklist into something reviewable: the
/// user's question in front of a plan is "what is it going to touch, and which
/// bit of this could hurt", and a bare list of intentions answers neither.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    /// Stable across edits and status updates, so the UI and the executing turn
    /// can talk about the same step after a reorder.
    #[serde(default = "new_id")]
    pub id: String,
    /// What is being done, in a few words.
    pub step: String,
    /// Why — the sentence that makes the step reviewable rather than a label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// The files this step expects to touch, as the model wrote them.
    #[serde(default)]
    pub files: Vec<String>,
    /// "low" | "medium" | "high".
    #[serde(default = "default_risk")]
    pub risk: String,
    /// "pending" | "in_progress" | "done" | "skipped" | "failed".
    #[serde(default = "default_status")]
    pub status: String,
    /// Free-text note from the executing turn (or the user's annotation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Why a failed step failed. Kept so a failure is inspectable afterwards
    /// rather than only visible as a red mark while it scrolls past.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_risk() -> String {
    "low".into()
}
fn default_status() -> String {
    "pending".into()
}

impl PlanStep {
    /// Normalise a step as the model or the frontend wrote it: unknown risks and
    /// statuses fall back rather than failing the call, and a bare string is
    /// accepted as a step with no detail (models reliably shortcut to that).
    pub fn sanitize(raw: &Value) -> Option<Self> {
        let (text, obj) = match raw {
            Value::String(s) => (s.trim().to_string(), None),
            Value::Object(_) => (
                raw.get("step")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                Some(raw),
            ),
            _ => return None,
        };
        if text.is_empty() {
            return None;
        }
        let get_str = |key: &str| {
            obj.and_then(|o| o.get(key))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let risk = get_str("risk")
            .map(|r| r.to_ascii_lowercase())
            .filter(|r| matches!(r.as_str(), "low" | "medium" | "high"))
            .unwrap_or_else(default_risk);
        let status = get_str("status")
            .map(|s| s.to_ascii_lowercase())
            .map(|s| match s.as_str() {
                "doing" | "active" | "current" => "in_progress".to_string(),
                "complete" | "completed" | "finished" => "done".to_string(),
                other => other.to_string(),
            })
            .filter(|s| {
                matches!(
                    s.as_str(),
                    "pending" | "in_progress" | "done" | "skipped" | "failed"
                )
            })
            .unwrap_or_else(default_status);
        let files = obj
            .and_then(|o| o.get("files"))
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|f| f.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        Some(Self {
            id: get_str("id").unwrap_or_else(new_id),
            step: text,
            intent: get_str("intent"),
            files,
            risk,
            status,
            note: get_str("note"),
            error: get_str("error"),
        })
    }
}

/// Parse and normalise a whole steps array, dropping entries that carry nothing.
pub fn sanitize_steps(raw: &[Value]) -> Vec<PlanStep> {
    raw.iter()
        .filter_map(PlanStep::sanitize)
        .take(MAX_STEPS)
        .collect()
}

/// A plan as stored. `steps` is the JSON blob; [`Plan::parsed_steps`] reads it.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub chat_id: String,
    pub zone_id: Option<String>,
    pub parent_plan_id: Option<String>,
    pub title: String,
    pub goal: Option<String>,
    /// JSON array of [`PlanStep`].
    pub steps: String,
    pub status: String,
    pub edited_by_user: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub approved_at: Option<i64>,
}

pub const PLAN_COLS: &str = "id, chat_id, zone_id, parent_plan_id, title, goal, steps, status, \
     edited_by_user, created_at, updated_at, approved_at";

impl Plan {
    pub fn parsed_steps(&self) -> Vec<PlanStep> {
        serde_json::from_str(&self.steps).unwrap_or_default()
    }

    /// The plan as the model should see it in a tool result or a task list.
    pub fn to_json(&self) -> Value {
        let steps = self.parsed_steps();
        let done = steps.iter().filter(|s| s.status == "done").count();
        json!({
            "planId": self.id,
            "title": self.title,
            "goal": self.goal,
            "status": self.status,
            "steps": steps,
            "done": done,
            "total": steps.len(),
            "editedByUser": self.edited_by_user,
        })
    }
}

// ── Chat mode ────────────────────────────────────────────────────────────────

/// Is this chat in plan mode right now? Read once per turn and again after any
/// tool call, since `enter_plan_mode` / `exit_plan_mode` move it mid-turn.
pub async fn in_plan_mode(db: &SqlitePool, chat_id: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT plan_mode FROM chats WHERE id = ?1")
        .bind(chat_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

pub async fn set_plan_mode(db: &SqlitePool, chat_id: &str, on: bool) -> AppResult<()> {
    sqlx::query("UPDATE chats SET plan_mode = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(on)
        .bind(now_ts())
        .bind(chat_id)
        .execute(db)
        .await?;
    Ok(())
}

// ── Tool gating ──────────────────────────────────────────────────────────────

/// Tools that stay available in plan mode.
///
/// An allowlist rather than a deny-list, deliberately: a new tool that nobody
/// remembered to classify should be unavailable while planning, not available.
/// The rule is "this call cannot change anything outside the conversation" —
/// reads, searches, the network reads, the model's own bookkeeping, and the two
/// tools that drive the mode itself.
///
/// `http_request` is *not* here despite often being a read: it is the one tool
/// whose safety story is entirely the approval prompt, and a POST is spelled the
/// same as a GET.
pub fn allowed_in_plan_mode(name: &str) -> bool {
    matches!(
        name,
        // Reading the world.
        "read_file"
            | "list_directory"
            | "find_files"
            | "search_file_text"
            | "search_local_files"
            | "search_knowledge"
            | "present_file"
            | "smart_search"
            | "smart_fetch"
            | "smart_crawl"
            | "get_current_datetime"
            | "load_skill"
            | "read_memory"
            | "list_zones"
            | "list_subchats"
            | "read_subchat"
            | "team_status"
            | "terminal_read"
            | "terminal_list"
            | "app_read"
            // Talking to the user, and the plan itself.
            | "ask_user"
            | "update_plan"
            | "enter_plan_mode"
            | "exit_plan_mode"
    )
}

/// The refusal a withheld tool gets if a model calls it anyway. Names the mode
/// and the way out, because a model that reads "not permitted" with no route
/// forward tends to either give up or try the same call again.
pub fn refusal(name: &str) -> String {
    json!({
        "error": format!(
            "`{name}` is unavailable in plan mode — nothing may be changed until the user \
             approves a plan."
        ),
        "hint": "Finish investigating with the read-only tools, then call `exit_plan_mode` \
                 with your proposed steps. The user approves (and may edit) the plan, and \
                 execution starts from there.",
    })
    .to_string()
}

// ── Storage ──────────────────────────────────────────────────────────────────

/// Write a proposed plan. Any earlier draft for the same chat and participant is
/// marked `superseded` — a chat has at most one plan waiting on the user, or the
/// approval card has to ask which one it means.
pub async fn save_draft(
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
    title: &str,
    goal: Option<&str>,
    steps: &[PlanStep],
) -> AppResult<Plan> {
    let now = now_ts();
    sqlx::query(
        "UPDATE plans SET status = 'superseded', updated_at = ?1
         WHERE chat_id = ?2 AND status = 'draft'
           AND (zone_id IS ?3 OR (zone_id IS NULL AND ?3 IS NULL))",
    )
    .bind(now)
    .bind(chat_id)
    .bind(zone_id)
    .execute(db)
    .await?;

    let id = new_id();
    sqlx::query(
        "INSERT INTO plans (id, chat_id, zone_id, title, goal, steps, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7, ?7)",
    )
    .bind(&id)
    .bind(chat_id)
    .bind(zone_id)
    .bind(title)
    .bind(goal)
    .bind(serde_json::to_string(steps).unwrap_or_else(|_| "[]".into()))
    .bind(now)
    .execute(db)
    .await?;

    get(db, &id).await
}

pub async fn get(db: &SqlitePool, id: &str) -> AppResult<Plan> {
    let plan = sqlx::query_as::<_, Plan>(&format!("SELECT {PLAN_COLS} FROM plans WHERE id = ?1"))
        .bind(id)
        .fetch_one(db)
        .await?;
    Ok(plan)
}

/// Every plan of a chat, oldest first — the transcript's own record of what was
/// proposed, what was agreed to, and what ran.
pub async fn list_for_chat(db: &SqlitePool, chat_id: &str) -> AppResult<Vec<Plan>> {
    let rows = sqlx::query_as::<_, Plan>(&format!(
        "SELECT {PLAN_COLS} FROM plans WHERE chat_id = ?1 ORDER BY created_at ASC"
    ))
    .bind(chat_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// The plan a turn should be working through: the newest approved-or-executing
/// one for this chat and participant. `None` for an ordinary unplanned turn.
pub async fn active_plan(
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
) -> Option<Plan> {
    sqlx::query_as::<_, Plan>(&format!(
        "SELECT {PLAN_COLS} FROM plans
         WHERE chat_id = ?1
           AND (zone_id IS ?2 OR (zone_id IS NULL AND ?2 IS NULL))
           AND status IN ('approved', 'executing')
         ORDER BY created_at DESC LIMIT 1"
    ))
    .bind(chat_id)
    .bind(zone_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

/// The draft waiting on the user, if any.
pub async fn pending_draft(db: &SqlitePool, chat_id: &str) -> Option<Plan> {
    sqlx::query_as::<_, Plan>(&format!(
        "SELECT {PLAN_COLS} FROM plans WHERE chat_id = ?1 AND status = 'draft'
         ORDER BY created_at DESC LIMIT 1"
    ))
    .bind(chat_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

pub async fn set_status(db: &SqlitePool, id: &str, status: &str) -> AppResult<()> {
    sqlx::query("UPDATE plans SET status = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(status)
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Replace a plan's steps — the user's edit before approving, and the executing
/// turn's status updates afterwards.
pub async fn write_steps(db: &SqlitePool, id: &str, steps: &[PlanStep]) -> AppResult<()> {
    sqlx::query("UPDATE plans SET steps = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(serde_json::to_string(steps).unwrap_or_else(|_| "[]".into()))
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// The user agreed to it: the steps they agreed to (which may not be the ones
/// proposed) are written back, the plan becomes the next turn's task list, and
/// the chat leaves plan mode.
pub async fn approve(
    db: &SqlitePool,
    id: &str,
    steps: Option<&[PlanStep]>,
    edited: bool,
) -> AppResult<Plan> {
    if let Some(s) = steps {
        write_steps(db, id, s).await?;
    }
    let now = now_ts();
    sqlx::query(
        "UPDATE plans SET status = 'approved', approved_at = ?1, updated_at = ?1,
                          edited_by_user = edited_by_user | ?2
         WHERE id = ?3",
    )
    .bind(now)
    .bind(edited)
    .bind(id)
    .execute(db)
    .await?;

    let plan = get(db, id).await?;
    set_plan_mode(db, &plan.chat_id, false).await?;
    Ok(plan)
}

// ── Handing an approved plan to the executing turn ───────────────────────────

/// The task list injected into the system prompt of a turn that has an approved
/// plan. This is the "cannot silently substitute a different plan" half: the
/// steps come out of the table the user approved, on every request of the turn,
/// so drift is corrected each time the model is called rather than merely
/// discouraged once.
pub fn task_list_block(plan: &Plan) -> String {
    let steps = plan.parsed_steps();
    let mut out = String::from(
        "## The approved plan\n\n\
         The user approved this plan. It is the task list for this turn — work through it in \
         order. Do not re-plan, reorder, or substitute steps: if the plan turns out to be wrong, \
         say so and stop rather than quietly doing something else.\n\n",
    );
    if !plan.title.trim().is_empty() {
        out.push_str(&format!("**{}**\n\n", plan.title.trim()));
    }
    if let Some(goal) = plan.goal.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
        out.push_str(&format!("Goal: {goal}\n\n"));
    }
    for (i, s) in steps.iter().enumerate() {
        let mark = match s.status.as_str() {
            "done" => "x",
            "in_progress" => ">",
            "skipped" => "-",
            "failed" => "!",
            _ => " ",
        };
        out.push_str(&format!("{}. [{mark}] {}", i + 1, s.step));
        if let Some(intent) = s.intent.as_deref().filter(|t| !t.trim().is_empty()) {
            out.push_str(&format!(" — {intent}"));
        }
        if !s.files.is_empty() {
            out.push_str(&format!(" (files: {})", s.files.join(", ")));
        }
        if let Some(err) = s.error.as_deref().filter(|t| !t.trim().is_empty()) {
            out.push_str(&format!(" [failed earlier: {err}]"));
        }
        out.push('\n');
    }
    if plan.edited_by_user {
        out.push_str(
            "\nThe user edited this plan before approving it — the steps above are theirs, \
             not the ones you proposed.\n",
        );
    }
    out.push_str(
        "\nKeep the plan's state current with `update_plan`: send every step, in this order, \
         with exactly one marked `in_progress`. Step text is fixed — only the statuses are \
         yours to change.\n",
    );
    out
}

/// The system snippet a chat in plan mode gets.
///
/// Structured as phases because every harness that does this well does: a model
/// told only "plan first" investigates for one file and then writes a plan about
/// the codebase it imagines. The last paragraph is the part unique to us — the
/// tools are genuinely gone, so a model that tries one is not being disobedient,
/// it is wasting its own step.
pub fn plan_mode_preamble() -> String {
    "## Plan mode is active\n\n\
     The user wants the work described before any of it happens. Nothing you do this turn may \
     change anything: every tool that writes, moves, deletes, runs a command, or reaches the \
     network to change something has been withheld from your toolset for the duration. The \
     read-only tools are all there, and using them is the point.\n\n\
     Work in this order:\n\
     1. **Understand.** Read the files that are actually involved — not the ones you assume \
        exist. Search rather than guess. If the request is ambiguous in a way only the user can \
        settle, ask with `ask_user` now, not after they approve a plan built on a guess.\n\
     2. **Design.** Decide the approach, and be honest about what it costs and what it risks.\n\
     3. **Check.** Look for the step you have not thought about: the migration, the test, the \
        caller elsewhere that this breaks.\n\
     4. **Propose.** Call `exit_plan_mode` with the plan as ordered steps. Each step says what \
        is done, why, the files it expects to touch, and its risk. Small and specific beats \
        large and vague — a step nobody can check is not a step.\n\n\
     `exit_plan_mode` hands the plan to the user, who edits and approves it. That call *is* the \
     request for approval — do not also ask in prose whether the plan is acceptable. If the \
     answer is no, you stay in plan mode with their comments and revise.\n\n\
     If the request turns out not to need any changes at all — a question, an explanation, a \
     piece of research — answer it directly and do not call `exit_plan_mode`. Plan mode is for \
     work that is going to modify something."
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mode's whole promise is that nothing changes while it is on, so the
    /// allowlist is tested from the deny side: every tool that mutates must be
    /// out. A new mutating tool added without thinking about plan mode fails
    /// here rather than in a user's working tree.
    #[test]
    fn mutating_tools_are_withheld() {
        for name in [
            "create_file",
            "edit_file",
            "delete_file",
            "move_file",
            "copy_file",
            "create_folder",
            "run_command",
            "wsl_exec",
            "execute_code",
            "http_request",
            "terminal_start",
            "terminal_write",
            "terminal_stop",
            "app_control",
            "spawn_subagent",
            "send_subchat_message",
            "save_memory",
            "delete_memory",
            "create_skill",
            "update_skill",
            "change_zone",
            "tag_chat",
            "compact_context",
            "claim_files",
            "release_files",
            "post_note",
        ] {
            assert!(
                !allowed_in_plan_mode(name),
                "{name} is available in plan mode but changes something"
            );
        }
    }

    #[test]
    fn reads_and_the_mode_itself_survive() {
        for name in [
            "read_file",
            "list_directory",
            "find_files",
            "search_file_text",
            "smart_search",
            "ask_user",
            "update_plan",
            "exit_plan_mode",
        ] {
            assert!(allowed_in_plan_mode(name), "{name} should survive plan mode");
        }
    }

    /// An unknown tool — an MCP server's, or one added later — is withheld.
    #[test]
    fn unknown_tools_are_withheld() {
        assert!(!allowed_in_plan_mode("mcp__github__create_issue"));
        assert!(!allowed_in_plan_mode("some_tool_invented_next_year"));
    }

    #[test]
    fn steps_are_sanitized_rather_than_rejected() {
        let raw = vec![
            json!("just a string"),
            json!({ "step": "  padded  ", "risk": "HIGH", "status": "completed",
                    "files": ["a.rs", "  ", "b.rs"], "intent": "why" }),
            json!({ "step": "", "risk": "low" }),
            json!({ "step": "bad enums", "risk": "catastrophic", "status": "wobbling" }),
            json!(42),
        ];
        let steps = sanitize_steps(&raw);
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].step, "just a string");
        assert_eq!(steps[0].risk, "low");
        assert_eq!(steps[1].step, "padded");
        assert_eq!(steps[1].risk, "high");
        assert_eq!(steps[1].status, "done");
        assert_eq!(steps[1].files, vec!["a.rs", "b.rs"]);
        // An enum we don't recognise falls back rather than failing the call.
        assert_eq!(steps[2].risk, "low");
        assert_eq!(steps[2].status, "pending");
    }

    #[test]
    fn task_list_names_the_user_edit() {
        let plan = Plan {
            id: "p1".into(),
            chat_id: "c1".into(),
            zone_id: None,
            parent_plan_id: None,
            title: "Add plan mode".into(),
            goal: Some("ship 0.12.0".into()),
            steps: serde_json::to_string(&sanitize_steps(&[
                json!({ "step": "migration", "files": ["033.sql"], "status": "done" }),
                json!({ "step": "gate the tools", "intent": "hard enforcement" }),
            ]))
            .unwrap(),
            status: "approved".into(),
            edited_by_user: true,
            created_at: 0,
            updated_at: 0,
            approved_at: Some(1),
        };
        let block = task_list_block(&plan);
        assert!(block.contains("1. [x] migration"));
        assert!(block.contains("(files: 033.sql)"));
        assert!(block.contains("gate the tools — hard enforcement"));
        assert!(block.contains("The user edited this plan"));
    }
}
