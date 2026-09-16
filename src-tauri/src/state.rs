use crate::db;
use crate::error::AppResult;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, RwLock};

pub struct AppState {
    pub db: SqlitePool,
    pub http: reqwest::Client,
    pub app_data_dir: PathBuf,
    pub attachments_dir: PathBuf,
    /// Installer-safe location for the settings backup JSON. Lives *outside* the
    /// bundle-identifier app data dir (which a Windows reinstall/update can
    /// clear) so user preferences survive a version update. See
    /// [`crate::commands::settings::write_backup`].
    pub settings_backup_path: PathBuf,
    /// Per-chat cancellation flags for in-flight streams.
    pub active_streams: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    /// Running HTTP API server, if enabled. Replaced on settings change.
    pub api_server: Mutex<Option<crate::api::ApiHandle>>,
    /// The mDNS advertisement (0.17.0), and why it is not running if it is not.
    /// Its lifetime is the server's: they start and stop together, because an
    /// advertisement outliving its socket points phones at a closed port.
    pub mdns: Mutex<crate::commands::remote::Discovery>,
    /// Tool calls blocked on the user: approval key → the call and where its
    /// answer goes. Carries the call's details as of 0.17.0 so the queue can be
    /// read — and answered — from somewhere other than the window that asked.
    pub tool_approvals: crate::commands::messages::ApprovalGate,
    /// Live dictation sessions (0.8.0): sessionId → capture handle, from
    /// `start_dictation` until `stop_dictation`/`cancel_dictation` removes it.
    pub voice_sessions: Arc<Mutex<HashMap<String, crate::audio::CaptureHandle>>>,
}

impl AppState {
    pub async fn init(app: &AppHandle) -> AppResult<Self> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| crate::error::AppError::Other(format!("app data dir: {e}")))?;

        std::fs::create_dir_all(&app_data_dir)?;

        let attachments_dir = app_data_dir.join("attachments");
        std::fs::create_dir_all(&attachments_dir)?;

        // Where OCR fallback (0.4.0) looks for its pure-Rust model files. Created
        // eagerly so the location is discoverable; OCR degrades gracefully when
        // the `.rten` files aren't present.
        let ocr_models_dir = app_data_dir.join("ocr_models");
        std::fs::create_dir_all(&ocr_models_dir)?;
        crate::ocr::set_models_dir(ocr_models_dir);

        // The managed skills folder: where `npx impeccable install` and friends
        // are told to write, and the first root scanned for folder-backed skills.
        crate::skillpacks::set_managed_root(app_data_dir.join("skills"));

        // Where checkpoints keep the prior contents of files an agent changed,
        // so an edit the user dislikes can be put back (0.10.0).
        crate::checkpoints::set_store_root(app_data_dir.join("checkpoints"));

        // Where the model-window catalogue is cached, for the `read_context`
        // tool, which measures a chat from inside a turn with no AppState in reach.
        crate::llm::context_window::set_data_dir(app_data_dir.clone());

        // Where a plan is written as a Markdown document (0.14.6), so a plan
        // outlives the context that produced it and can be opened as a file.
        // Deliberately here rather than in the user's project: a plan is the
        // app's own record, and writing one should never touch a working tree.
        crate::plans::set_docs_root(app_data_dir.join("plans"));

        let db = db::init(&app_data_dir).await?;

        // The settings backup lives a level up from the bundle-identifier app
        // data dir, in a stable `MultiZone/` folder the Windows installer doesn't
        // own, so it persists across updates that wipe the per-app dir. Falls
        // back to the app data dir itself if the OS data root is unavailable.
        let settings_backup_path = app
            .path()
            .data_dir()
            .unwrap_or_else(|_| app_data_dir.clone())
            .join("MultiZone")
            .join("settings-backup.json");
        // Restore preferences from the backup when the DB is fresh/wiped (e.g.
        // just after a version update). No-op on a genuine first install.
        if let Err(e) =
            crate::commands::settings::restore_from_backup_if_empty(&db, &settings_backup_path).await
        {
            tracing::warn!("settings restore from backup failed: {e}");
        }

        let http = reqwest::Client::builder()
            .user_agent("MultiZone/0.1.0")
            .build()?;

        // Process-global MCP manager: owns live server connections + status, and
        // looks up server/tool config from the same pool.
        crate::mcp::init(db.clone(), http.clone());

        Ok(Self {
            db,
            http,
            app_data_dir,
            attachments_dir,
            settings_backup_path,
            active_streams: Arc::new(RwLock::new(HashMap::new())),
            api_server: Mutex::new(None),
            mdns: Mutex::new(Default::default()),
            tool_approvals: Arc::new(Mutex::new(HashMap::new())),
            voice_sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}
