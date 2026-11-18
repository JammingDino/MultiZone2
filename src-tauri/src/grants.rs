//! Paths handed to a chat (0.19.3).
//!
//! A chat's file tools are scoped to one directory — its project's, or the
//! app's default. A grant adds to that: a folder dropped on the chat, a path
//! pasted and accepted, one picked with "Add folder", or the folder the app was
//! launched on from Explorer. Each becomes an extra root in
//! `tools::filesystem::allowed_roots`, by way of the zone config the turn
//! already threads to every file tool (`file_system.granted_roots`, written by
//! `inject_global_tool_config`), so no tool signature changed to carry it.
//!
//! Three rules hold the shape together:
//!
//! - **A grant widens, it never replaces.** A project chat keeps its project as
//!   the working directory; a chat with no project takes its first granted
//!   folder as one, ahead of the app default — which is what makes "open a
//!   chat on this folder" behave like a project (relative paths, `AGENTS.md`,
//!   the repo map, the Files panel).
//! - **Grants belong to the chat the user handed them to, and are inherited.**
//!   A sub-agent or a branch sees every grant on its chain of parents, read
//!   live rather than copied, so revoking one on the parent revokes it for
//!   every agent working under it.
//! - **Paths are stored canonical**, verbatim prefix stripped, so the same
//!   folder dropped twice is one row and the stored form is the one a person
//!   would recognise.

use serde::Serialize;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// How far up `parent_chat_id` a grant is inherited from. Subchat depth is
/// capped far below this; the cap is a guard against a cycle, not a policy.
const MAX_HOPS: usize = 16;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatPath {
    pub path: String,
    pub is_dir: bool,
    pub source: String,
    pub created_at: i64,
    /// False once the folder has been moved or deleted. Shown as stale rather
    /// than quietly dropped: the user granted it, so the user retires it.
    pub exists: bool,
    /// Granted on a parent chat, not this one. Read-only here.
    pub inherited: bool,
}

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share` → `\\srv\share`.
pub fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// A pasted path as people actually copy them: Explorer's "Copy as path" wraps
/// it in double quotes, a terminal may use single ones, and a stray newline
/// rides along.
pub fn clean_input(raw: &str) -> String {
    let t = raw.trim();
    let t = t
        .strip_prefix('"')
        .and_then(|x| x.strip_suffix('"'))
        .or_else(|| t.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
        .unwrap_or(t);
    t.trim().to_string()
}

/// The canonical form of a path the user wants to hand over, or the sentence
/// saying why not — shown to the user as it stands.
pub fn normalize(raw: &str) -> Result<(PathBuf, bool), String> {
    let cleaned = clean_input(raw);
    if cleaned.is_empty() {
        return Err("No path given.".into());
    }
    let p = Path::new(&cleaned);
    if !p.is_absolute() {
        return Err(format!("{cleaned} is not a full path — it needs a drive or a share."));
    }
    let canon = p
        .canonicalize()
        .map_err(|_| format!("{cleaned} doesn't exist, or can't be opened."))?;
    let is_dir = canon.is_dir();
    let canon = strip_verbatim(&canon);
    refuse_too_broad(&canon)?;
    Ok((canon, is_dir))
}

/// The two grants that are never what was meant: a whole drive, and the
/// operating system.
fn refuse_too_broad(p: &Path) -> Result<(), String> {
    if p.parent().is_none() {
        return Err(format!(
            "Granting all of {} would give the agent the whole drive — pick a folder.",
            p.display()
        ));
    }
    for var in ["SystemRoot", "WINDIR"] {
        if let Ok(win) = std::env::var(var) {
            if !win.trim().is_empty() && path_contains(Path::new(&win), p) {
                return Err(format!(
                    "{} is part of Windows itself — the agent can't be given it.",
                    p.display()
                ));
            }
        }
    }
    Ok(())
}

/// Whether `outer` is `inner` or one of its ancestors, compared the way the
/// platform compares paths: case-insensitively on Windows, where `D:\Dev` and
/// `d:\dev` are one folder. Component-wise, so `D:\dev2` is not inside `D:\dev`.
pub fn path_contains(outer: &Path, inner: &Path) -> bool {
    let fold = |p: &Path| -> Vec<String> {
        strip_verbatim(p)
            .components()
            .map(|c| {
                let s = c.as_os_str().to_string_lossy().trim_end_matches(['\\', '/']).to_string();
                if cfg!(windows) { s.to_lowercase() } else { s }
            })
            .filter(|s| !s.is_empty())
            .collect()
    };
    let (o, i) = (fold(outer), fold(inner));
    !o.is_empty() && i.len() >= o.len() && o.iter().zip(&i).all(|(a, b)| a == b)
}

/// The chat and its parents, nearest first.
async fn chain(db: &SqlitePool, chat_id: &str) -> Vec<String> {
    let mut out = vec![chat_id.to_string()];
    let mut cur = chat_id.to_string();
    for _ in 0..MAX_HOPS {
        let parent: Option<String> =
            sqlx::query_scalar("SELECT parent_chat_id FROM chats WHERE id = ?1")
                .bind(&cur)
                .fetch_optional(db)
                .await
                .ok()
                .flatten()
                .flatten();
        match parent {
            Some(p) if !out.contains(&p) => {
                out.push(p.clone());
                cur = p;
            }
            _ => break,
        }
    }
    out
}

/// Every path this chat may reach beyond its working directory, its own and
/// its parents', oldest first.
pub async fn list(db: &SqlitePool, chat_id: &str) -> AppResult<Vec<ChatPath>> {
    let mut out: Vec<ChatPath> = Vec::new();
    for (i, id) in chain(db, chat_id).await.iter().enumerate() {
        let rows: Vec<(String, bool, String, i64)> = sqlx::query_as(
            "SELECT path, is_dir, source, created_at FROM chat_paths
             WHERE chat_id = ?1 ORDER BY created_at, path",
        )
        .bind(id)
        .fetch_all(db)
        .await?;
        for (path, is_dir, source, created_at) in rows {
            if out.iter().any(|p| p.path == path) {
                continue;
            }
            let exists = Path::new(&path).exists();
            out.push(ChatPath { path, is_dir, source, created_at, exists, inherited: i > 0 });
        }
    }
    out.sort_by_key(|p| p.created_at);
    Ok(out)
}

/// Just the paths, for the tools and the prompt. Stale ones are left out: a
/// root that no longer exists cannot be reached anyway, and naming it to the
/// model invites a scope error.
pub async fn roots(db: &SqlitePool, chat_id: &str) -> Vec<String> {
    list(db, chat_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.exists)
        .map(|p| p.path)
        .collect()
}

/// The first granted folder, for a chat with no project.
pub async fn first_folder(db: &SqlitePool, chat_id: &str) -> Option<String> {
    list(db, chat_id)
        .await
        .ok()?
        .into_iter()
        .find(|p| p.is_dir && p.exists)
        .map(|p| p.path)
}

pub async fn grant(db: &SqlitePool, chat_id: &str, raw: &str, source: &str) -> AppResult<ChatPath> {
    let (path, is_dir) = normalize(raw).map_err(AppError::Invalid)?;
    let source = match source {
        "drop" | "paste" | "picker" | "launch" => source,
        _ => "picker",
    };
    let path = path.to_string_lossy().to_string();
    let now = crate::commands::now_ts();
    sqlx::query(
        "INSERT INTO chat_paths (chat_id, path, is_dir, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(chat_id, path) DO NOTHING",
    )
    .bind(chat_id)
    .bind(&path)
    .bind(is_dir)
    .bind(source)
    .bind(now)
    .execute(db)
    .await?;
    list(db, chat_id)
        .await?
        .into_iter()
        .find(|p| p.path == path)
        .ok_or_else(|| AppError::NotFound(path))
}

/// Revoke on this chat only. An inherited grant is revoked where it was made.
pub async fn revoke(db: &SqlitePool, chat_id: &str, path: &str) -> AppResult<bool> {
    let n = sqlx::query("DELETE FROM chat_paths WHERE chat_id = ?1 AND path = ?2")
        .bind(chat_id)
        .bind(path)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStat {
    pub exists: bool,
    pub is_dir: bool,
    /// The canonical form, when it exists — what a grant would store.
    pub path: Option<String>,
}

/// Whether a pasted path is worth offering as a grant. Reads metadata only.
pub fn stat(raw: &str) -> PathStat {
    let cleaned = clean_input(raw);
    let p = Path::new(&cleaned);
    match (p.is_absolute(), p.canonicalize()) {
        (true, Ok(c)) => PathStat {
            exists: true,
            is_dir: c.is_dir(),
            path: Some(strip_verbatim(&c).to_string_lossy().to_string()),
        },
        _ => PathStat { exists: false, is_dir: false, path: None },
    }
}

/// What a path is, as far as projects go — for opening a chat on it in the
/// right place (smart project detection, 0.19.3).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PathContext {
    /// The canonical path asked about.
    pub path: String,
    pub is_dir: bool,
    /// The project whose directory is or contains it, deepest first.
    pub project: Option<ProjectMatch>,
    /// No project has it, but it has the marks of one at its top level.
    pub looks_like_project: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMatch {
    pub project_id: String,
    pub name: String,
    pub directory: String,
    /// The path *is* the project directory, rather than somewhere inside it.
    pub exact: bool,
}

/// Top-level files that mark a folder as a project someone works in. Checked
/// by name only — nothing is walked.
const PROJECT_MARKERS: &[&str] = &[
    ".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "AGENTS.md", "CLAUDE.md",
];

fn looks_like_project(dir: &Path) -> bool {
    dir.is_dir() && PROJECT_MARKERS.iter().any(|m| dir.join(m).exists())
}

/// The deepest of `(id, name, directory)` that is or contains `path`.
pub fn best_project(path: &Path, projects: &[(String, String, String)]) -> Option<ProjectMatch> {
    projects
        .iter()
        .filter(|(_, _, dir)| !dir.trim().is_empty())
        .map(|(id, name, dir)| {
            let canon = Path::new(dir.trim())
                .canonicalize()
                .map(|c| strip_verbatim(&c))
                .unwrap_or_else(|_| PathBuf::from(dir.trim()));
            (id, name, dir, canon)
        })
        .filter(|(_, _, _, canon)| path_contains(canon, path))
        .max_by_key(|(_, _, _, canon)| canon.components().count())
        .map(|(id, name, dir, canon)| ProjectMatch {
            project_id: id.clone(),
            name: name.clone(),
            directory: dir.clone(),
            exact: path_contains(path, &canon),
        })
}

pub async fn path_context(db: &SqlitePool, raw: &str) -> AppResult<PathContext> {
    let (path, is_dir) = normalize(raw).map_err(AppError::Invalid)?;
    let projects: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, name, directory FROM projects
         WHERE directory IS NOT NULL AND TRIM(directory) != ''",
    )
    .fetch_all(db)
    .await?;
    let project = best_project(&path, &projects);
    let looks = project.is_none() && looks_like_project(&path);
    Ok(PathContext {
        path: path.to_string_lossy().to_string(),
        is_dir,
        project,
        looks_like_project: looks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await.unwrap();
        crate::db::MIGRATOR.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('top','t',0,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO chats (id, title, parent_chat_id, created_at, updated_at)
             VALUES ('sub','s','top',0,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    /// The real `read` tool, scoped the way a turn scopes it.
    async fn read(db: &SqlitePool, chat: &str, path: &Path) -> serde_json::Value {
        let mut cfg = json!({});
        crate::commands::messages::inject_grants(&mut cfg, db, chat).await;
        let dir = crate::commands::messages::resolve_working_dir(db, chat).await.unwrap();
        let out = crate::tools::filesystem::read_for_test(&json!({ "path": s(path) }), &cfg, dir.as_deref()).await;
        serde_json::from_str(&out).unwrap_or(json!({ "text": out }))
    }

    fn refused(v: &serde_json::Value) -> bool {
        v.get("error").map(|e| e.to_string().contains("outside")).unwrap_or(false)
    }

    #[tokio::test]
    async fn a_grant_opens_a_folder_and_revoking_closes_it() {
        let db = pool().await;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "hello").unwrap();

        assert!(refused(&read(&db, "top", &file).await), "no grant, no access");
        let g = grant(&db, "top", &s(dir.path()), "drop").await.unwrap();
        assert!(g.is_dir && g.exists && !g.inherited);
        assert!(!refused(&read(&db, "top", &file).await), "granted folder is readable");
        assert!(revoke(&db, "top", &g.path).await.unwrap());
        assert!(refused(&read(&db, "top", &file).await), "revoked again");
    }

    #[tokio::test]
    async fn a_sub_agent_inherits_its_parents_grants() {
        let db = pool().await;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        grant(&db, "top", &s(dir.path()), "drop").await.unwrap();
        assert!(!refused(&read(&db, "sub", &file).await));
        let rows = list(&db, "sub").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].inherited, "shown read-only on the sub-agent");
        // Revoking on the sub-agent does nothing: the grant lives on the parent.
        assert!(!revoke(&db, "sub", &rows[0].path).await.unwrap());
    }

    #[tokio::test]
    async fn the_first_folder_is_a_projectless_chats_working_directory() {
        let db = pool().await;
        let dir = tempfile::tempdir().unwrap();
        let g = grant(&db, "top", &s(dir.path()), "launch").await.unwrap();
        let wd = crate::commands::messages::resolve_working_dir(&db, "top").await.unwrap();
        assert_eq!(wd.as_deref(), Some(g.path.as_str()));

        // A project chat keeps its project's directory.
        let proj = tempfile::tempdir().unwrap();
        sqlx::query(
            "INSERT INTO projects (id, name, directory, created_at, updated_at)
             VALUES ('p','P',?1,0,0)",
        )
        .bind(s(proj.path()))
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("UPDATE chats SET project_id = 'p' WHERE id = 'top'").execute(&db).await.unwrap();
        let wd = crate::commands::messages::resolve_working_dir(&db, "top").await.unwrap();
        assert_eq!(wd.as_deref(), Some(s(proj.path()).as_str()));
    }

    #[tokio::test]
    async fn deleting_the_chat_deletes_its_grants() {
        let db = pool().await;
        let dir = tempfile::tempdir().unwrap();
        grant(&db, "sub", &s(dir.path()), "drop").await.unwrap();
        sqlx::query("DELETE FROM chats WHERE id = 'sub'").execute(&db).await.unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chat_paths").fetch_one(&db).await.unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn a_whole_drive_is_refused() {
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        let err = normalize(root).unwrap_err();
        assert!(err.contains("whole drive"), "{err}");
        let db = pool().await;
        assert!(grant(&db, "top", root, "paste").await.is_err());
    }

    #[tokio::test]
    async fn a_granted_file_is_readable_and_its_sibling_is_not() {
        let db = pool().await;
        let dir = tempfile::tempdir().unwrap();
        let spec = dir.path().join("spec.txt");
        let other = dir.path().join("other.txt");
        std::fs::write(&spec, "spec").unwrap();
        std::fs::write(&other, "other").unwrap();
        // Quoted, the way Explorer's "Copy as path" hands it over.
        let g = grant(&db, "top", &format!("\"{}\"", s(&spec)), "paste").await.unwrap();
        assert!(!g.is_dir);
        assert!(!refused(&read(&db, "top", &spec).await));
        assert!(refused(&read(&db, "top", &other).await));
    }

    #[test]
    fn containment_is_by_component_and_ignores_case_on_windows() {
        assert!(path_contains(Path::new(r"D:\dev"), Path::new(r"D:\dev\x")));
        assert!(path_contains(Path::new(r"D:\dev"), Path::new(r"D:\dev")));
        assert!(!path_contains(Path::new(r"D:\dev"), Path::new(r"D:\dev2")));
        if cfg!(windows) {
            assert!(path_contains(Path::new(r"d:\dev"), Path::new(r"D:\DEV\x")));
            assert!(path_contains(Path::new(r"\\?\D:\dev"), Path::new(r"D:\dev\x")));
        }
    }

    #[test]
    fn the_deepest_containing_project_wins() {
        let root = tempfile::tempdir().unwrap();
        let outer = root.path().join("dev");
        let inner = outer.join("app");
        let sibling = root.path().join("dev2");
        for d in [&inner, &sibling] {
            std::fs::create_dir_all(d.join("src")).unwrap();
        }
        let canon = |p: &Path| strip_verbatim(&p.canonicalize().unwrap());
        let projects = vec![
            ("o".into(), "Outer".into(), s(&outer)),
            ("i".into(), "Inner".into(), s(&inner)),
        ];
        // Equal path: exact.
        let m = best_project(&canon(&inner), &projects).unwrap();
        assert_eq!((m.project_id.as_str(), m.exact), ("i", true));
        // A subfolder: still the deeper project, not exact.
        let m = best_project(&canon(&inner.join("src")), &projects).unwrap();
        assert_eq!((m.project_id.as_str(), m.exact), ("i", false));
        // Inside the outer one only.
        let m = best_project(&canon(&outer), &projects).unwrap();
        assert_eq!(m.project_id, "o");
        // A shared prefix is not containment.
        assert!(best_project(&canon(&sibling), &projects).is_none());
        // Case differs from how the project was saved (Windows).
        if cfg!(windows) {
            let shouty = vec![("o".into(), "Outer".into(), s(&outer).to_uppercase())];
            assert!(best_project(&canon(&inner), &shouty).is_some());
        }
    }

    #[test]
    fn a_repo_looks_like_a_project_and_a_plain_folder_does_not() {
        let d = tempfile::tempdir().unwrap();
        assert!(!looks_like_project(d.path()));
        std::fs::write(d.path().join("Cargo.toml"), "").unwrap();
        assert!(looks_like_project(d.path()));
    }

    #[test]
    fn pasted_quotes_are_cleaned() {
        assert_eq!(clean_input("  \"C:\\a b\\c\"\r\n"), "C:\\a b\\c");
        assert_eq!(clean_input("'C:\\x'"), "C:\\x");
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\x")), PathBuf::from(r"C:\x"));
        assert_eq!(strip_verbatim(Path::new(r"\\?\UNC\srv\s")), PathBuf::from(r"\\srv\s"));
    }
}
