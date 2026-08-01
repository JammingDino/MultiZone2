//! Subchat orchestration tools (0.5.1). Let a zone spawn and drive side
//! conversations ("subagents"): create a subchat assigned to another zone, send
//! it messages, and read its transcript back. Subchats are linked to their
//! parent via `parent_chat_id` and owned by `initiated_by_zone_id` (the calling
//! zone), and are read-only from the user's perspective.
//!
//! Unlike the other tools, these run nested LLM turns, so they receive the
//! engine context (`EngineCtx` + `StreamSink`) and call `run_send_entry`
//! directly. The recursive turn call is boxed to break the async cycle
//! (run_turn → dispatch → here → run_send_entry → run_turn).
//!
//! # Background subagents (0.9.10)
//!
//! A blocking spawn is one subagent at a time: the leader's own loop is parked
//! inside the tool call until the subagent has finished writing, so five
//! specialists cost five round trips end to end and the leader can't do anything
//! useful while it waits. `spawn_subagent { background: true }` instead returns
//! the subchat id immediately and runs the turn on a detached task, so a leader
//! can fan out to a whole panel in one step, keep reading code itself, and pick
//! the replies up later with `collect_subagents`.
//!
//! The registry below is what makes that collectable: one entry per in-flight
//! background run, holding a `watch` channel the runner closes out with `Done`
//! or `Failed`. `collect_subagents` waits on those channels (with a deadline)
//! and then reads each subagent's last message out of the database, which is
//! also why a collected result survives an app that was busy elsewhere — the
//! transcript, not the channel, is the source of truth.

use crate::commands::messages::{run_send_entry, EngineCtx, InputPart, StreamSink, TurnOverride};
use crate::commands::{new_id, now_ts};
use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::sync::watch;
use tokio::time::{timeout, Duration, Instant};

/// Fallback when `subchatDepthLimit` isn't set in app settings.
const DEFAULT_DEPTH_LIMIT: i64 = 3;

/// Default and maximum wait for `collect_subagents`, in seconds. The default is
/// generous because a subagent doing real work (reading files, running a test
/// suite) routinely takes minutes on a local model; the ceiling stops a bad
/// argument from parking the leader's turn indefinitely.
const DEFAULT_COLLECT_TIMEOUT_SECS: u64 = 900;
const MAX_COLLECT_TIMEOUT_SECS: u64 = 3_600;

/// How long a finished-but-uncollected background run stays in the registry.
/// Six hours; after that the bookkeeping is dropped (the transcript remains on
/// disk and is still readable with `read_subchat`).
const STALE_RUN_MS: i64 = 6 * 60 * 60 * 1000;

/// How a background subagent run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
enum RunState {
    Running,
    Done,
    Failed(String),
}

/// One in-flight (or finished-but-uncollected) background subagent run.
struct Pending {
    /// The chat that spawned it — how `collect_subagents` finds "my" subagents.
    parent_chat_id: String,
    zone_name: String,
    /// The brief it was given, truncated, so `list_subchats` can say what it is
    /// working on without reading the transcript back.
    task: String,
    started_at: i64,
    state: watch::Receiver<RunState>,
}

/// Live background runs, keyed by subchat id. Entries are dropped once
/// collected, so the default "collect everything" can't return the same reply
/// twice. Process-global rather than per-`EngineCtx` because the GUI and the
/// HTTP API build their own contexts and both drive the same chats.
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A turn one agent is driving on another's behalf. Marks the run so `ask_user`
/// is stripped: the leader is the only one who can reach the user, and a
/// sub-agent's question would otherwise wait on an answer nobody can give.
fn agent_turn() -> TurnOverride {
    TurnOverride { agent_driven: true, ..Default::default() }
}

/// Run a subchat turn behind a `dyn Future + Send` boundary. The explicit
/// trait-object erases the concrete future type, breaking the recursive async
/// cycle (run_turn → dispatch → here → run_send_entry → run_turn) that would
/// otherwise make the future fail `Send` inference.
fn run_turn_boxed<'a>(
    ctx: &'a EngineCtx,
    sink: &'a StreamSink,
    chat_id: &'a str,
    parts: Vec<InputPart>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(run_send_entry(ctx, sink, chat_id, parts, agent_turn()))
}

/// The same erasure, but owning everything it needs so the future can be handed
/// to `tokio::spawn` (which requires `'static`). Without the trait object here
/// the spawned future's type would contain itself.
fn run_turn_owned(
    ctx: EngineCtx,
    sink: StreamSink,
    chat_id: String,
    parts: Vec<InputPart>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'static>> {
    Box::pin(async move {
        run_send_entry(&ctx, &sink, &chat_id, parts, agent_turn()).await
    })
}

pub fn definitions() -> Vec<Tool> {
    vec![
        spawn_definition(),
        send_definition(),
        collect_definition(),
        list_definition(),
        read_definition(),
    ]
}

fn spawn_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "spawn_subagent".into(),
            description:
                "Delegate a task to another zone in its own subchat and return its reply. \
                 `background: true` returns the subchat id at once and runs the subagent while \
                 you keep working — several of those in one message run a whole panel in \
                 parallel; read them back with `collect_subagents`. Reuse an existing subagent \
                 (`list_subchats`) instead of spawning a duplicate."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "zone_id": {
                        "type": "string",
                        "description": "The zone to assign as the subagent — its id or its exact (case-insensitive) name. Call list_zones if unsure."
                    },
                    "initial_message": {
                        "type": "string",
                        "description": "The task/prompt to send to the subagent as its first message. Self-contained: it cannot ask you or the user anything."
                    },
                    "context_mode": {
                        "type": "string",
                        "enum": ["full", "task_only", "summary"],
                        "description": "How much context to give the subagent. 'task_only' (default): only initial_message. 'full': the whole current conversation is included as hidden context. 'summary': you have summarized the relevant context yourself inside initial_message."
                    },
                    "background": {
                        "type": "boolean",
                        "description": "Return the subchat id at once and run the subagent in the background instead of waiting for its reply. Default false."
                    }
                },
                "required": ["zone_id", "initial_message"]
            }),
        },
    }
}

fn send_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "send_subchat_message".into(),
            description:
                "Send a follow-up to a subchat you already have and return the reply. Cheaper and \
                 better informed than a fresh spawn — the subagent keeps its own context. \
                 `background: true` returns at once; collect with `collect_subagents`."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "subchat_id": { "type": "string", "description": "The subchat id from spawn_subagent or list_subchats." },
                    "message": { "type": "string", "description": "The message to send to the subagent." },
                    "background": {
                        "type": "boolean",
                        "description": "Return at once and let the subagent work in the background. Default false."
                    }
                },
                "required": ["subchat_id", "message"]
            }),
        },
    }
}

fn collect_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "collect_subagents".into(),
            description:
                "Wait for background subagents and return their replies. Omit `subchat_ids` to \
                 collect every one in flight for this conversation; `timeout_seconds: 0` reports \
                 who has finished without waiting."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "subchat_ids": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Specific subchat ids to collect. Omit for all of this conversation's background subagents."
                    },
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "How long to wait in total. Default 900. 0 = report status now and don't wait."
                    }
                }
            }),
        },
    }
}

fn list_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "list_subchats".into(),
            description:
                "List the subagents this conversation already has — id, zone, turns, the task \
                 each was given, and whether it is busy. Check before spawning so you reuse one \
                 that is already briefed."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {},
            }),
        },
    }
}

fn read_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "read_subchat".into(),
            description:
                "Read the full transcript of a subchat (every user/assistant turn) so you can \
                 review what the subagent has done so far."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "subchat_id": { "type": "string", "description": "The subchat id to read." }
                },
                "required": ["subchat_id"]
            }),
        },
    }
}

// ─── Execution ────────────────────────────────────────────────────────────────

/// `spawn_subagent` — resolve the target zone, enforce the depth limit, create a
/// subchat owned by the caller, send the first message, and return the new id +
/// the subagent's response (or, in background mode, just the id).
pub async fn spawn(
    args: &Value,
    ctx: &EngineCtx,
    sink: &StreamSink,
    caller_zone_id: Option<&str>,
    parent_chat_id: &str,
) -> AppResult<String> {
    let zone_query = str_arg(args, "zone_id");
    let initial_message = str_arg(args, "initial_message");
    if zone_query.is_empty() || initial_message.is_empty() {
        return Ok(err("spawn_subagent requires 'zone_id' and 'initial_message'"));
    }
    let context_mode = args
        .get("context_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("task_only");
    let background = bool_arg(args, "background");

    let (target_zone_id, target_zone_name) = match resolve_zone(&ctx.db, &zone_query).await? {
        Some(z) => z,
        None => return Ok(err(&format!(
            "no zone matching '{zone_query}'. Call list_zones to see available zones."
        ))),
    };

    // Enforce the configured subchat nesting depth to prevent runaway recursion.
    let depth = subchat_depth(&ctx.db, parent_chat_id).await?;
    let limit = depth_limit(&ctx.db).await;
    if depth + 1 > limit {
        return Ok(err(&format!(
            "subchat depth limit reached ({limit}); cannot spawn deeper. This subchat is already {depth} level(s) deep."
        )));
    }

    // The subagent shares the parent's project so filesystem/knowledge tools
    // resolve against the same directory and index.
    let parent_project_id: Option<String> =
        sqlx::query_scalar("SELECT project_id FROM chats WHERE id = ?1")
            .bind(parent_chat_id)
            .fetch_optional(&ctx.db)
            .await?
            .flatten();

    // Owned by the calling zone (the orchestrator) so its prompts render with
    // that avatar; assigned to the target zone, which answers. The caller may be
    // a synthetic Quick-chat zone that isn't a real row — fall back to the target
    // (always real) so the initiated_by_zone_id foreign key holds.
    let owner_zone_id: &str = match caller_zone_id {
        Some(z) if zone_exists(&ctx.db, z).await? => z,
        _ => &target_zone_id,
    };
    let subchat_id = new_id();
    let now = now_ts();
    let title = format!("↳ {target_zone_name}");
    sqlx::query(
        "INSERT INTO chats (id, title, zone_id, project_id, parent_chat_id, initiated_by_zone_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
    )
    .bind(&subchat_id)
    .bind(&title)
    .bind(&target_zone_id)
    .bind(&parent_project_id)
    .bind(parent_chat_id)
    .bind(owner_zone_id)
    .bind(now)
    .execute(&ctx.db)
    .await?;

    // Tell any open GUI a new chat exists so the sidebar shows the subchat live.
    sink.notify_chats_changed();

    let parts = build_parts(&ctx.db, parent_chat_id, &initial_message, context_mode).await?;

    if background {
        start_background(
            ctx,
            sink,
            &subchat_id,
            parts,
            parent_chat_id,
            &target_zone_name,
            &initial_message,
        );
        return Ok(json!({
            "status": "running",
            "subchat_id": subchat_id,
            "zone": { "id": target_zone_id, "name": target_zone_name },
            "note": "Working in the background. Keep going, then call collect_subagents for the reply.",
        })
        .to_string());
    }

    run_turn_boxed(ctx, sink, &subchat_id, parts).await?;
    crate::tools::teamwork::release_all_for_chat(&ctx.db, &subchat_id).await;

    let response = last_response(&ctx.db, &subchat_id).await?;
    Ok(json!({
        "status": "ok",
        "subchat_id": subchat_id,
        "zone": { "id": target_zone_id, "name": target_zone_name },
        "response": response,
    })
    .to_string())
}

/// `send_subchat_message` — send a follow-up to an existing subchat and return
/// the subagent's response (or, in background mode, return at once).
pub async fn send(args: &Value, ctx: &EngineCtx, sink: &StreamSink) -> AppResult<String> {
    let subchat_id = str_arg(args, "subchat_id");
    let message = str_arg(args, "message");
    if subchat_id.is_empty() || message.is_empty() {
        return Ok(err("send_subchat_message requires 'subchat_id' and 'message'"));
    }
    if !is_subchat(&ctx.db, &subchat_id).await? {
        return Ok(err(&format!("'{subchat_id}' is not a subchat.")));
    }
    // A second message while the subagent is still writing would interleave two
    // turns in one transcript, and the reply read back afterwards could belong to
    // either. Make the leader collect first.
    if is_running(&subchat_id) {
        return Ok(err(&format!(
            "subagent '{subchat_id}' is still working. Call collect_subagents for its reply first, \
             then send the follow-up."
        )));
    }

    let background = bool_arg(args, "background");
    let parts = vec![InputPart::Text { text: message.clone() }];

    if background {
        let (parent_chat_id, zone_name) = subchat_meta(&ctx.db, &subchat_id).await?;
        start_background(
            ctx,
            sink,
            &subchat_id,
            parts,
            &parent_chat_id,
            &zone_name,
            &message,
        );
        return Ok(json!({
            "status": "running",
            "subchat_id": subchat_id,
            "note": "Working in the background. Keep going, then call collect_subagents for the reply.",
        })
        .to_string());
    }

    run_turn_boxed(ctx, sink, &subchat_id, parts).await?;
    crate::tools::teamwork::release_all_for_chat(&ctx.db, &subchat_id).await;

    let response = last_response(&ctx.db, &subchat_id).await?;
    Ok(json!({ "status": "ok", "subchat_id": subchat_id, "response": response }).to_string())
}

/// `collect_subagents` — wait for background runs and return their replies.
pub async fn collect(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let requested: Vec<String> = args
        .get("subchat_ids")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // Snapshot the registry rather than holding its lock across the waits below.
    let ids: Vec<String> = if requested.is_empty() {
        let map = pending().lock().unwrap();
        let mut ids: Vec<(i64, String)> = map
            .iter()
            .filter(|(_, p)| p.parent_chat_id == chat_id)
            .map(|(id, p)| (p.started_at, id.clone()))
            .collect();
        ids.sort();
        ids.into_iter().map(|(_, id)| id).collect()
    } else {
        requested
    };

    if ids.is_empty() {
        return Ok(json!({
            "status": "ok",
            "collected": [],
            "note": "No background subagents are in flight for this conversation. Spawn one with background:true, or read a finished subchat with read_subchat.",
        })
        .to_string());
    }

    let secs = args
        .get("timeout_seconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_COLLECT_TIMEOUT_SECS)
        .min(MAX_COLLECT_TIMEOUT_SECS);
    let deadline = Instant::now() + Duration::from_secs(secs);

    let mut results: Vec<Value> = Vec::with_capacity(ids.len());
    let mut still_running = 0usize;

    for id in &ids {
        // Take the receiver (and metadata) for this id, if it is a background run.
        let entry = {
            let map = pending().lock().unwrap();
            map.get(id)
                .map(|p| (p.state.clone(), p.zone_name.clone(), p.started_at))
        };

        let (state, zone_name, started_at) = match entry {
            Some(e) => e,
            None => {
                // Not a background run (already collected, or spawned blocking).
                // Its transcript is still the answer, so read it out rather than
                // making the model work out why the id "doesn't exist".
                let response = last_response(db, id).await?;
                let (_, zone_name) = subchat_meta(db, id).await.unwrap_or_default();
                results.push(json!({
                    "subchat_id": id,
                    "zone": zone_name,
                    "status": if response.is_empty() { "unknown" } else { "ok" },
                    "response": response,
                    "note": "Not an in-flight background run — this is the subchat's latest reply.",
                }));
                continue;
            }
        };

        let mut rx = state;
        let remaining = deadline.saturating_duration_since(Instant::now());
        let outcome: RunState = if !matches!(*rx.borrow(), RunState::Running) {
            rx.borrow().clone()
        } else if remaining.is_zero() {
            RunState::Running
        } else {
            match timeout(remaining, rx.wait_for(|s| !matches!(s, RunState::Running))).await {
                // The runner published a terminal state.
                Ok(Ok(state)) => (*state).clone(),
                // Sender dropped without publishing — the task died (panic).
                Ok(Err(_)) => RunState::Failed("the subagent run ended unexpectedly".into()),
                Err(_) => RunState::Running,
            }
        };

        match outcome {
            RunState::Running => {
                still_running += 1;
                results.push(json!({
                    "subchat_id": id,
                    "zone": zone_name,
                    "status": "still_running",
                    "running_for_seconds": (now_ts() - started_at) / 1000,
                }));
            }
            RunState::Done => {
                pending().lock().unwrap().remove(id);
                results.push(json!({
                    "subchat_id": id,
                    "zone": zone_name,
                    "status": "ok",
                    "response": last_response(db, id).await?,
                }));
            }
            RunState::Failed(e) => {
                pending().lock().unwrap().remove(id);
                results.push(json!({
                    "subchat_id": id,
                    "zone": zone_name,
                    "status": "failed",
                    "error": e,
                    // Whatever it managed to write before failing is still useful.
                    "response": last_response(db, id).await?,
                }));
            }
        }
    }

    let mut out = json!({ "status": "ok", "collected": results });
    if still_running > 0 {
        out["still_running"] = json!(still_running);
        out["note"] = json!(
            "Some subagents are still working. Do other useful work, then call collect_subagents \
             again for the rest — don't re-spawn them."
        );
    }
    Ok(out.to_string())
}

/// `list_subchats` — the subagents this chat already owns, so a leader reuses
/// them instead of spawning a fresh one per question.
pub async fn list(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let rows: Vec<(String, Option<String>, i64, i64)> = sqlx::query_as(
        "SELECT c.id,
                z.name,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.chat_id = c.id AND m.zone_id IS NULL
                    AND m.role IN ('user', 'assistant')) AS turns,
                c.updated_at
           FROM chats c LEFT JOIN zones z ON z.id = c.zone_id
          WHERE c.parent_chat_id = ?1 AND c.initiated_by_zone_id IS NOT NULL
          ORDER BY c.created_at ASC",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await?;

    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    for (id, zone_name, turns, updated_at) in rows {
        out.push(json!({
            "subchat_id": id,
            "zone": zone_name.unwrap_or_else(|| "unknown".into()),
            "turns": turns,
            "task": truncate(&first_task(db, &id).await?, 200),
            "busy": is_running(&id),
            "updated_at": updated_at,
        }));
    }

    Ok(json!({
        "status": "ok",
        "subchats": out,
        "note": if out.is_empty() {
            "No subagents yet — spawn_subagent creates one."
        } else {
            "Continue one of these with send_subchat_message rather than spawning a duplicate."
        },
    })
    .to_string())
}

/// `read_subchat` — return the full user/assistant transcript of a subchat.
pub async fn read(args: &Value, db: &SqlitePool) -> AppResult<String> {
    let subchat_id = str_arg(args, "subchat_id");
    if subchat_id.is_empty() {
        return Ok(err("read_subchat requires 'subchat_id'"));
    }
    if !is_subchat(db, &subchat_id).await? {
        return Ok(err(&format!("'{subchat_id}' is not a subchat.")));
    }
    let transcript = transcript(db, &subchat_id).await?;
    Ok(json!({ "status": "ok", "subchat_id": subchat_id, "transcript": transcript }).to_string())
}

// ─── Background runs ──────────────────────────────────────────────────────────

/// Register a background run and drive its turn on a detached task. Returns as
/// soon as the task is spawned; the turn publishes `Done`/`Failed` when it ends.
fn start_background(
    ctx: &EngineCtx,
    sink: &StreamSink,
    subchat_id: &str,
    parts: Vec<InputPart>,
    parent_chat_id: &str,
    zone_name: &str,
    task: &str,
) {
    let (tx, rx) = watch::channel(RunState::Running);
    {
        let mut map = pending().lock().unwrap();
        // A reply nobody collected is stale after a few hours — the transcript is
        // still on disk, so all that is dropped here is the bookkeeping. Without
        // this the registry only ever grows for the life of the process.
        let cutoff = now_ts() - STALE_RUN_MS;
        map.retain(|_, p| {
            matches!(*p.state.borrow(), RunState::Running) || p.started_at > cutoff
        });
        map.insert(
            subchat_id.to_string(),
            Pending {
                parent_chat_id: parent_chat_id.to_string(),
                zone_name: zone_name.to_string(),
                task: truncate(task, 200),
                started_at: now_ts(),
                state: rx,
            },
        );
    }

    let ctx = ctx.clone();
    let sink = sink.clone();
    let chat_id = subchat_id.to_string();
    tokio::spawn(async move {
        let db = ctx.db.clone();
        let result = run_turn_owned(ctx, sink.clone(), chat_id.clone(), parts).await;
        // Its edits are written by now, so its file claims have done their job.
        // A claim outliving the turn that took it is how a finished sub-agent
        // blocks everyone else from touching the file it was working on.
        crate::tools::teamwork::release_all_for_chat(&db, &chat_id).await;
        let state = match result {
            Ok(()) => RunState::Done,
            Err(e) => {
                tracing::warn!("background subagent {chat_id} failed: {e}");
                RunState::Failed(e.to_string())
            }
        };
        // A dropped receiver (nobody collected) is fine — the transcript is on
        // disk either way.
        let _ = tx.send(state);
        // The sidebar shows subchat activity; a background run finishing is the
        // one state change no open chat's stream would otherwise announce.
        sink.notify_chats_changed();
    });
}

/// True when a background run for this subchat is still in flight.
fn is_running(subchat_id: &str) -> bool {
    pending()
        .lock()
        .unwrap()
        .get(subchat_id)
        .map_or(false, |p| matches!(*p.state.borrow(), RunState::Running))
}

/// How many generations of background subagents cancellation walks. The depth
/// limit setting caps nesting well below this; the bound only exists so a cyclic
/// parent link can't make the walk spin.
pub const MAX_CANCEL_DEPTH: usize = 8;

/// Ids of every in-flight background subagent under `parent_chat_id`. Used by
/// cancellation to stop children along with the chat that spawned them.
pub fn running_children(parent_chat_id: &str) -> Vec<String> {
    pending()
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, p)| {
            p.parent_chat_id == parent_chat_id && matches!(*p.state.borrow(), RunState::Running)
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// A one-line summary of the background subagents a chat has in flight, for the
/// leader's turn preamble. `None` when there are none.
pub fn in_flight_summary(parent_chat_id: &str) -> Option<String> {
    let map = pending().lock().unwrap();
    let mut lines: Vec<String> = map
        .iter()
        .filter(|(_, p)| p.parent_chat_id == parent_chat_id)
        .map(|(id, p)| {
            let state = match &*p.state.borrow() {
                RunState::Running => "working",
                RunState::Done => "finished, uncollected",
                RunState::Failed(_) => "failed, uncollected",
            };
            format!("• {} [{}] — {} ({})", p.zone_name, id, p.task, state)
        })
        .collect();
    if lines.is_empty() {
        return None;
    }
    lines.sort();
    Some(lines.join("\n"))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn str_arg(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

/// Read a boolean argument, tolerating the string forms small models emit.
fn bool_arg(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.trim().to_lowercase().as_str(), "true" | "yes" | "1"),
        Some(Value::Number(n)) => n.as_i64().map_or(false, |i| i != 0),
        _ => false,
    }
}

fn err(message: &str) -> String {
    json!({ "error": message }).to_string()
}

/// Trim to `max` chars on a char boundary, marking the cut.
fn truncate(s: &str, max: usize) -> String {
    let s = s.trim().replace('\n', " ");
    if s.chars().count() <= max {
        return s;
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

/// Resolve a zone by id or exact case-insensitive name. Returns None if there's
/// no unambiguous match.
async fn resolve_zone(db: &SqlitePool, query: &str) -> AppResult<Option<(String, String)>> {
    let matches: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM zones WHERE id = ?1 OR lower(name) = lower(?1)",
    )
    .bind(query)
    .fetch_all(db)
    .await?;
    Ok(match matches.as_slice() {
        [one] => Some(one.clone()),
        _ => None,
    })
}

/// True when a zone row with this id exists.
async fn zone_exists(db: &SqlitePool, zone_id: &str) -> AppResult<bool> {
    let row: Option<String> = sqlx::query_scalar("SELECT id FROM zones WHERE id = ?1")
        .bind(zone_id)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

/// True when the chat exists and is a subchat (owned by a zone).
async fn is_subchat(db: &SqlitePool, chat_id: &str) -> AppResult<bool> {
    let row: Option<Option<String>> =
        sqlx::query_scalar("SELECT initiated_by_zone_id FROM chats WHERE id = ?1")
            .bind(chat_id)
            .fetch_optional(db)
            .await?;
    Ok(matches!(row, Some(Some(_))))
}

/// A subchat's parent chat id and answering zone name.
async fn subchat_meta(db: &SqlitePool, subchat_id: &str) -> AppResult<(String, String)> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT c.parent_chat_id, z.name FROM chats c
         LEFT JOIN zones z ON z.id = c.zone_id WHERE c.id = ?1",
    )
    .bind(subchat_id)
    .fetch_optional(db)
    .await?;
    let (parent, zone) = row.unwrap_or((None, None));
    Ok((parent.unwrap_or_default(), zone.unwrap_or_else(|| "unknown".into())))
}

/// The brief a subchat was opened with (its first user message).
async fn first_task(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let content: Option<String> = sqlx::query_scalar(
        "SELECT content FROM messages
         WHERE chat_id = ?1 AND zone_id IS NULL AND role = 'user'
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await?;
    Ok(content.map(|c| extract_text(&c)).unwrap_or_default())
}

/// How many subchat levels deep `chat_id` is (a root chat is 0). Walks the
/// `parent_chat_id` chain, counting each ancestor that is itself a subchat.
async fn subchat_depth(db: &SqlitePool, chat_id: &str) -> AppResult<i64> {
    let mut depth = 0i64;
    let mut cur = chat_id.to_string();
    // Bounded by a hard cap so a cyclic parent link can never loop forever.
    for _ in 0..64 {
        let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT parent_chat_id, initiated_by_zone_id FROM chats WHERE id = ?1",
        )
        .bind(&cur)
        .fetch_optional(db)
        .await?;
        match row {
            Some((Some(parent), Some(_owner))) => {
                depth += 1;
                cur = parent;
            }
            _ => break,
        }
    }
    Ok(depth)
}

/// Configured subchat depth limit from app settings, or the default.
async fn depth_limit(db: &SqlitePool) -> i64 {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("subchatDepthLimit").and_then(|n| n.as_i64()))
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_DEPTH_LIMIT)
}

/// Build the input parts for the subagent's first message based on context mode.
/// `full` prepends the parent transcript as hidden context (sent to the model,
/// invisible in the UI); `task_only`/`summary` send the message alone.
async fn build_parts(
    db: &SqlitePool,
    parent_chat_id: &str,
    initial_message: &str,
    context_mode: &str,
) -> AppResult<Vec<InputPart>> {
    let mut parts = Vec::new();
    if context_mode == "full" {
        let convo = transcript(db, parent_chat_id).await?;
        if !convo.trim().is_empty() {
            parts.push(InputPart::HiddenText {
                text: format!(
                    "Context — the conversation that led to this task:\n\n{convo}\n\n---\n"
                ),
            });
        }
    }
    parts.push(InputPart::Text { text: initial_message.to_string() });
    Ok(parts)
}

/// Plain-text transcript of a chat's primary user/assistant turns.
async fn transcript(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT role, content FROM messages
         WHERE chat_id = ?1 AND zone_id IS NULL AND role IN ('user', 'assistant')
         ORDER BY created_at ASC",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await?;
    let mut out = String::new();
    for (role, content) in rows {
        let text = extract_text(&content);
        if text.trim().is_empty() {
            continue;
        }
        let label = if role == "user" { "User" } else { "Assistant" };
        out.push_str(&format!("{label}: {text}\n\n"));
    }
    Ok(out.trim_end().to_string())
}

/// Last assistant turn's text for a chat (the subagent's response).
async fn last_response(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let content: Option<String> = sqlx::query_scalar(
        "SELECT content FROM messages
         WHERE chat_id = ?1 AND zone_id IS NULL AND role = 'assistant'
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await?;
    Ok(content.map(|c| extract_text(&c)).unwrap_or_default())
}

/// Pull the concatenated text from a stored message content JSON (an array of
/// content parts). Falls back to the raw string if it isn't the expected shape.
fn extract_text(content: &str) -> String {
    match serde_json::from_str::<Value>(content) {
        Ok(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| {
                if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                    p.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => content.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Small models write `"true"` and `1` as often as `true`.
    #[test]
    fn background_flag_accepts_the_shapes_models_send() {
        for raw in [json!({"background": true}), json!({"background": "true"}),
                    json!({"background": "Yes"}), json!({"background": 1})] {
            assert!(bool_arg(&raw, "background"), "{raw}");
        }
        for raw in [json!({}), json!({"background": false}), json!({"background": "false"}),
                    json!({"background": 0}), json!({"background": null})] {
            assert!(!bool_arg(&raw, "background"), "{raw}");
        }
    }

    /// The task blurb is cut on a char boundary — a multi-byte brief must not
    /// panic the tool that is only trying to summarize it.
    #[test]
    fn truncate_is_char_safe() {
        let s = "日本語のタスク説明".repeat(40);
        let cut = truncate(&s, 20);
        assert_eq!(cut.chars().count(), 21); // 20 + the ellipsis
        assert!(cut.ends_with('…'));
        assert_eq!(truncate("short  \n brief", 200), "short    brief");
    }
}
