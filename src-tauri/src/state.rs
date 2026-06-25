use crate::db;
use crate::error::AppResult;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::{oneshot, Mutex, RwLock};

pub struct AppState {
    pub db: SqlitePool,
    pub http: reqwest::Client,
    pub app_data_dir: PathBuf,
    pub attachments_dir: PathBuf,
    /// Per-chat cancellation flags for in-flight streams.
    pub active_streams: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    /// Running HTTP API server, if enabled. Replaced on settings change.
    pub api_server: Mutex<Option<crate::api::ApiHandle>>,
    /// Pending tool-approval gates: chatId → oneshot sender for the approval answer.
    pub tool_approvals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
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

        let db = db::init(&app_data_dir).await?;
        let http = reqwest::Client::builder()
            .user_agent("MultiZone/0.1.0")
            .build()?;

        Ok(Self {
            db,
            http,
            app_data_dir,
            attachments_dir,
            active_streams: Arc::new(RwLock::new(HashMap::new())),
            api_server: Mutex::new(None),
            tool_approvals: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}
