//! Shared-workspace coordination for multi-agent sessions (0.9.10).
//!
//! Sub-agents have always had the real tools — read, write, search, shell — and
//! they inherit the parent chat's project, so several of them are pointed at one
//! working tree at the same time. What they did not have was any way to know the
//! others existed. That left exactly two safe patterns: run them one at a time,
//! or have them hand patches back for someone else to apply. Both are agents
//! working *against* each other's edits, carefully sequenced.
//!
//! This module is the missing coordination layer, and it is deliberately small:
//!
//! * **Claims** are advisory locks on paths, held by a chat (an agent), with an
//!   intent and an expiry. [`guard_write`] enforces them for every write tool, so
//!   two agents cannot silently overwrite each other's work — and it *auto-claims*
//!   a path on first write, so the protection holds even for an agent that never
//!   calls the tool. Expiry, plus release-on-turn-end, is what stops a crashed
//!   agent from owning a file forever.
//! * **Notes** are the session's shared log. A parallel edit is only safe if the
//!   decisions travel with it: "`parse()` now returns None instead of raising" has
//!   to reach the agent editing the caller, and a sub-agent cannot read another
//!   sub-agent's transcript. The board is where that goes.
//!
//! Scope is the *session* — the root chat of the sub-agent family — because that
//! is the boundary of the collaboration. Reads are never blocked by anything here.

use crate::commands::{new_id, now_ts};
use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// Default lifetime of an explicit claim. Long enough for an agent to read a
/// file, think, and write it; short enough that a crashed agent's claim clears
/// while the session is still running.
const DEFAULT_CLAIM_MINUTES: i64 = 30;
const MAX_CLAIM_MINUTES: i64 = 180;
/// Lifetime of a claim taken implicitly by a write. Shorter, because nobody
/// declared an intention to keep working on the file.
const IMPLICIT_CLAIM_MINUTES: i64 = 15;

/// Notes returned by `team_status`. Enough to carry the session's decisions
/// without turning the board into the whole transcript.
const NOTE_PAGE: i64 = 25;

pub fn definitions() -> Vec<Tool> {
    vec![
        status_definition(),
        claim_definition(),
        release_definition(),
        note_definition(),
    ]
}

fn status_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "team_status".into(),
            description:
                "The shared board for this session: who else is working, the files they have \
                 claimed, and the notes the team has posted. Read it before you start editing, \
                 and whenever a write is refused."
                    .into(),
            parameters: json!({ "type": "object", "properties": {} }),
        },
    }
}

fn claim_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "claim_files".into(),
            description:
                "Claim the files you are about to edit so no other agent writes them at the same \
                 time. If one is already held, the reply names who has it and why — work \
                 elsewhere or coordinate. Claims expire, and release when your turn ends."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "File paths you intend to write, relative to the working directory."
                    },
                    "intent": {
                        "type": "string",
                        "description": "One line on what you are changing — the other agents read this."
                    },
                    "minutes": {
                        "type": "integer",
                        "description": "How long you need them. Default 30, max 180."
                    },
                    "force": {
                        "type": "boolean",
                        "description": "Take a path another agent holds. Only when their work is finished or abandoned; it is recorded on the board."
                    }
                },
                "required": ["paths", "intent"]
            }),
        },
    }
}

fn release_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "release_files".into(),
            description:
                "Release files you claimed, with a summary of what you actually changed so the \
                 next agent can build on it. Omit `paths` to release everything you hold."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Paths to release. Omit for all of yours."
                    },
                    "summary": {
                        "type": "string",
                        "description": "What you changed and anything the others must know — a changed signature, a moved constant."
                    }
                }
            }),
        },
    }
}

fn note_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "post_note".into(),
            description:
                "Post to the session's shared board so every other agent sees it. Use it for a \
                 decision that affects their work, something you are blocked on, or a finding they \
                 would otherwise have to rediscover."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "The note — one or two concrete sentences." },
                    "kind": {
                        "type": "string",
                        "enum": ["note", "decision", "blocked", "done"],
                        "description": "What sort of note this is. Default 'note'."
                    }
                },
                "required": ["text"]
            }),
        },
    }
}

// ─── Execution ────────────────────────────────────────────────────────────────

/// `team_status` — the session's agents, live claims and note board.
pub async fn status(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let session = session_root(db, chat_id).await?;
    sweep_expired(db, &session).await?;

    let claims: Vec<(String, String, Option<String>, i64, i64, i64)> = sqlx::query_as(
        "SELECT path, owner_name, intent, implicit, created_at, expires_at
           FROM work_claims WHERE session_id = ?1 ORDER BY created_at ASC",
    )
    .bind(&session)
    .fetch_all(db)
    .await?;

    let now = now_ts();
    let claim_json: Vec<Value> = claims
        .into_iter()
        .map(|(path, owner, intent, implicit, created, expires)| {
            json!({
                "path": path,
                "held_by": owner,
                "intent": intent.unwrap_or_default(),
                "taken": if implicit == 1 { "implicitly, by writing it" } else { "explicitly" },
                "held_for_minutes": (now - created) / 60_000,
                "expires_in_minutes": (expires - now).max(0) / 60_000,
            })
        })
        .collect();

    let notes: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT author_name, kind, text, created_at FROM work_notes
          WHERE session_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )
    .bind(&session)
    .bind(NOTE_PAGE)
    .fetch_all(db)
    .await?;
    // Oldest first: the board reads as a story, and the model's attention lands
    // on the newest note at the end of the tool result rather than the top.
    let note_json: Vec<Value> = notes
        .into_iter()
        .rev()
        .map(|(author, kind, text, created)| {
            json!({
                "from": author,
                "kind": kind,
                "text": text,
                "minutes_ago": (now - created) / 60_000,
            })
        })
        .collect();

    Ok(json!({
        "status": "ok",
        "agents": agents(db, &session).await?,
        "claims": claim_json,
        "board": note_json,
    })
    .to_string())
}

/// `claim_files` — take advisory locks on the paths this agent is about to edit.
pub async fn claim(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let paths = path_arg(args, "paths");
    if paths.is_empty() {
        return Ok(err("claim_files requires 'paths' (an array of file paths)"));
    }
    let intent = str_arg(args, "intent");
    let minutes = args
        .get("minutes")
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_CLAIM_MINUTES)
        .clamp(1, MAX_CLAIM_MINUTES);
    let force = bool_arg(args, "force");

    let session = session_root(db, chat_id).await?;
    let me = owner_name(db, chat_id, zone_id).await;
    sweep_expired(db, &session).await?;

    let mut claimed: Vec<String> = Vec::new();
    let mut conflicts: Vec<Value> = Vec::new();
    let mut taken_over: Vec<String> = Vec::new();

    for raw in &paths {
        let path = norm_path(raw, project_dir);
        let holder: Option<(String, String, Option<String>, i64)> = sqlx::query_as(
            "SELECT owner_chat_id, owner_name, intent, created_at
               FROM work_claims WHERE session_id = ?1 AND path = ?2",
        )
        .bind(&session)
        .bind(&path)
        .fetch_optional(db)
        .await?;

        if let Some((owner_chat, owner, their_intent, since)) = &holder {
            if owner_chat != chat_id {
                if !force {
                    conflicts.push(json!({
                        "path": raw,
                        "held_by": owner,
                        "their_intent": their_intent.clone().unwrap_or_default(),
                        "held_for_minutes": (now_ts() - since) / 60_000,
                    }));
                    continue;
                }
                taken_over.push(format!("{raw} (from {owner})"));
            }
        }

        upsert_claim(db, &session, &path, chat_id, zone_id, &me, &intent, false, minutes).await?;
        claimed.push(raw.clone());
    }

    if !claimed.is_empty() {
        let text = format!("claimed {} — {intent}", claimed.join(", "));
        post(db, &session, chat_id, &me, "claim", &text).await?;
    }
    if !taken_over.is_empty() {
        let text = format!("took over {}", taken_over.join(", "));
        post(db, &session, chat_id, &me, "claim", &text).await?;
    }

    let mut out = json!({ "status": "ok", "claimed": claimed });
    if !conflicts.is_empty() {
        out["conflicts"] = json!(conflicts);
        out["note"] = json!(
            "Those files are being edited by another agent right now. Work on the ones you did \
             get, or post_note to coordinate — do not write a file you could not claim."
        );
    }
    Ok(out.to_string())
}

/// `release_files` — give up claims and tell the board what changed.
pub async fn release(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let session = session_root(db, chat_id).await?;
    let me = owner_name(db, chat_id, zone_id).await;
    let paths = path_arg(args, "paths");
    let summary = str_arg(args, "summary");

    let released: i64 = if paths.is_empty() {
        sqlx::query("DELETE FROM work_claims WHERE session_id = ?1 AND owner_chat_id = ?2")
            .bind(&session)
            .bind(chat_id)
            .execute(db)
            .await?
            .rows_affected() as i64
    } else {
        let mut n = 0i64;
        for raw in &paths {
            n += sqlx::query(
                "DELETE FROM work_claims WHERE session_id = ?1 AND path = ?2 AND owner_chat_id = ?3",
            )
            .bind(&session)
            .bind(norm_path(raw, project_dir))
            .bind(chat_id)
            .execute(db)
            .await?
            .rows_affected() as i64;
        }
        n
    };

    if !summary.is_empty() {
        post(db, &session, chat_id, &me, "release", &summary).await?;
    }
    Ok(json!({ "status": "ok", "released": released }).to_string())
}

/// `post_note` — broadcast to the session board.
pub async fn note(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
) -> AppResult<String> {
    let text = str_arg(args, "text");
    if text.is_empty() {
        return Ok(err("post_note requires 'text'"));
    }
    let kind = match args.get("kind").and_then(|v| v.as_str()).unwrap_or("note") {
        k @ ("note" | "decision" | "blocked" | "done") => k,
        _ => "note",
    };
    let session = session_root(db, chat_id).await?;
    let me = owner_name(db, chat_id, zone_id).await;
    post(db, &session, chat_id, &me, kind, &text).await?;
    Ok(json!({
        "status": "ok",
        "note": "Posted. Every agent in this session sees it on their next team_status.",
    })
    .to_string())
}

// ─── Write enforcement ────────────────────────────────────────────────────────

/// The write tools a claim protects, and which argument names the file.
///
/// `copy_file`'s source is only read, so only its destination is guarded;
/// `move_file` changes both ends, so both are.
fn guarded_paths(name: &str, args: &Value) -> Vec<String> {
    let pick = |keys: &[&str]| -> Vec<String> {
        keys.iter()
            .filter_map(|k| args.get(*k).and_then(|v| v.as_str()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    match name {
        "write" | "edit" | "delete_file" => pick(&["path", "file_path"]),
        "move_file" => pick(&["source_path", "destination_path", "from", "to"]),
        "copy_file" => pick(&["destination_path", "to"]),
        _ => Vec::new(),
    }
}

/// Called before every tool dispatch. Returns `Some(error_json)` when the write
/// must not proceed because another agent in this session holds the file.
///
/// Also takes an implicit claim on a successful check, so an agent that never
/// calls `claim_files` still can't be overwritten mid-edit — the coordination
/// works by default rather than only when every zone remembers to cooperate.
///
/// Single-agent chats never reach the claim tables at all: one cheap count
/// decides that, because the overwhelming majority of writes in this app are one
/// model editing one file with nobody else in the room.
pub async fn guard_write(
    name: &str,
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
    project_dir: Option<&str>,
) -> AppResult<Option<String>> {
    let paths = guarded_paths(name, args);
    if paths.is_empty() {
        return Ok(None);
    }
    let session = session_root(db, chat_id).await?;
    if !is_shared_session(db, &session).await? {
        return Ok(None);
    }
    sweep_expired(db, &session).await?;

    let me = owner_name(db, chat_id, zone_id).await;
    for raw in &paths {
        let path = norm_path(raw, project_dir);
        let holder: Option<(String, String, Option<String>, i64)> = sqlx::query_as(
            "SELECT owner_chat_id, owner_name, intent, created_at
               FROM work_claims WHERE session_id = ?1 AND path = ?2",
        )
        .bind(&session)
        .bind(&path)
        .fetch_optional(db)
        .await?;

        match holder {
            Some((owner_chat, owner, intent, since)) if owner_chat != chat_id => {
                return Ok(Some(
                    json!({
                        "error": format!(
                            "'{raw}' is claimed by {owner}, who is editing it right now — your \
                             write was not applied. Their intent: {}. Held for {} minute(s).",
                            intent.unwrap_or_else(|| "not stated".into()),
                            (now_ts() - since) / 60_000,
                        ),
                        "error_kind": "claimed",
                        "next": "Edit a file nobody holds, or use post_note / team_status to coordinate. \
                                 Do not retry the same write in a loop.",
                    })
                    .to_string(),
                ));
            }
            Some(_) => {} // Already mine — carry on.
            None => {
                upsert_claim(
                    db, &session, &path, chat_id, zone_id, &me, "", true, IMPLICIT_CLAIM_MINUTES,
                )
                .await?;
            }
        }
    }
    Ok(None)
}

/// Drop every claim a chat holds. Called when a sub-agent's turn ends: its edits
/// are written by then, and a claim outliving the turn that took it is how a
/// finished sub-agent blocks the leader from applying anything.
pub async fn release_all_for_chat(db: &SqlitePool, chat_id: &str) {
    let _ = sqlx::query("DELETE FROM work_claims WHERE owner_chat_id = ?1")
        .bind(chat_id)
        .execute(db)
        .await;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn str_arg(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

fn bool_arg(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.trim().to_lowercase().as_str(), "true" | "yes" | "1"),
        Some(Value::Number(n)) => n.as_i64().map_or(false, |i| i != 0),
        _ => false,
    }
}

/// A string-array argument, tolerating a single string where an array is asked
/// for — a shape models produce constantly.
fn path_arg(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
        _ => Vec::new(),
    }
}

fn err(message: &str) -> String {
    json!({ "error": message }).to_string()
}

/// Canonical form of a path for claim comparison: resolved against the working
/// directory exactly as the file tools resolve it (so the two can't disagree
/// about which file a claim covers), with separators and case normalized so
/// `src/a.ts`, `src\a.ts` and the absolute form are one key.
fn norm_path(path: &str, project_dir: Option<&str>) -> String {
    let resolved = crate::tools::filesystem::resolve_path(path, project_dir);
    let s = resolved.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// The root chat of a sub-agent family — the session every member shares.
///
/// Walks `parent_chat_id` only while the current chat is itself a subchat, so a
/// *branch* (which also has a parent) is its own session rather than being folded
/// back into the chat it forked from.
///
/// Shared with [`crate::tools::terminal`], which scopes a terminal's visibility to
/// the same family: a leader's dev server is one its own sub-agents can query, and
/// one an unrelated chat cannot see.
pub(crate) async fn session_root(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let mut cur = chat_id.to_string();
    for _ in 0..64 {
        let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT parent_chat_id, initiated_by_zone_id FROM chats WHERE id = ?1",
        )
        .bind(&cur)
        .fetch_optional(db)
        .await?;
        match row {
            Some((Some(parent), Some(_owner))) => cur = parent,
            _ => break,
        }
    }
    Ok(cur)
}

/// True when this session has sub-agents — i.e. more than one agent could be
/// writing. A plain chat skips the coordination machinery entirely.
async fn is_shared_session(db: &SqlitePool, session: &str) -> AppResult<bool> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chats WHERE parent_chat_id = ?1 AND initiated_by_zone_id IS NOT NULL",
    )
    .bind(session)
    .fetch_one(db)
    .await
    .unwrap_or(0);
    Ok(n > 0)
}

/// Display name for an agent: its zone's name, falling back to the chat's title.
async fn owner_name(db: &SqlitePool, chat_id: &str, zone_id: Option<&str>) -> String {
    if let Some(z) = zone_id {
        if let Ok(Some(name)) = sqlx::query_scalar::<_, String>("SELECT name FROM zones WHERE id = ?1")
            .bind(z)
            .fetch_optional(db)
            .await
        {
            return name;
        }
    }
    sqlx::query_scalar::<_, String>("SELECT title FROM chats WHERE id = ?1")
        .bind(chat_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "an agent".into())
}

/// Every agent in the session: the root chat plus its sub-agents.
async fn agents(db: &SqlitePool, session: &str) -> AppResult<Vec<Value>> {
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT c.id, z.name, CASE WHEN c.parent_chat_id IS NULL THEN 0 ELSE 1 END AS is_sub
           FROM chats c LEFT JOIN zones z ON z.id = c.zone_id
          WHERE c.id = ?1
             OR (c.parent_chat_id = ?1 AND c.initiated_by_zone_id IS NOT NULL)
          ORDER BY is_sub ASC, c.created_at ASC",
    )
    .bind(session)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, is_sub)| {
            json!({
                "agent": name.unwrap_or_else(|| "Quick chat".into()),
                "role": if is_sub == 0 { "lead" } else { "sub-agent" },
                "subchat_id": id,
            })
        })
        .collect())
}

/// Insert or refresh a claim. One row per (session, path): the owner is replaced
/// only by a caller that has already established it may take over.
#[allow(clippy::too_many_arguments)]
async fn upsert_claim(
    db: &SqlitePool,
    session: &str,
    path: &str,
    chat_id: &str,
    zone_id: Option<&str>,
    owner_name: &str,
    intent: &str,
    implicit: bool,
    minutes: i64,
) -> AppResult<()> {
    let now = now_ts();
    sqlx::query(
        "INSERT INTO work_claims
             (session_id, path, owner_chat_id, owner_zone_id, owner_name, intent, implicit, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(session_id, path) DO UPDATE SET
             owner_chat_id = excluded.owner_chat_id,
             owner_zone_id = excluded.owner_zone_id,
             owner_name    = excluded.owner_name,
             intent        = CASE WHEN excluded.intent = '' THEN work_claims.intent ELSE excluded.intent END,
             implicit      = excluded.implicit,
             expires_at    = excluded.expires_at",
    )
    .bind(session)
    .bind(path)
    .bind(chat_id)
    .bind(zone_id)
    .bind(owner_name)
    .bind(intent)
    .bind(i64::from(implicit))
    .bind(now)
    .bind(now + minutes * 60_000)
    .execute(db)
    .await?;
    Ok(())
}

/// Append to the session board.
async fn post(
    db: &SqlitePool,
    session: &str,
    chat_id: &str,
    author: &str,
    kind: &str,
    text: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO work_notes (id, session_id, author_chat_id, author_name, kind, text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(new_id())
    .bind(session)
    .bind(chat_id)
    .bind(author)
    .bind(kind)
    .bind(text)
    .bind(now_ts())
    .execute(db)
    .await?;
    Ok(())
}

/// Clear claims whose lease has run out, so a crashed or cancelled agent stops
/// holding files. Cheap enough to run on every coordination call.
async fn sweep_expired(db: &SqlitePool, session: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM work_claims WHERE session_id = ?1 AND expires_at <= ?2")
        .bind(session)
        .bind(now_ts())
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guarded_paths_covers_the_write_tools_only() {
        let args = json!({ "path": "src/a.ts", "content": "x" });
        assert_eq!(guarded_paths("write", &args), vec!["src/a.ts"]);
        assert_eq!(guarded_paths("edit", &args), vec!["src/a.ts"]);
        assert_eq!(guarded_paths("delete_file", &args), vec!["src/a.ts"]);
        // Reads and searches are never blocked.
        assert!(guarded_paths("read", &args).is_empty());
        assert!(guarded_paths("read", &args).is_empty());
        assert!(guarded_paths("grep", &args).is_empty());
        // A move touches both ends; a copy only writes its destination.
        let mv = json!({ "source_path": "a.ts", "destination_path": "b.ts" });
        assert_eq!(guarded_paths("move_file", &mv), vec!["a.ts", "b.ts"]);
        assert_eq!(guarded_paths("copy_file", &mv), vec!["b.ts"]);
    }

    /// The same file named three ways has to be one claim key, or the lock is
    /// decoration: an agent claims `src/a.ts` and another writes `src\a.ts`.
    #[test]
    fn path_forms_normalize_to_one_key() {
        let dir = Some(if cfg!(windows) { r"C:\proj" } else { "/proj" });
        let a = norm_path("src/a.ts", dir);
        let b = norm_path(r"src\a.ts", dir);
        let c = norm_path(
            if cfg!(windows) { r"C:\proj\src\a.ts" } else { "/proj/src/a.ts" },
            dir,
        );
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert!(!a.contains('\\'));
    }

    #[test]
    fn paths_accept_a_bare_string() {
        assert_eq!(path_arg(&json!({ "paths": "a.ts" }), "paths"), vec!["a.ts"]);
        assert_eq!(
            path_arg(&json!({ "paths": ["a.ts", " b.ts "] }), "paths"),
            vec!["a.ts", "b.ts"]
        );
        assert!(path_arg(&json!({}), "paths").is_empty());
    }
}
