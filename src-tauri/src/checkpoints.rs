//! Checkpoints (0.10.0) — a way back from the file tools.
//!
//! `create_file`, `edit_file`, `move_file` and `delete_file` were one-way doors.
//! The user's only protection was the approval prompt, which asks *before* a
//! change and offers nothing after it, so approving an edit meant living with
//! it. A checkpoint is taken before the first mutating tool call of a turn and
//! extended by each later one, holding what was on disk before the turn touched
//! it; restoring puts those paths back.
//!
//! Three properties are worth stating because they shape the code:
//!
//! - **Per-path, not per-tree.** An agent that edits three files costs three
//!   files of storage. Snapshotting the working directory would be simpler and
//!   is not affordable on a real project.
//! - **Content-addressed.** A file unchanged across ten turns is stored once.
//!   Blobs live under `<app_data_dir>/checkpoints/blobs/<xx>/<hash>` and are
//!   shared by every checkpoint that saw those bytes.
//! - **Honest about what it cannot hold.** A directory, or a file past
//!   [`MAX_BLOB_BYTES`], is recorded as unstorable with the reason. A restore
//!   reports it rather than silently leaving that path as it found it.

use crate::commands::{new_id, now_ts};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Files past this are recorded by size alone. A checkpoint exists to make an
/// agent's edits reversible, and an agent does not hand-edit a 32 MB file — but
/// it can easily *generate* one, and silently copying that on every turn is how
/// a local-first app eats a disk.
const MAX_BLOB_BYTES: u64 = 32 * 1024 * 1024;

static STORE_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Point the blob store at `<app_data_dir>/checkpoints`. Called once at startup.
pub fn set_store_root(dir: PathBuf) {
    let _ = std::fs::create_dir_all(dir.join("blobs"));
    let _ = STORE_ROOT.set(dir);
}

fn blob_path(hash: &str) -> Option<PathBuf> {
    let root = STORE_ROOT.get()?;
    // Two-character shard, so a store with many thousands of blobs doesn't put
    // them all in one directory.
    Some(root.join("blobs").join(&hash[..2]).join(hash))
}

/// The paths a tool call is about to change, as the model wrote them.
///
/// Deliberately parallel to `teamwork::guarded_paths` — the set of tools that
/// need a claim and the set that need a checkpoint are the same question asked
/// twice — but not shared with it, because they answer differently for `copy_file`
/// and `create_folder`: a copy only *writes* its destination, and a folder
/// creation is worth being able to undo even though it holds no content.
fn mutating_paths(name: &str, args: &Value) -> Vec<String> {
    let pick = |keys: &[&str]| -> Vec<String> {
        keys.iter()
            .filter_map(|k| args.get(*k).and_then(|v| v.as_str()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    match name {
        "create_file" | "edit_file" | "delete_file" => pick(&["path", "file_path"]),
        // A move changes both ends: the source stops existing and the
        // destination starts, so both have to be restorable.
        "move_file" => pick(&["source_path", "destination_path", "from", "to"]),
        "copy_file" => pick(&["destination_path", "to"]),
        "create_folder" => pick(&["path"]),
        _ => Vec::new(),
    }
}

/// Absolute, normalised form — the key a path is recorded under. Matches
/// `teamwork::norm_path` so the same file named three ways is one row.
fn norm_path(path: &str, project_dir: Option<&str>) -> String {
    let resolved = crate::tools::filesystem::resolve_path(path, project_dir);
    let s = resolved.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// What a path looked like at a moment in time.
enum Snapshot {
    /// Nothing there. Restoring means deleting whatever is there now.
    Absent,
    /// Captured: content hash and size.
    Stored { hash: String, size: u64 },
    /// Present but not captured, with the reason.
    Unstorable(String),
}

/// Read a path and, if it holds storable content, write it into the blob store.
fn snapshot(path: &Path) -> Snapshot {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        // Any error reaching it — missing, or a permission problem we would hit
        // again on restore — is recorded as absent only when it is genuinely
        // missing, so a restore never deletes a file we merely failed to read.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Snapshot::Absent,
        Err(e) => return Snapshot::Unstorable(format!("could not be read: {e}")),
    };
    if meta.is_dir() {
        return Snapshot::Unstorable("a directory — its contents are not snapshotted".into());
    }
    if meta.len() > MAX_BLOB_BYTES {
        return Snapshot::Unstorable(format!(
            "{} bytes, over the {MAX_BLOB_BYTES} byte checkpoint limit",
            meta.len()
        ));
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return Snapshot::Unstorable(format!("could not be read: {e}")),
    };
    let hash = hex(&Sha256::digest(&bytes));
    let Some(dest) = blob_path(&hash) else {
        return Snapshot::Unstorable("the checkpoint store is not configured".into());
    };
    // Content-addressed: identical bytes are already there and are the same
    // bytes, so re-writing them would be pure cost.
    if !dest.exists() {
        if let Some(parent) = dest.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Snapshot::Unstorable(format!("could not be stored: {e}"));
            }
        }
        if let Err(e) = std::fs::write(&dest, &bytes) {
            return Snapshot::Unstorable(format!("could not be stored: {e}"));
        }
    }
    Snapshot::Stored { hash, size: meta.len() }
}

/// Hash a path's current contents without storing them — used to tell "the
/// agent left it like this" from "somebody edited it afterwards".
fn current_hash(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(hex(&Sha256::digest(&bytes)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Capture the pre-state of everything `name`'s arguments say it will change.
///
/// Called before the tool runs. A non-mutating tool, or one whose arguments
/// name no path, is a cheap no-op — which is the overwhelming majority of tool
/// calls, so nothing here touches the database until there is something to
/// record. A path already covered by this turn's checkpoint is left alone: the
/// pre-state is what the file looked like before the *turn*, not before the
/// second edit of it.
pub async fn capture(
    db: &SqlitePool,
    chat_id: &str,
    turn_id: &str,
    zone_id: Option<&str>,
    name: &str,
    args: &Value,
    project_dir: Option<&str>,
) -> AppResult<()> {
    let paths = mutating_paths(name, args);
    if paths.is_empty() {
        return Ok(());
    }
    let checkpoint_id = open_checkpoint(db, chat_id, turn_id, zone_id, name).await?;

    for display in paths {
        let key = norm_path(&display, project_dir);
        let already: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM checkpoint_files WHERE checkpoint_id = ?1 AND path = ?2",
        )
        .bind(&checkpoint_id)
        .bind(&key)
        .fetch_optional(db)
        .await?;
        if already.is_some() {
            continue;
        }

        let (existed, hash, size, unstorable) = match snapshot(Path::new(&key)) {
            Snapshot::Absent => (0i64, None, None, None),
            Snapshot::Stored { hash, size } => (1, Some(hash), Some(size as i64), None),
            Snapshot::Unstorable(why) => (1, None, None, Some(why)),
        };

        sqlx::query(
            "INSERT INTO checkpoint_files
               (checkpoint_id, path, display_path, existed, before_hash, before_size, unstorable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(&checkpoint_id)
        .bind(&key)
        .bind(&display)
        .bind(existed)
        .bind(&hash)
        .bind(size)
        .bind(&unstorable)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// Record what the paths look like now the tool has run.
///
/// This is what makes a later restore able to say "somebody edited this after
/// the agent did" rather than overwriting whatever it finds. Called after the
/// tool returns, for the same paths [`capture`] took.
pub async fn record_after(
    db: &SqlitePool,
    chat_id: &str,
    turn_id: &str,
    zone_id: Option<&str>,
    name: &str,
    args: &Value,
    project_dir: Option<&str>,
) -> AppResult<()> {
    let paths = mutating_paths(name, args);
    if paths.is_empty() {
        return Ok(());
    }
    let Some(checkpoint_id) = find_checkpoint(db, chat_id, turn_id, zone_id).await? else {
        return Ok(());
    };
    for display in paths {
        let key = norm_path(&display, project_dir);
        let after = current_hash(Path::new(&key));
        sqlx::query("UPDATE checkpoint_files SET after_hash = ?1 WHERE checkpoint_id = ?2 AND path = ?3")
            .bind(&after)
            .bind(&checkpoint_id)
            .bind(&key)
            .execute(db)
            .await?;
    }
    Ok(())
}

async fn find_checkpoint(
    db: &SqlitePool,
    chat_id: &str,
    turn_id: &str,
    zone_id: Option<&str>,
) -> AppResult<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM checkpoints
          WHERE chat_id = ?1 AND turn_id = ?2 AND COALESCE(zone_id, '') = COALESCE(?3, '')",
    )
    .bind(chat_id)
    .bind(turn_id)
    .bind(zone_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id,)| id))
}

/// The turn's checkpoint, created on the first mutating call and reused after.
async fn open_checkpoint(
    db: &SqlitePool,
    chat_id: &str,
    turn_id: &str,
    zone_id: Option<&str>,
    label: &str,
) -> AppResult<String> {
    if let Some(id) = find_checkpoint(db, chat_id, turn_id, zone_id).await? {
        return Ok(id);
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO checkpoints (id, chat_id, turn_id, zone_id, created_at, label)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(&id)
    .bind(chat_id)
    .bind(turn_id)
    .bind(zone_id)
    .bind(now_ts())
    .bind(label)
    .execute(db)
    .await?;
    Ok(id)
}

/// Anchor this turn's checkpoint to the assistant message the turn opened with.
///
/// The turn id is internal to the agentic loop; the transcript is addressed by
/// message. Only the first assistant message of a turn wins, because that is
/// where "revert what this turn did" belongs — a turn that took five steps
/// should offer one revert, at the top, not five.
///
/// A no-op when the turn changed nothing, which is nearly every turn: the
/// checkpoint it would anchor was never created.
pub async fn link_message(
    db: &SqlitePool,
    chat_id: &str,
    turn_id: &str,
    zone_id: Option<&str>,
    message_id: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE checkpoints SET message_id = ?1
          WHERE chat_id = ?2 AND turn_id = ?3
            AND COALESCE(zone_id, '') = COALESCE(?4, '')
            AND message_id IS NULL",
    )
    .bind(message_id)
    .bind(chat_id)
    .bind(turn_id)
    .bind(zone_id)
    .execute(db)
    .await?;
    Ok(())
}

/// One path a checkpoint covers, as the transcript lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    pub path: String,
    pub display_path: String,
    /// What the turn did to it: `created` (nothing was there before),
    /// `changed`, or `deleted`.
    pub change: String,
    /// Set when the prior contents could not be captured, and why.
    pub unstorable: Option<String>,
    /// True when what is on disk now is not what the assistant left — someone
    /// has edited it since, so restoring would discard that edit.
    pub diverged: bool,
}

/// A turn's worth of file changes, addressed by the message it belongs to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub chat_id: String,
    pub message_id: Option<String>,
    pub zone_id: Option<String>,
    pub created_at: i64,
    pub label: Option<String>,
    pub restored_at: Option<i64>,
    pub files: Vec<CheckpointFile>,
}

/// Every checkpoint in a chat, newest first, each with the paths it covers.
///
/// `diverged` is computed here rather than stored: it is a fact about the disk
/// right now, and a file the user edited two minutes ago must not still read as
/// safely revertible because that was true when the row was written.
pub async fn list_for_chat(db: &SqlitePool, chat_id: &str) -> AppResult<Vec<Checkpoint>> {
    let heads: Vec<(String, String, Option<String>, Option<String>, i64, Option<String>, Option<i64>)> =
        sqlx::query_as(
            "SELECT id, chat_id, message_id, zone_id, created_at, label, restored_at
               FROM checkpoints WHERE chat_id = ?1 ORDER BY created_at DESC",
        )
        .bind(chat_id)
        .fetch_all(db)
        .await?;

    let mut out = Vec::with_capacity(heads.len());
    for (id, chat_id, message_id, zone_id, created_at, label, restored_at) in heads {
        let rows: Vec<(String, String, i64, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(
                "SELECT path, display_path, existed, before_hash, after_hash, unstorable
                   FROM checkpoint_files WHERE checkpoint_id = ?1 ORDER BY display_path",
            )
            .bind(&id)
            .fetch_all(db)
            .await?;

        let files = rows
            .into_iter()
            .map(|(path, display_path, existed, _before, after_hash, unstorable)| {
                let now = current_hash(Path::new(&path));
                let change = match (existed == 1, now.is_some()) {
                    (false, _) => "created",
                    (true, false) => "deleted",
                    (true, true) => "changed",
                };
                CheckpointFile {
                    path,
                    display_path,
                    change: change.to_string(),
                    unstorable,
                    diverged: after_hash.is_some_and(|a| now.as_deref() != Some(a.as_str())),
                }
            })
            .collect();

        out.push(Checkpoint {
            id,
            chat_id,
            message_id,
            zone_id,
            created_at,
            label,
            restored_at,
            files,
        });
    }
    Ok(out)
}

/// One path's fate in a restore, for the report the user reads.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoredFile {
    pub path: String,
    pub display_path: String,
    /// `restored` · `deleted` (it did not exist before) · `unchanged` ·
    /// `conflict` · `skipped`.
    pub outcome: String,
    /// Why, when the outcome needs explaining.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub checkpoint_id: String,
    pub files: Vec<RestoredFile>,
    /// The checkpoint taken of the restore itself, so undo is undoable.
    pub undo_checkpoint_id: Option<String>,
}

/// Put a checkpoint's paths back.
///
/// `only` restricts the restore to a subset, so a run that got three edits
/// right and one wrong doesn't have to be thrown away whole. `force` proceeds
/// past a file that changed after the agent left it — without it, that path is
/// reported as a conflict and left exactly as found, because overwriting an
/// edit the user made by hand is the one failure this feature must not have.
///
/// The restore is itself checkpointed before anything is written, so undoing an
/// undo is the same operation again.
pub async fn restore(
    db: &SqlitePool,
    checkpoint_id: &str,
    only: Option<&[String]>,
    force: bool,
) -> AppResult<RestoreReport> {
    let rows: Vec<(String, String, i64, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT path, display_path, existed, before_hash, after_hash, unstorable
               FROM checkpoint_files WHERE checkpoint_id = ?1 ORDER BY path",
        )
        .bind(checkpoint_id)
        .fetch_all(db)
        .await?;
    if rows.is_empty() {
        return Err(AppError::NotFound(format!("checkpoint {checkpoint_id}")));
    }

    let chosen: Vec<_> = rows
        .into_iter()
        .filter(|(path, ..)| only.is_none_or(|list| list.iter().any(|p| p == path)))
        .collect();

    // Snapshot the current state first, under a checkpoint of its own, so the
    // restore can itself be undone. Its turn id is the restore's own id, which
    // no agent turn can collide with.
    let undo_turn = new_id();
    let undo_id = open_checkpoint(db, &chat_of(db, checkpoint_id).await?, &undo_turn, None, "revert")
        .await?;
    for (path, display, ..) in &chosen {
        let (existed, hash, size, unstorable) = match snapshot(Path::new(path)) {
            Snapshot::Absent => (0i64, None, None, None),
            Snapshot::Stored { hash, size } => (1, Some(hash), Some(size as i64), None),
            Snapshot::Unstorable(why) => (1, None, None, Some(why)),
        };
        sqlx::query(
            "INSERT OR REPLACE INTO checkpoint_files
               (checkpoint_id, path, display_path, existed, before_hash, before_size, unstorable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(&undo_id)
        .bind(path)
        .bind(display)
        .bind(existed)
        .bind(&hash)
        .bind(size)
        .bind(&unstorable)
        .execute(db)
        .await?;
    }

    let mut files = Vec::new();
    for (path, display_path, existed, before_hash, after_hash, unstorable) in chosen {
        let p = Path::new(&path);
        let now = current_hash(p);

        // Changed since the agent left it? Only meaningful when we know what it
        // left — a checkpoint whose turn was cancelled has no after_hash, and
        // guessing there would block restores for no reason.
        if !force {
            if let Some(after) = &after_hash {
                if now.as_ref() != Some(after) {
                    files.push(RestoredFile {
                        path,
                        display_path,
                        outcome: "conflict".into(),
                        detail: Some(
                            "changed since the assistant last wrote it — restoring would \
                             discard that edit"
                                .into(),
                        ),
                    });
                    continue;
                }
            }
        }

        if let Some(why) = unstorable {
            files.push(RestoredFile {
                path,
                display_path,
                outcome: "skipped".into(),
                detail: Some(format!("not captured: {why}")),
            });
            continue;
        }

        if existed == 0 {
            let outcome = match std::fs::remove_file(p) {
                Ok(()) => "deleted",
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => "unchanged",
                Err(e) => {
                    files.push(RestoredFile {
                        path,
                        display_path,
                        outcome: "skipped".into(),
                        detail: Some(format!("could not be removed: {e}")),
                    });
                    continue;
                }
            };
            files.push(RestoredFile { path, display_path, outcome: outcome.into(), detail: None });
            continue;
        }

        let Some(hash) = before_hash else {
            files.push(RestoredFile {
                path,
                display_path,
                outcome: "skipped".into(),
                detail: Some("its prior contents were never captured".into()),
            });
            continue;
        };
        if now.as_deref() == Some(hash.as_str()) {
            files.push(RestoredFile { path, display_path, outcome: "unchanged".into(), detail: None });
            continue;
        }
        let Some(blob) = blob_path(&hash).filter(|b| b.exists()) else {
            files.push(RestoredFile {
                path,
                display_path,
                outcome: "skipped".into(),
                detail: Some("its stored contents are no longer in the checkpoint store".into()),
            });
            continue;
        };
        let outcome = match std::fs::read(&blob).and_then(|bytes| {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(p, bytes)
        }) {
            Ok(()) => RestoredFile { path, display_path, outcome: "restored".into(), detail: None },
            Err(e) => RestoredFile {
                path,
                display_path,
                outcome: "skipped".into(),
                detail: Some(format!("could not be written: {e}")),
            },
        };
        files.push(outcome);
    }

    sqlx::query("UPDATE checkpoints SET restored_at = ?1 WHERE id = ?2")
        .bind(now_ts())
        .bind(checkpoint_id)
        .execute(db)
        .await?;

    Ok(RestoreReport {
        checkpoint_id: checkpoint_id.to_string(),
        files,
        undo_checkpoint_id: Some(undo_id),
    })
}

async fn chat_of(db: &SqlitePool, checkpoint_id: &str) -> AppResult<String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT chat_id FROM checkpoints WHERE id = ?1")
        .bind(checkpoint_id)
        .fetch_optional(db)
        .await?;
    row.map(|(c,)| c)
        .ok_or_else(|| AppError::NotFound(format!("checkpoint {checkpoint_id}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::MIGRATOR.run(&pool).await.unwrap();
        pool
    }

    /// The blob store is process-global (a `OnceLock`, set once at startup), so
    /// the tests share one and each takes its own working directory inside it.
    /// Sharing the *store* is safe by construction — it is content-addressed,
    /// so two tests writing the same bytes are meant to collide.
    static TEST_ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();

    fn workspace(name: &str) -> PathBuf {
        let root = TEST_ROOT.get_or_init(|| tempfile::tempdir().unwrap());
        set_store_root(root.path().join("store"));
        let dir = root.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A checkpoint covers the tools that change files and nothing else. A read
    /// or a search taking a checkpoint would cost a hash of every file an agent
    /// looks at, which on a research turn is most of the project.
    #[test]
    fn only_mutating_tools_take_a_checkpoint() {
        let args = json!({ "path": "src/a.ts", "content": "x" });
        assert_eq!(mutating_paths("create_file", &args), vec!["src/a.ts"]);
        assert_eq!(mutating_paths("edit_file", &args), vec!["src/a.ts"]);
        assert_eq!(mutating_paths("delete_file", &args), vec!["src/a.ts"]);
        assert_eq!(mutating_paths("create_folder", &args), vec!["src/a.ts"]);
        assert!(mutating_paths("read_file", &args).is_empty());
        assert!(mutating_paths("search_file_text", &args).is_empty());
        assert!(mutating_paths("smart_search", &args).is_empty());

        // A move changes both ends; a copy only writes its destination, so the
        // source needs no checkpoint.
        let two = json!({ "source_path": "a.ts", "destination_path": "b.ts" });
        assert_eq!(mutating_paths("move_file", &two), vec!["a.ts", "b.ts"]);
        assert_eq!(mutating_paths("copy_file", &two), vec!["b.ts"]);
    }

    /// The whole point: an edit lands, the user dislikes it, the file comes back.
    #[tokio::test]
    async fn an_edited_file_is_restored_to_its_prior_contents() {
        let dir = workspace("an_edited_file_is_restored_to_its_prior_contents");
        let db = pool().await;

        let file = dir.join("notes.md");
        std::fs::write(&file, "original").unwrap();
        let args = json!({ "path": file.to_string_lossy() });

        capture(&db, "chat1", "turn1", None, "edit_file", &args, None).await.unwrap();
        std::fs::write(&file, "the agent's version").unwrap();
        record_after(&db, "chat1", "turn1", None, "edit_file", &args, None).await.unwrap();

        let id = find_checkpoint(&db, "chat1", "turn1", None).await.unwrap().unwrap();
        let report = restore(&db, &id, None, false).await.unwrap();

        assert_eq!(report.files.len(), 1);
        assert_eq!(report.files[0].outcome, "restored");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
    }

    /// A file the turn *created* did not exist before, so putting it back means
    /// removing it — the case a naive "write the old contents" restore misses
    /// entirely, leaving the agent's new file behind.
    #[tokio::test]
    async fn a_created_file_is_removed_on_restore() {
        let dir = workspace("a_created_file_is_removed_on_restore");
        let db = pool().await;

        let file = dir.join("new.txt");
        let args = json!({ "path": file.to_string_lossy() });

        capture(&db, "chat1", "turn1", None, "create_file", &args, None).await.unwrap();
        std::fs::write(&file, "brand new").unwrap();
        record_after(&db, "chat1", "turn1", None, "create_file", &args, None).await.unwrap();

        let id = find_checkpoint(&db, "chat1", "turn1", None).await.unwrap().unwrap();
        let report = restore(&db, &id, None, false).await.unwrap();

        assert_eq!(report.files[0].outcome, "deleted");
        assert!(!file.exists());
    }

    /// Several mutating calls in one turn extend one checkpoint, so "revert this
    /// turn" is one action — and the pre-state kept is the state before the
    /// *turn*, not before the second edit of the same file.
    #[tokio::test]
    async fn a_turn_is_one_checkpoint_holding_the_pre_turn_state() {
        let dir = workspace("a_turn_is_one_checkpoint_holding_the_pre_turn_state");
        let db = pool().await;

        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, "a original").unwrap();
        std::fs::write(&b, "b original").unwrap();
        let arg_a = json!({ "path": a.to_string_lossy() });
        let arg_b = json!({ "path": b.to_string_lossy() });

        capture(&db, "c", "t", None, "edit_file", &arg_a, None).await.unwrap();
        std::fs::write(&a, "first edit").unwrap();
        // Same file again, later in the same turn: the pre-state must not be
        // overwritten with "first edit".
        capture(&db, "c", "t", None, "edit_file", &arg_a, None).await.unwrap();
        std::fs::write(&a, "second edit").unwrap();
        capture(&db, "c", "t", None, "edit_file", &arg_b, None).await.unwrap();
        std::fs::write(&b, "b edited").unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM checkpoints")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count.0, 1, "one turn, one checkpoint");

        let id = find_checkpoint(&db, "c", "t", None).await.unwrap().unwrap();
        restore(&db, &id, None, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "a original");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "b original");
    }

    /// A file the user edited by hand after the agent left it is never
    /// clobbered. This is the failure the feature must not have: an undo that
    /// silently discards the user's own work is worse than no undo.
    #[tokio::test]
    async fn a_file_edited_after_the_turn_is_reported_not_overwritten() {
        let dir = workspace("a_file_edited_after_the_turn_is_reported_not_overwritten");
        let db = pool().await;

        let file = dir.join("notes.md");
        std::fs::write(&file, "original").unwrap();
        let args = json!({ "path": file.to_string_lossy() });

        capture(&db, "c", "t", None, "edit_file", &args, None).await.unwrap();
        std::fs::write(&file, "the agent's version").unwrap();
        record_after(&db, "c", "t", None, "edit_file", &args, None).await.unwrap();
        std::fs::write(&file, "and then the user's own edit").unwrap();

        let id = find_checkpoint(&db, "c", "t", None).await.unwrap().unwrap();
        let report = restore(&db, &id, None, false).await.unwrap();
        assert_eq!(report.files[0].outcome, "conflict");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "and then the user's own edit",
        );

        // Told what it is, the user can still insist.
        let report = restore(&db, &id, None, true).await.unwrap();
        assert_eq!(report.files[0].outcome, "restored");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
    }

    /// Restoring is itself checkpointed, so a revert can be reverted.
    #[tokio::test]
    async fn undo_is_undoable() {
        let dir = workspace("undo_is_undoable");
        let db = pool().await;

        let file = dir.join("notes.md");
        std::fs::write(&file, "original").unwrap();
        let args = json!({ "path": file.to_string_lossy() });

        capture(&db, "c", "t", None, "edit_file", &args, None).await.unwrap();
        std::fs::write(&file, "agent version").unwrap();
        record_after(&db, "c", "t", None, "edit_file", &args, None).await.unwrap();

        let id = find_checkpoint(&db, "c", "t", None).await.unwrap().unwrap();
        let report = restore(&db, &id, None, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");

        let undo = report.undo_checkpoint_id.unwrap();
        restore(&db, &undo, None, true).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "agent version");
    }

    /// A turn that took five steps offers one revert, anchored at the message
    /// it opened with — not one per step, and not moving to the last step's
    /// message as the turn goes on.
    #[tokio::test]
    async fn a_turn_is_anchored_to_its_first_assistant_message() {
        let dir = workspace("a_turn_is_anchored_to_its_first_assistant_message");
        let db = pool().await;

        let file = dir.join("a.txt");
        std::fs::write(&file, "before").unwrap();
        capture(&db, "c", "t", None, "edit_file", &json!({ "path": file.to_string_lossy() }), None)
            .await
            .unwrap();

        link_message(&db, "c", "t", None, "msg-step-1").await.unwrap();
        link_message(&db, "c", "t", None, "msg-step-2").await.unwrap();

        let list = list_for_chat(&db, "c").await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message_id.as_deref(), Some("msg-step-1"));

        // A turn that changed nothing has no checkpoint to anchor, and saying so
        // must not be an error — that is the overwhelming majority of turns.
        link_message(&db, "c", "quiet-turn", None, "msg").await.unwrap();
        assert_eq!(list_for_chat(&db, "c").await.unwrap().len(), 1);
    }

    /// The listing tells the transcript what each path's state is *now*, so a
    /// file the user edited since the turn is flagged before they click revert
    /// rather than after.
    #[tokio::test]
    async fn listing_flags_a_path_that_diverged_since_the_turn() {
        let dir = workspace("listing_flags_a_path_that_diverged_since_the_turn");
        let db = pool().await;

        let calm = dir.join("calm.txt");
        let touched = dir.join("touched.txt");
        std::fs::write(&calm, "before").unwrap();
        std::fs::write(&touched, "before").unwrap();
        for f in [&calm, &touched] {
            let args = json!({ "path": f.to_string_lossy() });
            capture(&db, "c", "t", None, "edit_file", &args, None).await.unwrap();
            std::fs::write(f, "the agent's version").unwrap();
            record_after(&db, "c", "t", None, "edit_file", &args, None).await.unwrap();
        }
        std::fs::write(&touched, "and then the user's own edit").unwrap();

        let list = list_for_chat(&db, "c").await.unwrap();
        let files = &list[0].files;
        assert_eq!(files.len(), 2);
        let by_name = |n: &str| files.iter().find(|f| f.display_path.ends_with(n)).unwrap();
        assert!(!by_name("calm.txt").diverged);
        assert!(by_name("touched.txt").diverged);
        assert_eq!(by_name("calm.txt").change, "changed");
    }

    /// Identical bytes are stored once however many checkpoints see them.
    #[tokio::test]
    async fn identical_contents_are_stored_once() {
        let dir = workspace("identical_contents_are_stored_once");
        let db = pool().await;

        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, "same bytes").unwrap();
        std::fs::write(&b, "same bytes").unwrap();

        capture(&db, "c", "t1", None, "edit_file", &json!({ "path": a.to_string_lossy() }), None)
            .await
            .unwrap();
        capture(&db, "c", "t2", None, "edit_file", &json!({ "path": b.to_string_lossy() }), None)
            .await
            .unwrap();

        let hashes: Vec<(String,)> =
            sqlx::query_as("SELECT DISTINCT before_hash FROM checkpoint_files")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(hashes.len(), 1, "two files, identical bytes, one content address");
        // And that address holds exactly one file in the store — content
        // addressing is what makes a file unchanged across ten turns cost one copy.
        let blob = blob_path(&hashes[0].0).unwrap();
        assert!(blob.is_file());
    }
}
