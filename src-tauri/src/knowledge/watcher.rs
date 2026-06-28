//! Live auto re-index (0.4.3). Watches every configured knowledge directory —
//! each user project's directory plus the global KB's default directory — and
//! re-indexes the affected scope when files change on disk. A debouncer coalesces
//! editor save-bursts; `index_project` is incremental (content-hash skip), so a
//! re-walk only re-embeds the files that actually changed.
//!
//! Toggleable via the `autoReindex` app setting (default on). Re-synced at
//! startup and whenever project / global-KB config changes.

use crate::knowledge::{self, GLOBAL_KB_ID};
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use notify::RecommendedWatcher;
use serde_json::json;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// Debounce window — long enough to coalesce a flurry of saves, short enough that
/// a single edit re-indexes promptly.
const DEBOUNCE: Duration = Duration::from_secs(2);

/// Directory names whose changes never warrant a re-index (mirrors the walker's
/// skip list closely enough to avoid VCS/build churn).
const SKIP_COMPONENTS: &[&str] = &[
    ".git", ".svn", ".hg", "node_modules", "target", "dist", "build", "out",
    ".next", ".cache", ".venv", "venv", "__pycache__", ".idea", ".vscode",
];

pub struct Watcher {
    db: SqlitePool,
    http: reqwest::Client,
    app: AppHandle,
    /// Held to keep the OS watch alive; replaced on every resync.
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    /// Canonicalised watch root → scope (project id / GLOBAL_KB_ID).
    roots: Arc<Mutex<Vec<(PathBuf, String)>>>,
    /// Scopes with a re-index in flight, so overlapping bursts don't stack.
    indexing: Arc<Mutex<HashSet<String>>>,
}

static WATCHER: OnceLock<Watcher> = OnceLock::new();

pub fn init(db: SqlitePool, http: reqwest::Client, app: AppHandle) {
    let _ = WATCHER.set(Watcher {
        db,
        http,
        app,
        debouncer: Mutex::new(None),
        roots: Arc::new(Mutex::new(Vec::new())),
        indexing: Arc::new(Mutex::new(HashSet::new())),
    });
}

/// Rebuild the set of watched directories from current config. Safe to call
/// repeatedly (config changes, startup). No-op if the watcher isn't initialised
/// (e.g. headless tests).
pub async fn resync() {
    if let Some(w) = WATCHER.get() {
        if let Err(e) = w.resync().await {
            tracing::warn!("knowledge watcher resync failed: {e}");
        }
    }
}

impl Watcher {
    async fn auto_reindex_enabled(&self) -> bool {
        let raw: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
                .fetch_optional(&self.db)
                .await
                .ok()
                .flatten();
        raw.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("autoReindex").and_then(|b| b.as_bool()))
            .unwrap_or(true)
    }

    /// Directories to watch: every project (including the hidden global KB) that
    /// has a directory AND an embedding config AND an existing index.
    async fn watch_targets(&self) -> Vec<(PathBuf, String)> {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT id, directory FROM projects
             WHERE directory IS NOT NULL AND directory != ''
               AND kb_provider_id IS NOT NULL AND kb_embedding_model IS NOT NULL
               AND kb_indexed_at IS NOT NULL",
        )
        .fetch_all(&self.db)
        .await
        .unwrap_or_default();

        let mut out = Vec::new();
        for (id, dir) in rows {
            if let Some(dir) = dir {
                let p = PathBuf::from(&dir);
                let canon = std::fs::canonicalize(&p).unwrap_or(p);
                if canon.is_dir() {
                    out.push((canon, id));
                }
            }
        }
        out
    }

    async fn resync(&self) -> notify::Result<()> {
        if !self.auto_reindex_enabled().await {
            *self.debouncer.lock().await = None;
            self.roots.lock().await.clear();
            return Ok(());
        }

        let targets = self.watch_targets().await;
        *self.roots.lock().await = targets.clone();

        let roots = self.roots.clone();
        let indexing = self.indexing.clone();
        let db = self.db.clone();
        let http = self.http.clone();
        let app = self.app.clone();

        let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let paths: Vec<PathBuf> = match res {
                Ok(events) => events.into_iter().map(|e| e.path).collect(),
                Err(_) => return,
            };
            let roots = roots.clone();
            let indexing = indexing.clone();
            let db = db.clone();
            let http = http.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let scopes = affected_scopes(&roots, &paths).await;
                for scope in scopes {
                    reindex_scope(&db, &http, &app, &indexing, scope).await;
                }
            });
        })?;

        for (root, _) in &targets {
            // A vanished/locked directory shouldn't sink the whole watcher.
            if let Err(e) = debouncer.watcher().watch(root, RecursiveMode::Recursive) {
                tracing::warn!("failed to watch {}: {e}", root.display());
            }
        }

        *self.debouncer.lock().await = Some(debouncer);
        Ok(())
    }
}

/// Map changed paths back to the scopes whose roots contain them, ignoring paths
/// inside skip directories (VCS/build churn).
async fn affected_scopes(
    roots: &Arc<Mutex<Vec<(PathBuf, String)>>>,
    paths: &[PathBuf],
) -> HashSet<String> {
    let roots = roots.lock().await;
    let mut scopes = HashSet::new();
    for path in paths {
        if is_skippable(path) {
            continue;
        }
        for (root, scope) in roots.iter() {
            if path.starts_with(root) {
                scopes.insert(scope.clone());
            }
        }
    }
    scopes
}

fn is_skippable(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        SKIP_COMPONENTS.contains(&s.as_ref())
    })
}

async fn reindex_scope(
    db: &SqlitePool,
    http: &reqwest::Client,
    app: &AppHandle,
    indexing: &Arc<Mutex<HashSet<String>>>,
    scope: String,
) {
    {
        let mut g = indexing.lock().await;
        if g.contains(&scope) {
            return; // already re-indexing this scope; the latest save is covered
        }
        g.insert(scope.clone());
    }

    match knowledge::index_project(db, http, &scope).await {
        Ok(summary) => {
            // Only notify when something actually changed.
            if summary.indexed > 0 || summary.removed > 0 {
                let is_global = scope == GLOBAL_KB_ID;
                let _ = app.emit(
                    "knowledge-updated",
                    json!({
                        "scope": scope,
                        "global": is_global,
                        "indexed": summary.indexed,
                        "removed": summary.removed,
                    }),
                );
            }
        }
        Err(e) => tracing::warn!("auto re-index of {scope} failed: {e}"),
    }

    indexing.lock().await.remove(&scope);
}
