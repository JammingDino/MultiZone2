//! Review before apply (0.10.2) — seeing a change before agreeing to it.
//!
//! 0.10.x's premise is that approving an edit should not mean living with it.
//! Checkpoints handle the half of that which comes *after* the change;
//! this module handles the half that comes before. Three things live here:
//!
//! - **Preview.** What a pending `write` / `edit` would actually do,
//!   as a diff. Until now the approval prompt showed the tool's raw arguments —
//!   for a whole-file write, a wall of proposed content, which is the form in
//!   which a change is hardest to judge.
//! - **Narrowing.** A user who wants three of four hunks gets three of four
//!   hunks: the call still runs, with arguments rewritten to the content they
//!   agreed to. Per-hunk approval that only *recorded* a preference would be a
//!   worse lie than not offering it.
//! - **The review queue.** A mode where a zone's writes stage instead of
//!   landing, and the user applies the batch after reading it. Staged content
//!   is what `read` serves back to the model, so an agent that stages three
//!   edits to one file is working against its own last version rather than
//!   silently against the stale disk.

use crate::commands::{new_id, now_ts};
use crate::diffs::{self, FileDiff};
use crate::error::AppResult;
use crate::tools::filesystem::resolve_path;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The tools a review can be shown for. Deliberately the two content-writing
/// tools and not every mutating one: a rename or a delete has no diff, and
/// asking "which hunks of this deletion do you accept" is nonsense.
pub fn is_reviewable(name: &str) -> bool {
    matches!(name, "write" | "edit")
}

/// What a pending call would leave on disk, resolved against the same working
/// directory the tool itself will use.
pub struct Proposal {
    pub path: PathBuf,
    /// The path as the model wrote it.
    pub display: String,
    /// The current contents, or `None` when nothing is there yet.
    pub before: Option<String>,
    pub after: String,
}

/// Read a path as text, distinguishing "not there" from "not text".
enum Current {
    Absent,
    Text(String),
    Binary,
}

fn read_current(path: &Path) -> Current {
    let Ok(bytes) = std::fs::read(path) else {
        return Current::Absent;
    };
    // A NUL byte in the first block is the same heuristic every diff tool uses,
    // and it is right about the files that matter (images, archives, binaries).
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Current::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(s) => Current::Text(s),
        Err(_) => Current::Binary,
    }
}

fn hash(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Work out what a call would write, taking any staged version of the file as
/// the base rather than the disk — otherwise a second edit in review-queue mode
/// would be computed against content the model has already superseded.
pub async fn proposal(
    db: &SqlitePool,
    chat_id: &str,
    name: &str,
    args: &Value,
    project_dir: Option<&str>,
) -> Option<Result<Proposal, String>> {
    if !is_reviewable(name) {
        return None;
    }
    let display = args.get("path").and_then(|v| v.as_str())?.trim().to_string();
    if display.is_empty() {
        return None;
    }
    let path = resolve_path(&display, project_dir);

    let staged = staged_content(db, chat_id, &path).await;
    let base = match staged {
        Some(text) => Current::Text(text),
        None => read_current(&path),
    };

    match name {
        "write" => {
            let after = args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let before = match base {
                Current::Absent => None,
                Current::Text(s) => Some(s),
                Current::Binary => return Some(Err("binary".into())),
            };
            Some(Ok(Proposal { path, display, before, after }))
        }
        "edit" => {
            let old_text = args.get("old_text").and_then(|v| v.as_str()).unwrap_or("");
            let new_text = args.get("new_text").and_then(|v| v.as_str()).unwrap_or("");
            let current = match base {
                Current::Text(s) => s,
                Current::Absent => return Some(Err("the file does not exist yet".into())),
                Current::Binary => return Some(Err("binary".into())),
            };
            let replace_all =
                args.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
            // Resolved by the tool's own function rather than a second copy of
            // the rule: the diff shown here is the one that will land, down to
            // the tolerant match and the re-indentation. A refusal is surfaced
            // in the tool's own words, so the user isn't asked to approve
            // something that cannot work.
            match crate::tools::filesystem::resolve_edit(
                &current,
                old_text,
                new_text,
                replace_all,
            ) {
                Ok(r) => Some(Ok(Proposal {
                    path,
                    display,
                    before: Some(current),
                    after: r.updated,
                })),
                Err(why) => Some(Err(why)),
            }
        }
        _ => None,
    }
}

/// The diff an approval prompt shows for a pending call, or `None` when the
/// tool isn't one with a reviewable change.
pub async fn preview(
    db: &SqlitePool,
    chat_id: &str,
    name: &str,
    arguments: &str,
    project_dir: Option<&str>,
) -> AppResult<Option<FileDiff>> {
    let args: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
    let Some(result) = proposal(db, chat_id, name, &args, project_dir).await else {
        return Ok(None);
    };
    let display = args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let path = resolve_path(&display, project_dir).to_string_lossy().to_string();

    Ok(Some(match result {
        Err(why) if why == "binary" => diffs::binary_diff(&path, &display, "modify"),
        Err(why) => diffs::summary_diff(&path, &display, "modify", &why),
        Ok(p) => diffs::file_diff(&path, &display, p.before.as_deref(), &p.after),
    }))
}

/// Rewrite a call's arguments so it writes only the hunks the user took.
///
/// The tool name is deliberately left alone — history, checkpoints and the
/// usage counters all key on it, and a call that changed identity between
/// approval and execution would be unreadable afterwards. For `edit` that
/// means expressing the narrowed result as a replacement of the whole current
/// text, which is exactly what it is.
pub fn narrow_arguments(name: &str, args: &Value, p: &Proposal, hunks: &[usize]) -> Value {
    let before = p.before.clone().unwrap_or_default();
    let selected: HashSet<usize> = hunks.iter().copied().collect();
    let all = diffs::diff_hunks(&before, &p.after);
    let narrowed = diffs::apply_hunks(&before, &p.after, &all, &selected);

    let mut out = args.clone();
    match name {
        "write" => {
            out["content"] = json!(narrowed);
        }
        "edit" => {
            out["old_text"] = json!(before);
            out["new_text"] = json!(narrowed);
        }
        _ => {}
    }
    out
}

// ─── The review queue ─────────────────────────────────────────────────────────

/// Whether writes in this app stage for review instead of landing.
///
/// App-level rather than per-zone: "I want to read every edit before it lands"
/// is a statement about how the user works, not about one zone, and a mode that
/// applied to some zones and not others would make "did that land?" a question
/// with no reliable answer.
pub async fn queue_enabled(db: &SqlitePool) -> bool {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind("app_settings")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("reviewQueue").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/// Normalised absolute key, matching the checkpoint store's so the same file
/// named three ways is one row.
fn key(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// The staged content for a path in this chat, if any. This is what makes the
/// queue usable by an agent rather than merely visible to a user: a `read`
/// after a staged write returns what the model wrote, not the stale disk.
pub async fn staged_content(db: &SqlitePool, chat_id: &str, path: &Path) -> Option<String> {
    sqlx::query_scalar(
        "SELECT content FROM staged_edits
          WHERE chat_id = ?1 AND path = ?2 AND applied_at IS NULL",
    )
    .bind(chat_id)
    .bind(key(path))
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

/// Stage a write instead of performing it, and tell the model what happened.
///
/// The tool result is honest about the state of the world — the model is told
/// the change is queued and not yet on disk, so it doesn't report to the user
/// that a file has been written when it hasn't.
pub async fn stage(
    db: &SqlitePool,
    chat_id: &str,
    zone_id: Option<&str>,
    name: &str,
    p: &Proposal,
) -> AppResult<String> {
    let k = key(&p.path);
    let existed = std::fs::metadata(&p.path).is_ok();
    // The hash of what was on disk when this was staged, so applying it can
    // tell "nothing has moved" from "somebody edited the file meanwhile".
    let disk_hash = std::fs::read_to_string(&p.path).ok().map(|s| hash(&s));

    // One row per path per chat: a second staged edit to the same file replaces
    // the first, because the proposal was computed on top of it. Keeping both
    // would offer the user a choice between two versions of which only the
    // newest is coherent.
    sqlx::query("DELETE FROM staged_edits WHERE chat_id = ?1 AND path = ?2 AND applied_at IS NULL")
        .bind(chat_id)
        .bind(&k)
        .execute(db)
        .await?;

    sqlx::query(
        "INSERT INTO staged_edits
           (id, chat_id, zone_id, path, display_path, tool, existed, disk_hash, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(new_id())
    .bind(chat_id)
    .bind(zone_id)
    .bind(&k)
    .bind(&p.display)
    .bind(name)
    .bind(existed as i64)
    .bind(&disk_hash)
    .bind(&p.after)
    .bind(now_ts())
    .execute(db)
    .await?;

    let diff = diffs::file_diff(&k, &p.display, p.before.as_deref(), &p.after);
    Ok(json!({
        "staged": true,
        "path": p.display,
        "lines_added": diff.added,
        "lines_removed": diff.removed,
        "note": "Review mode is on: this change is queued for the user to review and \
                 has NOT been written to disk. Carry on as if it had — reading this \
                 file returns your staged version — but do not tell the user the file \
                 has been written. Say the change is waiting for their review.",
    })
    .to_string())
}

/// A queued change, with its diff computed at read time so a file edited since
/// staging reads as diverged now rather than as it did then.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedEdit {
    pub id: String,
    pub chat_id: String,
    pub zone_id: Option<String>,
    pub path: String,
    pub display_path: String,
    pub tool: String,
    pub created_at: i64,
    /// The file has changed on disk since this was staged, so applying it would
    /// discard that edit.
    pub diverged: bool,
    pub diff: FileDiff,
}

pub async fn list(db: &SqlitePool, chat_id: &str) -> AppResult<Vec<StagedEdit>> {
    let rows: Vec<(String, String, Option<String>, String, String, String, i64, Option<String>, String)> =
        sqlx::query_as(
            "SELECT id, chat_id, zone_id, path, display_path, tool, created_at, disk_hash, content
               FROM staged_edits WHERE chat_id = ?1 AND applied_at IS NULL
              ORDER BY created_at ASC",
        )
        .bind(chat_id)
        .fetch_all(db)
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for (id, chat_id, zone_id, path, display_path, tool, created_at, disk_hash, content) in rows {
        let current = std::fs::read_to_string(&path).ok();
        let diverged = match (&disk_hash, &current) {
            (Some(h), Some(c)) => hash(c) != *h,
            (Some(_), None) => true,
            (None, Some(_)) => true,
            (None, None) => false,
        };
        let diff = diffs::file_diff(&path, &display_path, current.as_deref(), &content);
        out.push(StagedEdit {
            id,
            chat_id,
            zone_id,
            path,
            display_path,
            tool,
            created_at,
            diverged,
            diff,
        });
    }
    Ok(out)
}

/// What applying a staged edit did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub id: String,
    pub display_path: String,
    /// `applied` · `conflict` · `failed`.
    pub outcome: String,
    pub detail: Option<String>,
}

/// Write a staged edit to disk, optionally only the hunks the user took.
///
/// A file that changed on disk since staging is reported as a conflict and left
/// exactly as found unless `force` — the same rule the revert path follows, for
/// the same reason: discarding the user's own edit is the one failure this
/// whole release exists to prevent.
///
/// The write is checkpointed, so an applied batch is revertible like any turn.
pub async fn apply(
    db: &SqlitePool,
    id: &str,
    hunks: Option<&[usize]>,
    force: bool,
) -> AppResult<ApplyOutcome> {
    let row: Option<(String, String, String, Option<String>, String, Option<String>)> =
        sqlx::query_as(
            "SELECT chat_id, path, display_path, disk_hash, content, zone_id
               FROM staged_edits WHERE id = ?1 AND applied_at IS NULL",
        )
        .bind(id)
        .fetch_optional(db)
        .await?;
    let Some((chat_id, path, display_path, disk_hash, content, zone_id)) = row else {
        return Ok(ApplyOutcome {
            id: id.to_string(),
            display_path: String::new(),
            outcome: "failed".into(),
            detail: Some("no longer queued".into()),
        });
    };

    let current = std::fs::read_to_string(&path).ok();
    if !force {
        let moved = match (&disk_hash, &current) {
            (Some(h), Some(c)) => hash(c) != *h,
            (Some(_), None) | (None, Some(_)) => true,
            (None, None) => false,
        };
        if moved {
            return Ok(ApplyOutcome {
                id: id.to_string(),
                display_path,
                outcome: "conflict".into(),
                detail: Some(
                    "the file changed on disk after this was queued — applying would \
                     discard that change"
                        .into(),
                ),
            });
        }
    }

    let final_content = match hunks {
        Some(sel) => {
            let before = current.clone().unwrap_or_default();
            let all = diffs::diff_hunks(&before, &content);
            diffs::apply_hunks(&before, &content, &all, &sel.iter().copied().collect())
        }
        None => content,
    };

    // Applying from the queue is a user action rather than a turn, so it gets a
    // checkpoint of its own — the transcript's "revert" is per turn, and a batch
    // the user applied by hand deserves the same way back.
    let turn = format!("review-{id}");
    let args = json!({ "path": path });
    if let Err(e) = crate::checkpoints::capture(
        db, &chat_id, &turn, zone_id.as_deref(), "write", &args, None,
    )
    .await
    {
        tracing::warn!("checkpoint before applying staged edit failed: {e}");
    }

    if let Some(parent) = Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, final_content.as_bytes()) {
        return Ok(ApplyOutcome {
            id: id.to_string(),
            display_path,
            outcome: "failed".into(),
            detail: Some(e.to_string()),
        });
    }

    if let Err(e) = crate::checkpoints::record_after(
        db, &chat_id, &turn, zone_id.as_deref(), "write", &args, None,
    )
    .await
    {
        tracing::warn!("checkpoint after applying staged edit failed: {e}");
    }

    sqlx::query("UPDATE staged_edits SET applied_at = ?1 WHERE id = ?2")
        .bind(now_ts())
        .bind(id)
        .execute(db)
        .await?;

    Ok(ApplyOutcome {
        id: id.to_string(),
        display_path,
        outcome: "applied".into(),
        detail: None,
    })
}

/// Drop a staged edit without writing it.
pub async fn discard(db: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM staged_edits WHERE id = ?1 AND applied_at IS NULL")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Every queued edit in a chat, oldest first — the order they were proposed in,
/// which is the order they have to be applied in when they build on each other.
pub async fn ids_for_chat(db: &SqlitePool, chat_id: &str) -> AppResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM staged_edits WHERE chat_id = ?1 AND applied_at IS NULL
          ORDER BY created_at ASC",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::MIGRATOR.run(&pool).await.unwrap();
        pool
    }

    fn workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mz_review_{tag}_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The prompt shows a diff, not a wall of proposed content — the whole
    /// point of the release.
    #[tokio::test]
    async fn a_pending_write_previews_as_a_diff() {
        let dir = workspace("preview");
        let db = pool().await;
        let file = dir.join("config.toml");
        std::fs::write(&file, "name = \"old\"\nport = 8080\n").unwrap();

        let args = json!({
            "path": file.to_string_lossy(),
            "content": "name = \"new\"\nport = 8080\n",
        });
        let d = preview(&db, "c", "write", &args.to_string(), None)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(d.change, "modify");
        assert_eq!(d.added, 1);
        assert_eq!(d.removed, 1);
        assert_eq!(d.hunks.len(), 1);

        // A tool with no reviewable change has no preview rather than an empty one.
        assert!(preview(&db, "c", "bash", "{}", None).await.unwrap().is_none());
    }

    /// Approving some hunks and not others runs the call against the content
    /// the user agreed to. If this only recorded a preference it would be a
    /// worse lie than not offering the choice.
    #[tokio::test]
    async fn narrowing_writes_only_the_hunks_that_were_taken() {
        let dir = workspace("narrow");
        let db = pool().await;
        let file = dir.join("app.ts");
        let before = (1..=40).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        std::fs::write(&file, &before).unwrap();

        let mut lines: Vec<String> = before.lines().map(String::from).collect();
        lines[3] = "wanted".into();
        lines[30] = "unwanted".into();
        let after = lines.join("\n");

        let args = json!({ "path": file.to_string_lossy(), "content": after });
        let p = proposal(&db, "c", "write", &args, None).await.unwrap().unwrap();
        let narrowed = narrow_arguments("write", &args, &p, &[0]);

        let written = narrowed["content"].as_str().unwrap();
        assert!(written.contains("wanted"));
        assert!(!written.contains("unwanted"));
        assert!(written.contains("line 31"));
    }

    /// In review mode a write stages instead of landing, and a later read
    /// returns the staged version — otherwise an agent's second edit would be
    /// computed against content it had already superseded.
    #[tokio::test]
    async fn a_staged_write_does_not_touch_the_disk_but_is_what_the_model_reads() {
        let dir = workspace("stage");
        let db = pool().await;
        let file = dir.join("notes.md");
        std::fs::write(&file, "on disk\n").unwrap();

        let args = json!({ "path": file.to_string_lossy(), "content": "staged version\n" });
        let p = proposal(&db, "c", "write", &args, None).await.unwrap().unwrap();
        let result = stage(&db, "c", None, "write", &p).await.unwrap();

        assert!(result.contains("\"staged\":true"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "on disk\n");
        assert_eq!(
            staged_content(&db, "c", &file).await.as_deref(),
            Some("staged version\n"),
        );

        // A second edit builds on the staged version, not on the disk.
        let args2 = json!({
            "path": file.to_string_lossy(),
            "old_text": "staged",
            "new_text": "twice staged",
        });
        let p2 = proposal(&db, "c", "edit", &args2, None).await.unwrap().unwrap();
        assert_eq!(p2.after, "twice staged version\n");
        stage(&db, "c", None, "edit", &p2).await.unwrap();

        // One row per path: the newest proposal is the only coherent one.
        let queued = list(&db, "c").await.unwrap();
        assert_eq!(queued.len(), 1);
        assert!(!queued[0].diverged);

        let outcome = apply(&db, &queued[0].id, None, false).await.unwrap();
        assert_eq!(outcome.outcome, "applied");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "twice staged version\n");
        assert!(list(&db, "c").await.unwrap().is_empty());
    }

    /// A file edited on disk after staging is reported, not clobbered.
    #[tokio::test]
    async fn applying_over_an_outside_edit_is_a_conflict() {
        let dir = workspace("conflict");
        let db = pool().await;
        let file = dir.join("shared.txt");
        std::fs::write(&file, "original\n").unwrap();

        let args = json!({ "path": file.to_string_lossy(), "content": "the agent's version\n" });
        let p = proposal(&db, "c", "write", &args, None).await.unwrap().unwrap();
        stage(&db, "c", None, "write", &p).await.unwrap();

        std::fs::write(&file, "the user's own edit\n").unwrap();

        let queued = list(&db, "c").await.unwrap();
        assert!(queued[0].diverged, "the listing says so before the user clicks");

        let outcome = apply(&db, &queued[0].id, None, false).await.unwrap();
        assert_eq!(outcome.outcome, "conflict");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "the user's own edit\n");

        // Told what it is, the user can still insist.
        let outcome = apply(&db, &queued[0].id, None, true).await.unwrap();
        assert_eq!(outcome.outcome, "applied");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "the agent's version\n");
    }

    /// Discarding leaves the disk alone and empties the queue.
    #[tokio::test]
    async fn discarding_a_staged_edit_writes_nothing() {
        let dir = workspace("discard");
        let db = pool().await;
        let file = dir.join("draft.txt");
        std::fs::write(&file, "keep me\n").unwrap();

        let args = json!({ "path": file.to_string_lossy(), "content": "replace me\n" });
        let p = proposal(&db, "c", "write", &args, None).await.unwrap().unwrap();
        stage(&db, "c", None, "write", &p).await.unwrap();

        let queued = list(&db, "c").await.unwrap();
        discard(&db, &queued[0].id).await.unwrap();

        assert!(list(&db, "c").await.unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep me\n");
    }
}
