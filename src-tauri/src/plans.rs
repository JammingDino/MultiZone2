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
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// How many steps a plan may carry. Same ceiling as `update_plan`'s checklist —
/// past this a "plan" is a transcript of the work rather than a description of
/// it, and it stops being something a person can read and edit.
pub const MAX_STEPS: usize = 30;

/// Per-step `detail` ceiling. Generous — the whole point of 0.14.6 is that a
/// step gets a specification and not a label — but not unbounded: past this the
/// model is writing the deliverable into the plan instead of planning it, and
/// every one of these is re-sent to the model on every request of the executing
/// turn.
pub const MAX_DETAIL_CHARS: usize = 6_000;

/// Plan-level `context` ceiling, on the same reasoning.
pub const MAX_CONTEXT_CHARS: usize = 12_000;

/// One step of a plan.
///
/// `files` and `risk` are what turn a checklist into something reviewable: the
/// user's question in front of a plan is "what is it going to touch, and which
/// bit of this could hurt", and a bare list of intentions answers neither.
///
/// `detail` and `acceptance` (0.14.6) are what turn it into something *worth*
/// reviewing. A step is a heading; the plan is the paragraph under it — the
/// options that were weighed, the specific choice, the numbers, the thing that
/// will go wrong. Without somewhere to put that, a model asked to plan writes
/// eight labels and the user approves a document they have not actually read.
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
    /// The specification: Markdown, as long as the step deserves. The approach
    /// and the ones rejected, the concrete parameters, the edge cases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// How anyone tells this step is actually finished and correct.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<String>,
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
        // Clamped rather than refused: a model that writes 8 000 characters of
        // detail has done the thinking, and losing the call over the last 2 000
        // would cost more than the truncation does.
        let clamp = |v: Option<String>, max: usize| v.map(|s| clamp_text(&s, max));
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
            detail: clamp(get_str("detail"), MAX_DETAIL_CHARS),
            acceptance: clamp(get_str("acceptance"), MAX_DETAIL_CHARS / 4),
            files,
            risk,
            status,
            note: get_str("note"),
            error: get_str("error"),
        })
    }

    /// How much of a specification this step actually carries. Used to tell the
    /// model, in the tool result it gets back, that it filed labels rather than
    /// a plan — at the point where it can still fix it.
    pub fn is_thin(&self) -> bool {
        self.detail.as_deref().map(str::trim).unwrap_or("").len() < 120
    }
}

/// Truncate on a character boundary, saying so. Never panics on multi-byte text.
pub fn clamp_text(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}\n\n_(truncated at {max} characters)_")
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
    /// Everything true of the plan before step 1 (0.14.6): the scope decision,
    /// the assumptions, what the research turned up, what is still open.
    #[serde(default)]
    pub context: Option<String>,
    /// Where the plan was written on disk, if it was. Absolute.
    #[serde(default)]
    pub doc_path: Option<String>,
    /// JSON array of [`PlanStep`].
    pub steps: String,
    pub status: String,
    pub edited_by_user: bool,
    /// The user asked for the run to finish the current step and stop (0.12.1).
    /// Honoured at the next step boundary, then cleared.
    pub stop_requested: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub approved_at: Option<i64>,
}

pub const PLAN_COLS: &str = "id, chat_id, zone_id, parent_plan_id, title, goal, context, \
     doc_path, steps, status, edited_by_user, stop_requested, created_at, updated_at, approved_at";

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
            "context": self.context,
            "docPath": self.doc_path,
            "status": self.status,
            "steps": steps,
            "done": done,
            "total": steps.len(),
            "editedByUser": self.edited_by_user,
        })
    }
}

// ── The plan document ────────────────────────────────────────────────────────

/// Where plan documents are written. Set once at startup from the app data dir,
/// the same way the checkpoint store and the managed skills folder are.
static DOCS_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn set_docs_root(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = DOCS_ROOT.set(dir);
}

pub fn docs_root() -> Option<&'static Path> {
    DOCS_ROOT.get().map(PathBuf::as_path)
}

/// Filename-safe form of a title, for a path a human can recognise in a folder.
fn slug(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let s: String = s.chars().take(48).collect();
    if s.is_empty() { "plan".into() } else { s }
}

/// The plan as a Markdown document — the artifact the user opens and the model
/// reads back later.
///
/// Deliberately the whole plan and not a summary of it: this file is the only
/// place a step's `detail` survives once the transcript is compacted, and a plan
/// you have to reconstruct from a tool-call history is not a plan you can be
/// held to.
pub fn render_doc(plan: &Plan) -> String {
    let steps = plan.parsed_steps();
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", plan.title.trim()));
    if let Some(goal) = plan.goal.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
        out.push_str(&format!("**Goal.** {goal}\n\n"));
    }
    out.push_str(&format!(
        "<!-- plan {} · chat {} · status {} -->\n\n",
        plan.id, plan.chat_id, plan.status
    ));
    if let Some(ctx) = plan.context.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        out.push_str("## Context\n\n");
        out.push_str(ctx);
        out.push_str("\n\n");
    }
    out.push_str("## Steps\n\n");
    for (i, s) in steps.iter().enumerate() {
        out.push_str(&format!("### {}. {}\n\n", i + 1, s.step.trim()));
        let mut meta: Vec<String> = Vec::new();
        if s.risk != "low" {
            meta.push(format!("risk: **{}**", s.risk));
        }
        if !s.files.is_empty() {
            meta.push(format!("files: `{}`", s.files.join("`, `")));
        }
        if s.status != "pending" {
            meta.push(format!("status: {}", s.status));
        }
        if !meta.is_empty() {
            out.push_str(&format!("_{}_\n\n", meta.join(" · ")));
        }
        if let Some(intent) = s.intent.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            out.push_str(&format!("**Why.** {intent}\n\n"));
        }
        if let Some(detail) = s.detail.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            out.push_str(detail);
            out.push_str("\n\n");
        }
        if let Some(acc) = s.acceptance.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            out.push_str(&format!("**Done when.** {acc}\n\n"));
        }
        if let Some(err) = s.error.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            out.push_str(&format!("> Failed: {err}\n\n"));
        }
    }
    out
}

/// Write (or rewrite) the plan's document and record where it went.
///
/// Best-effort in the same sense the markdown mirror is: a plan that could not
/// be written to disk is still a plan, and failing the model's call over a
/// filesystem error would lose the thinking that produced it. Returns the path
/// when one was written.
pub async fn write_doc(db: &SqlitePool, plan: &Plan) -> Option<String> {
    let root = docs_root()?;
    if let Err(e) = std::fs::create_dir_all(root) {
        tracing::warn!("plan docs dir: {e}");
        return None;
    }
    let path = root.join(format!("{}--{}.md", slug(&plan.title), plan.id));
    if let Err(e) = std::fs::write(&path, render_doc(plan)) {
        tracing::warn!("writing plan doc {}: {e}", path.display());
        return None;
    }
    let as_str = path.to_string_lossy().to_string();
    if plan.doc_path.as_deref() != Some(as_str.as_str()) {
        let _ = sqlx::query("UPDATE plans SET doc_path = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(&as_str)
            .bind(now_ts())
            .bind(&plan.id)
            .execute(db)
            .await;
    }
    Some(as_str)
}

/// Re-read and rewrite a plan's document after its row changed. Swallows a
/// missing plan — every caller is already past the point where that matters.
pub async fn refresh_doc(db: &SqlitePool, plan_id: &str) -> Option<String> {
    let plan = get(db, plan_id).await.ok()?;
    write_doc(db, &plan).await
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
            // Drafting the plan a step at a time, and reading one back (0.14.6).
            // `draft_plan_step` writes, but only to the plan the user is about
            // to be shown and to that plan's own document — it cannot reach
            // anything the mode exists to protect.
            | "draft_plan_step"
            | "read_plan"
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
    context: Option<&str>,
    steps: &[PlanStep],
) -> AppResult<Plan> {
    let now = now_ts();
    sqlx::query(
        "UPDATE plans SET status = 'superseded', updated_at = ?1
         WHERE chat_id = ?2 AND status IN ('draft', 'drafting')
           AND (zone_id IS ?3 OR (zone_id IS NULL AND ?3 IS NULL))",
    )
    .bind(now)
    .bind(chat_id)
    .bind(zone_id)
    .execute(db)
    .await?;

    let id = new_id();
    sqlx::query(
        "INSERT INTO plans (id, chat_id, zone_id, title, goal, context, steps, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?8)",
    )
    .bind(&id)
    .bind(chat_id)
    .bind(zone_id)
    .bind(title)
    .bind(goal)
    .bind(context.map(|c| clamp_text(c, MAX_CONTEXT_CHARS)))
    .bind(serde_json::to_string(steps).unwrap_or_else(|_| "[]".into()))
    .bind(now)
    .execute(db)
    .await?;

    let plan = get(db, &id).await?;
    write_doc(db, &plan).await;
    get(db, &id).await
}

// ── Drafting a plan a step at a time (0.14.6) ────────────────────────────────

/// The plan this participant is currently writing, if any.
///
/// A `drafting` plan is one the user has not been shown: it exists so a long
/// plan can be built over several tool calls — think about step 1 properly,
/// write it, *then* think about step 2 — rather than being squeezed into one
/// giant argument blob where the eighth step is always the worst one.
pub async fn working_draft(db: &SqlitePool, chat_id: &str, zone_id: Option<&str>) -> Option<Plan> {
    sqlx::query_as::<_, Plan>(&format!(
        "SELECT {PLAN_COLS} FROM plans
         WHERE chat_id = ?1 AND status = 'drafting'
           AND (zone_id IS ?2 OR (zone_id IS NULL AND ?2 IS NULL))
         ORDER BY created_at DESC LIMIT 1"
    ))
    .bind(chat_id)
    .bind(zone_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

/// Start a working draft, or update the header of the one already open.
pub async fn open_working_draft(
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
    title: Option<&str>,
    goal: Option<&str>,
    context: Option<&str>,
) -> AppResult<Plan> {
    let now = now_ts();
    let context = context.map(|c| clamp_text(c, MAX_CONTEXT_CHARS));
    if let Some(existing) = working_draft(db, chat_id, zone_id).await {
        sqlx::query(
            "UPDATE plans SET title = COALESCE(?1, title), goal = COALESCE(?2, goal),
                              context = COALESCE(?3, context), updated_at = ?4
             WHERE id = ?5",
        )
        .bind(title.map(str::trim).filter(|t| !t.is_empty()))
        .bind(goal.map(str::trim).filter(|t| !t.is_empty()))
        .bind(context.as_deref())
        .bind(now)
        .bind(&existing.id)
        .execute(db)
        .await?;
        return get(db, &existing.id).await;
    }

    let id = new_id();
    sqlx::query(
        "INSERT INTO plans (id, chat_id, zone_id, title, goal, context, steps, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', 'drafting', ?7, ?7)",
    )
    .bind(&id)
    .bind(chat_id)
    .bind(zone_id)
    .bind(title.map(str::trim).filter(|t| !t.is_empty()).unwrap_or("Plan"))
    .bind(goal.map(str::trim).filter(|t| !t.is_empty()))
    .bind(context.as_deref())
    .bind(now)
    .execute(db)
    .await?;
    get(db, &id).await
}

/// Append a step to a working draft, or rewrite one already in it.
///
/// `replace_index` is 1-based to match how the steps are numbered everywhere
/// the model has seen them — in the tool result, in the document, and in the UI.
pub async fn put_draft_step(
    db: &SqlitePool,
    plan_id: &str,
    step: PlanStep,
    replace_index: Option<usize>,
) -> AppResult<Plan> {
    let plan = get(db, plan_id).await?;
    let mut steps = plan.parsed_steps();
    match replace_index {
        Some(i) if i >= 1 && i <= steps.len() => {
            // Keep the id the step already had, so a rewrite is an edit of the
            // same step rather than a different one at the same position.
            let id = steps[i - 1].id.clone();
            steps[i - 1] = PlanStep { id, ..step };
        }
        _ => {
            if steps.len() >= MAX_STEPS {
                return Err(crate::error::AppError::Other(format!(
                    "this plan already has {MAX_STEPS} steps"
                )));
            }
            steps.push(step);
        }
    }
    write_steps(db, plan_id, &steps).await?;
    let plan = get(db, plan_id).await?;
    write_doc(db, &plan).await;
    get(db, plan_id).await
}

/// Turn the working draft into the proposal the user is shown.
pub async fn file_working_draft(db: &SqlitePool, plan_id: &str) -> AppResult<Plan> {
    let plan = get(db, plan_id).await?;
    let now = now_ts();
    // Any *other* draft waiting on the user in this chat steps aside — the
    // approval card can only ask about one plan at a time.
    sqlx::query(
        "UPDATE plans SET status = 'superseded', updated_at = ?1
         WHERE chat_id = ?2 AND id != ?3 AND status IN ('draft', 'drafting')
           AND (zone_id IS ?4 OR (zone_id IS NULL AND ?4 IS NULL))",
    )
    .bind(now)
    .bind(&plan.chat_id)
    .bind(plan_id)
    .bind(plan.zone_id.as_deref())
    .execute(db)
    .await?;
    sqlx::query("UPDATE plans SET status = 'draft', updated_at = ?1 WHERE id = ?2")
        .bind(now)
        .bind(plan_id)
        .execute(db)
        .await?;
    let plan = get(db, plan_id).await?;
    write_doc(db, &plan).await;
    get(db, plan_id).await
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

/// Has this chat ever planned? Gates offering `read_plan` outside plan mode —
/// a tool that would return "no plans yet" is worth nothing in the request.
pub async fn chat_has_plans(db: &SqlitePool, chat_id: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM plans WHERE chat_id = ?1)")
        .bind(chat_id)
        .fetch_one(db)
        .await
        .map(|n| n == 1)
        .unwrap_or(false)
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
    // The document on disk is what the model reads back mid-run, so it has to
    // be the plan that was *approved* — including the user's edits to it.
    write_doc(db, &plan).await;
    get(db, id).await
}

/// "Finish this step, then stop" (0.12.1). Recorded rather than acted on
/// immediately: the turn is mid-tool-call, and interrupting there is the
/// cancellation this exists to avoid.
pub async fn request_stop(db: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("UPDATE plans SET stop_requested = 1, updated_at = ?1 WHERE id = ?2")
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Take the request off the plan once the loop has honoured it, so a later run
/// of the same plan doesn't stop on a stale flag.
pub async fn clear_stop(db: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("UPDATE plans SET stop_requested = 0, updated_at = ?1 WHERE id = ?2")
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Hang a sub-agent's plan off the plan its leader is executing, so the two
/// render as one tree rather than as unrelated checklists in chats the user has
/// to go and find. Best-effort by design: a subchat whose parent has no active
/// plan is simply a plan with no parent.
pub async fn link_to_parent_plan(db: &SqlitePool, plan_id: &str, chat_id: &str) -> AppResult<()> {
    let parent_chat: Option<String> =
        sqlx::query_scalar("SELECT parent_chat_id FROM chats WHERE id = ?1")
            .bind(chat_id)
            .fetch_optional(db)
            .await?
            .flatten();
    let Some(parent_chat) = parent_chat else {
        return Ok(());
    };
    let Some(parent) = active_plan(db, &parent_chat, None).await else {
        return Ok(());
    };
    sqlx::query("UPDATE plans SET parent_plan_id = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(&parent.id)
        .bind(now_ts())
        .bind(plan_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Every plan in this chat and in the subchats descended from it — the leader's
/// and its sub-agents', which is the first surface Multizone orchestration has
/// had for holding a task at all.
pub async fn tree_for_chat(db: &SqlitePool, chat_id: &str) -> AppResult<Vec<Plan>> {
    let rows = sqlx::query_as::<_, Plan>(&format!(
        "WITH RECURSIVE descendants(id) AS (
             SELECT ?1
             UNION
             SELECT c.id FROM chats c JOIN descendants d ON c.parent_chat_id = d.id
         )
         SELECT {PLAN_COLS} FROM plans
         WHERE chat_id IN (SELECT id FROM descendants)
         ORDER BY created_at ASC"
    ))
    .bind(chat_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
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
    if let Some(ctx) = plan.context.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        out.push_str(&format!("### Context agreed with the plan\n\n{ctx}\n\n"));
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
        // The specification, indented under its step. This is the half of the
        // plan that says *how*, and a turn executing from headings alone is
        // re-deciding everything the user already approved.
        if let Some(detail) = s.detail.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            for line in detail.lines() {
                out.push_str(&format!("   {line}\n"));
            }
        }
        if let Some(acc) = s.acceptance.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            out.push_str(&format!("   Done when: {acc}\n"));
        }
        if s.detail.is_some() || s.acceptance.is_some() {
            out.push('\n');
        }
    }
    if let Some(doc) = plan.doc_path.as_deref().filter(|p| !p.is_empty()) {
        out.push_str(&format!(
            "\nThe full plan is also written to `{doc}` — read it back with `read_plan` if this \
             summary has been compacted out of your context.\n"
        ));
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
         yours to change.\n\n\
         A step that fails does not have to end the run: mark it `failed` with a `note` saying \
         why, then decide — carry on with the steps that do not depend on it, or stop and \
         report. Say which you chose. The user may also strike a step or add one while you \
         work; the list above is re-read on every step, so treat it as current and do not \
         reinstate something they removed.\n",
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
     network to change something has been withheld from your toolset for the duration.\n\n\
     Everything that only *reads* is still there and you are expected to use it hard. Search the \
     web (`smart_search`, `smart_fetch`, `smart_crawl`), read the files, list the directories, \
     search the codebase, read your memory and the knowledge base. There is no budget on this you \
     need to conserve. A plan written without looking is a guess with numbering.\n\n\
     ### Work in five phases\n\n\
     **1. Ask.** If the request is ambiguous in a way that changes the plan — scope, audience, \
     length, which of two readings, what already exists — call `ask_user` *now*, before any \
     research. Ask several things in one call rather than one at a time. Do not ask what you \
     could find out yourself, and do not ask permission to start.\n\n\
     **2. Research.** Read what is actually involved rather than what you assume exists. Follow \
     the leads you find. Stop when new searches keep returning what you already have.\n\n\
     **3. Draft, one step at a time.** Call `draft_plan_step` repeatedly. The first call carries \
     the `title`, the `goal` and the `context`; each call after it adds one step. Finish a step \
     properly before you think about the next one — that is what this tool exists for, and it is \
     why you do not have to compress the whole plan into one argument blob.\n\n\
     **4. Check.** Re-read what you have drafted. Look for the step you have not thought about: \
     the migration, the test, the caller elsewhere that this breaks, the thing that has to happen \
     first. Rewrite a weak step with `draft_plan_step` and `replace_index`.\n\n\
     **5. Propose.** Call `exit_plan_mode` to hand the finished plan to the user.\n\n\
     ### What a step has to contain\n\n\
     A step is a heading. The plan is the paragraph under it. `step` names the work in a few \
     words; `detail` is the specification, and it is the part that matters:\n\n\
     - the approach, **and the alternatives you rejected, and why**\n\
     - the concrete parameters — the numbers, names, formats, thresholds, versions, sizes. Not \
       \"choose a suitable font size\" but \"11pt body, 1.15 leading, 65–75 characters per line\"\n\
     - what specifically goes wrong here, and what you would do about it\n\
     - anything the user should push back on before it happens\n\n\
     Write `detail` as Markdown — headings, lists and tables are all fine, and a table is often \
     the right shape for a set of parameters. Give `acceptance` too: how anyone tells this step \
     is genuinely finished rather than nominally done.\n\n\
     `context` is the part of the plan that is not a step at all: the scope decision you made and \
     the ones you turned down, the assumptions everything rests on, what the research turned up, \
     and what is still open. If you had to guess at something, say so there.\n\n\
     Eight steps of one line each is not a plan; it is a table of contents. If a step's detail \
     would be one obvious sentence, that step is too small — fold it into its neighbour.\n\n\
     ### Filing it\n\n\
     `exit_plan_mode` hands the plan to the user, who reads, edits and approves it. That call \
     *is* the request for approval — do not also ask in prose whether the plan is acceptable, and \
     do not restate the plan in your answer: they are looking at it. If the answer is no, you \
     stay in plan mode with their comments and revise.\n\n\
     The plan is also written to a Markdown file, and `read_plan` reads it back — so a plan \
     agreed today is still readable in full next week, after this conversation has been \
     compacted.\n\n\
     If the request turns out to be a question with a short answer, answer it and do not call \
     `exit_plan_mode` — you are already here, so say so briefly rather than filing a two-step \
     plan for something you could have done. But a substantial deliverable *does* want a plan \
     whether or not it changes a file: a report, a document, a design, a piece of research, an \
     analysis. What makes a plan worth having is that the shape of the work should be agreed \
     before the effort goes in — not whether the work happens to end in a file write."
        .to_string()
}

/// The system snippet a chat gets when planning is available and *not* on.
///
/// Nothing said so before 0.14.6. Plan mode existed entirely in one tool
/// description among twenty, and the one thing the prompt did say about planning
/// pointed at `update_plan` — a different tool, for progress on work already
/// under way. So a user asking in plain words for a plan reliably got a numbered
/// list in prose: correct-looking, and impossible to edit, reorder, approve or
/// execute. This is the missing sentence.
pub fn plan_offer_preamble() -> String {
    "## Plans the user can act on\n\n\
     `enter_plan_mode` is how you give the user a plan. It produces an ordered list of steps \
     they read, reorder, rewrite and approve, and the approved version becomes the task list you \
     are then held to. A plan written as prose in your answer is none of those things — nobody \
     can edit it, nothing executes it, and it is the wrong answer to a request for a plan.\n\n\
     Call `enter_plan_mode` when the user asks for a plan, an approach, an outline or a strategy; \
     when they ask you to hold off, check first, or not start yet; when the request is a large \
     deliverable whose shape should be agreed before the effort goes in; or when work you have \
     started turns out bigger or riskier than they are likely to have pictured.\n\n\
     The test is simple: **if you are about to write out a numbered list of what you are going \
     to do, call `enter_plan_mode` instead.** Do not ask permission to plan first — asking and \
     then waiting costs the user a round trip to reach a tool you could have called. Answer a \
     short question directly; do not plan work you can just do in a step or two."
        .to_string()
}

/// Phrases that read as "give me a plan".
///
/// Deliberately phrases and not the bare word `plan`: this chat is full of
/// sentences like "the plan I approved yesterday" and "read plan.md", and a
/// detector that fired on those would spend the user's turn proposing a plan
/// they did not ask for. Everything here has a requesting verb, a determiner, or
/// an explicit hold-off attached.
const PLAN_REQUEST_PHRASES: &[&str] = &[
    "make a plan",
    "make me a plan",
    "write a plan",
    "write me a plan",
    "give me a plan",
    "need a plan",
    "want a plan",
    "come up with a plan",
    "draw up a plan",
    "draft a plan",
    "propose a plan",
    "suggest a plan",
    "create a plan",
    "build a plan",
    "put together a plan",
    "a plan for",
    "a plan to",
    "plan of attack",
    "plan this",
    "plan it out",
    "plan out",
    "plan first",
    "plan mode",
    "planning mode",
    "detailed plan",
    "step-by-step plan",
    "step by step plan",
    "implementation plan",
    "before you start",
    "before we start",
    "before you begin",
    "before doing anything",
    "before you do anything",
    "don't start until",
    "do not start until",
    "how would you approach",
    "how you would approach",
    "how would you go about",
    "what's your approach",
    "what is your approach",
    "your approach to",
    "outline the steps",
    "outline how",
    "think this through first",
];

/// Does this message read as a request for a plan?
///
/// Used only to *remind* the model that `enter_plan_mode` exists, never to enter
/// the mode on the user's behalf — so a false positive costs a sentence in one
/// request and a false negative costs nothing that the prompt does not already
/// cover.
pub fn reads_as_plan_request(text: &str) -> bool {
    // Normalise the apostrophes a phone or a word processor produces, so
    // "what’s your approach" matches the same phrase as "what's your approach".
    let lower = text.to_lowercase().replace(['\u{2019}', '\u{02BC}'], "'");
    let hay = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    if hay.is_empty() {
        return false;
    }
    // "plan the migration" — the word as the opening imperative is unambiguous
    // in a way it is nowhere else in a sentence.
    if hay.starts_with("plan ") {
        return true;
    }
    PLAN_REQUEST_PHRASES.iter().any(|p| hay.contains(p))
}

/// The reminder pushed into a turn whose opening message asks for a plan.
///
/// A note in the message list rather than another system snippet, deliberately:
/// it varies with every message, and a volatile snippet at the front of the
/// system prompt invalidates the prefix cache for the whole conversation behind
/// it. Phrased as a reminder because the detector is a guess — the model is
/// better placed to know whether this particular sentence wanted a plan.
pub fn plan_request_nudge() -> String {
    "# Note\n\
     That message reads as a request for a plan. If it is one, `enter_plan_mode` is how you \
     give them a plan they can reorder, edit and approve — writing the steps out in prose \
     instead is the thing to avoid, since nothing can act on it. Call it now rather than asking \
     whether you should. If they meant something else, ignore this."
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

    /// The research half of the mode. Planning is *made of* reading, and a plan
    /// written without searching is the failure 0.14.6 exists to fix — so the
    /// tools that do the reading are asserted present, not merely not-denied.
    #[test]
    fn reads_and_the_mode_itself_survive() {
        for name in [
            "read_file",
            "list_directory",
            "find_files",
            "search_file_text",
            "search_local_files",
            "smart_search",
            "smart_fetch",
            "smart_crawl",
            "ask_user",
            "update_plan",
            "exit_plan_mode",
            "draft_plan_step",
            "read_plan",
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

    /// Build a plan row without a database, for the pure rendering tests below.
    fn fixture(steps: &[Value]) -> Plan {
        Plan {
            id: "p1".into(),
            chat_id: "c1".into(),
            zone_id: None,
            parent_plan_id: None,
            title: "Add plan mode".into(),
            goal: Some("ship 0.12.0".into()),
            context: Some("Scoped to the primary chat only.".into()),
            doc_path: Some("/tmp/plans/add-plan-mode--p1.md".into()),
            steps: serde_json::to_string(&sanitize_steps(steps)).unwrap(),
            status: "approved".into(),
            edited_by_user: true,
            stop_requested: false,
            created_at: 0,
            updated_at: 0,
            approved_at: Some(1),
        }
    }

    #[test]
    fn task_list_names_the_user_edit() {
        let plan = fixture(&[
            json!({ "step": "migration", "files": ["033.sql"], "status": "done" }),
            json!({ "step": "gate the tools", "intent": "hard enforcement" }),
        ]);
        let block = task_list_block(&plan);
        assert!(block.contains("1. [x] migration"));
        assert!(block.contains("(files: 033.sql)"));
        assert!(block.contains("gate the tools — hard enforcement"));
        assert!(block.contains("The user edited this plan"));
    }

    /// The whole point of 0.14.6: the executing turn is handed the *detail* it
    /// was approved on, not just the headings. A plan whose specifications stop
    /// at the approval card is a plan the model re-invents while running it.
    #[test]
    fn task_list_carries_the_specification() {
        let plan = fixture(&[json!({
            "step": "Typography",
            "detail": "11pt body on 1.15 leading.\n65–75 characters per line.",
            "acceptance": "A printed page measures 65–75 characters.",
        })]);
        let block = task_list_block(&plan);
        assert!(block.contains("   11pt body on 1.15 leading."));
        assert!(block.contains("   65–75 characters per line."));
        assert!(block.contains("Done when: A printed page measures"));
        assert!(block.contains("Context agreed with the plan"));
        assert!(block.contains("Scoped to the primary chat only."));
        // The document is named so a compacted turn knows where to look.
        assert!(block.contains("add-plan-mode--p1.md"));
        assert!(block.contains("read_plan"));
    }

    #[test]
    fn detail_and_acceptance_survive_sanitizing() {
        let steps = sanitize_steps(&[json!({
            "step": "Typography",
            "detail": "  **11pt** body  ",
            "acceptance": " measured ",
        })]);
        assert_eq!(steps[0].detail.as_deref(), Some("**11pt** body"));
        assert_eq!(steps[0].acceptance.as_deref(), Some("measured"));
        assert!(steps[0].is_thin(), "a six-word detail is a heading, not a plan");
    }

    /// Over-long detail is truncated rather than refused. Losing the call would
    /// throw away the thinking that produced the other 6 000 characters.
    #[test]
    fn oversized_detail_is_clamped_not_rejected() {
        let long = "x".repeat(MAX_DETAIL_CHARS + 500);
        let steps = sanitize_steps(&[json!({ "step": "big", "detail": long })]);
        let detail = steps[0].detail.as_deref().unwrap();
        assert!(detail.starts_with("xxxx"));
        assert!(detail.contains("truncated"));
        assert!(!steps[0].is_thin());
    }

    /// `clamp_text` cuts on characters, not bytes — a plan written in Japanese
    /// or containing an em dash must not panic on the boundary.
    #[test]
    fn clamping_respects_character_boundaries() {
        let s = "日本語のテキスト — with an em dash";
        assert_eq!(clamp_text(s, 400), s);
        let cut = clamp_text(s, 3);
        assert!(cut.starts_with("日本語"));
        assert!(cut.contains("truncated"));
    }

    /// The document is the plan, not a summary of it: everything the approval
    /// card shows has to be readable from the file weeks later.
    #[test]
    fn the_document_holds_the_whole_plan() {
        let plan = fixture(&[
            json!({
                "step": "Typography",
                "intent": "legibility",
                "detail": "| Element | Spec |\n|---|---|\n| Body | 11pt |",
                "acceptance": "65–75 characters per line",
                "risk": "medium",
                "files": ["report.tex"],
            }),
            json!({ "step": "Bibliography" }),
        ]);
        let doc = render_doc(&plan);
        assert!(doc.starts_with("# Add plan mode"));
        assert!(doc.contains("**Goal.** ship 0.12.0"));
        assert!(doc.contains("## Context"));
        assert!(doc.contains("### 1. Typography"));
        assert!(doc.contains("risk: **medium**"));
        assert!(doc.contains("files: `report.tex`"));
        assert!(doc.contains("**Why.** legibility"));
        assert!(doc.contains("| Body | 11pt |"));
        assert!(doc.contains("**Done when.** 65–75 characters per line"));
        // A step with nothing but a name still gets its heading, so the
        // numbering in the file matches the numbering everywhere else.
        assert!(doc.contains("### 2. Bibliography"));
    }

    /// The sentences users actually type when they want a plan. Every one of
    /// these produced prose before 0.14.6 unless the user typed the function
    /// name themselves.
    #[test]
    fn plain_requests_for_a_plan_are_recognised() {
        for s in [
            "can you make a plan for this",
            "Plan this out first please",
            "plan the migration",
            "I need a plan before we touch anything",
            "come up with a plan and show me",
            "what's your approach to the report?",
            "what’s your approach to the report?", // curly apostrophe
            "How would you approach writing this?",
            "give me a detailed plan",
            "outline the steps you'd take",
            "don't start until I've seen what you intend",
            "let's do this in plan mode",
            "before you start, tell me what you're going to do",
            "draw up a plan  for   the   rewrite", // odd whitespace
        ] {
            assert!(reads_as_plan_request(s), "should have matched: {s}");
        }
    }

    /// Precision matters more than recall: the nudge costs a sentence when it is
    /// right and an unwanted plan proposal when it is wrong, and this app's
    /// conversations are full of the word "plan" meaning something else.
    #[test]
    fn talking_about_a_plan_is_not_asking_for_one() {
        for s in [
            "read plan.md and tell me what it says",
            "the plan I approved yesterday was wrong",
            "did you finish step 3 of the plan?",
            "our floor plan is in the attached PDF",
            "what does the release plan say about 0.13?",
            "thanks, that plan worked",
            "approve",
            "",
            "   ",
        ] {
            assert!(!reads_as_plan_request(s), "should not have matched: {s}");
        }
    }

    #[test]
    fn slugs_are_filename_safe() {
        assert_eq!(slug("Add plan mode"), "add-plan-mode");
        assert_eq!(slug("C:/report — v2!"), "c-report-v2");
        assert_eq!(slug("   "), "plan");
        assert!(slug(&"very long title ".repeat(20)).len() <= 48);
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::MIGRATOR.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c1', 'Chat', 0, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn step(name: &str, detail: &str) -> PlanStep {
        PlanStep::sanitize(&json!({ "step": name, "detail": detail })).unwrap()
    }

    /// The drafting loop end to end: a header, three steps written one call at a
    /// time, one of them rewritten, then filed. This is the shape 0.14.6 adds —
    /// a plan built over several turns of thought rather than squeezed into one
    /// argument blob — so it is asserted as a sequence, not per function.
    #[tokio::test]
    async fn a_plan_is_drafted_a_step_at_a_time_then_filed() {
        let db = pool().await;

        let draft = open_working_draft(
            &db,
            "c1",
            None,
            Some("Report"),
            Some("A finished report"),
            Some("Scoped to real-time locomotion."),
        )
        .await
        .unwrap();
        assert_eq!(draft.status, "drafting");
        // Nothing is waiting on the user yet — a draft is private until filed.
        assert!(pending_draft(&db, "c1").await.is_none());

        for (name, detail) in [("Scope", "Narrow to one sub-topic."), ("Sources", "SIGGRAPH first.")] {
            put_draft_step(&db, &draft.id, step(name, detail), None).await.unwrap();
        }
        // A second call with header fields updates the open draft rather than
        // starting a rival one.
        let same = open_working_draft(&db, "c1", None, Some("Report v2"), None, None)
            .await
            .unwrap();
        assert_eq!(same.id, draft.id);
        assert_eq!(same.title, "Report v2");
        assert_eq!(same.goal.as_deref(), Some("A finished report"), "goal survives");

        // Rewriting step 1 keeps its identity, so live status can still find it.
        let before = get(&db, &draft.id).await.unwrap().parsed_steps();
        let after = put_draft_step(&db, &draft.id, step("Scope", "Narrow to procedural locomotion, because it has a clean historical arc."), Some(1))
            .await
            .unwrap();
        let after_steps = after.parsed_steps();
        assert_eq!(after_steps.len(), 2, "a replace does not append");
        assert_eq!(after_steps[0].id, before[0].id);
        assert!(after_steps[0].detail.as_deref().unwrap().contains("historical arc"));

        let filed = file_working_draft(&db, &draft.id).await.unwrap();
        assert_eq!(filed.status, "draft");
        assert_eq!(pending_draft(&db, "c1").await.map(|p| p.id), Some(filed.id));
        assert!(working_draft(&db, "c1", None).await.is_none());
    }

    /// A chat has at most one plan waiting on the user. A second draft filed
    /// while the first is unanswered supersedes it, or the approval card has to
    /// ask which plan it means.
    #[tokio::test]
    async fn filing_supersedes_the_draft_before_it() {
        let db = pool().await;
        let first = save_draft(&db, "c1", None, "First", None, None, &[step("a", "aa")])
            .await
            .unwrap();
        let second = save_draft(&db, "c1", None, "Second", None, None, &[step("b", "bb")])
            .await
            .unwrap();
        assert_eq!(get(&db, &first.id).await.unwrap().status, "superseded");
        assert_eq!(pending_draft(&db, "c1").await.map(|p| p.id), Some(second.id));
    }

    /// Approving writes back what the *user* agreed to and leaves plan mode.
    #[tokio::test]
    async fn approval_binds_the_edited_steps() {
        let db = pool().await;
        set_plan_mode(&db, "c1", true).await.unwrap();
        let plan = save_draft(&db, "c1", None, "P", None, None, &[step("a", "aa"), step("b", "bb")])
            .await
            .unwrap();

        let mine = vec![step("b first now", "the user reordered and rewrote this")];
        let approved = approve(&db, &plan.id, Some(&mine), true).await.unwrap();
        assert_eq!(approved.status, "approved");
        assert!(approved.edited_by_user);
        assert_eq!(approved.parsed_steps().len(), 1);
        assert_eq!(approved.parsed_steps()[0].step, "b first now");
        assert!(!in_plan_mode(&db, "c1").await, "approving leaves plan mode");
        assert!(chat_has_plans(&db, "c1").await);
    }

    /// `read_plan` is only worth offering to a chat that has planned; the gate
    /// is asserted from the empty side, which is every other chat in the app.
    #[tokio::test]
    async fn a_chat_that_never_planned_has_no_plans() {
        let db = pool().await;
        assert!(!chat_has_plans(&db, "c1").await);
        assert!(working_draft(&db, "c1", None).await.is_none());
        assert!(active_plan(&db, "c1", None).await.is_none());
    }
}
