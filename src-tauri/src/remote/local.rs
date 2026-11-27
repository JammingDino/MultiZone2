//! Open MultiZone in the browser (0.21).
//!
//! The phone has driven this same React app over the HTTP API since 0.17, so a
//! browser tab on the desktop itself is the remote transport pointed at
//! loopback. What is different is the trust: the person in that tab is the user
//! at their own machine, not a paired device on the network, so a short list of
//! GUI-only commands (file pickers, "open in the default app", PDF attachments)
//! is served to it — and to nothing else.
//!
//! The listener is its own socket, separate from the API the user switches on
//! in Settings: always `127.0.0.1`, never the LAN, and up only while browser
//! mode (or the tray's "Open in browser") wants it. Sign-in is a one-time code
//! in the URL the app opens, redeemed by the page for a session token that only
//! lives in this process — nothing long-lived lands in the address bar or the
//! browser history, and every session ends when the app quits.
//!
//! The token travels as a bearer header, never a cookie, so a cross-site page
//! has no ambient credential to ride on and there is no CSRF surface. What a
//! hostile page *can* do is DNS-rebind its own name onto 127.0.0.1 and talk to
//! the socket same-origin; the Host check refuses that before any route runs.

use crate::api::{ApiError, ApiResult, ApiState};
use crate::error::AppError;
use crate::remote::DeviceAuth;
use crate::state::AppState;
use axum::{
    extract::{Request, State},
    http::{header, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Tried first, so the tab's origin (and the little it keeps in localStorage)
/// is the same from one launch to the next. One above the API's default, which
/// the user's own server may already hold.
pub const PREFERRED_PORT: u16 = 8766;

/// Long enough for a cold browser to start and load the page; short enough that
/// a code left in the history is dead long before anyone reads it.
const CODE_TTL: Duration = Duration::from_secs(120);

/// Browser mode, as read at launch. A static because the tray and the
/// single-instance callback are synchronous and cannot read the database.
static BROWSER_MODE: AtomicBool = AtomicBool::new(false);

pub fn browser_mode() -> bool {
    BROWSER_MODE.load(Ordering::Relaxed)
}

/// `openIn` from `app_settings`: "browser", or the window by default.
pub async fn read_mode(db: &sqlx::SqlitePool) -> bool {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    let on = raw
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("openIn").and_then(Value::as_str).map(|s| s == "browser"))
        .unwrap_or(false);
    BROWSER_MODE.store(on, Ordering::Relaxed);
    on
}

// ─── Codes and sessions ──────────────────────────────────────────────────────

/// One-time codes and the sessions they were exchanged for. `now` is passed in
/// so the expiry is testable without sleeping.
#[derive(Default)]
struct Logins {
    codes: HashMap<String, Instant>,
    sessions: HashSet<String>,
}

impl Logins {
    fn mint(&mut self, now: Instant) -> String {
        self.codes.retain(|_, at| now.duration_since(*at) < CODE_TTL);
        let code = secret();
        self.codes.insert(code.clone(), now);
        code
    }

    /// Spend a code. Removed whether or not it was still fresh, so a second try
    /// with the same one fails even inside its lifetime.
    fn redeem(&mut self, code: &str, now: Instant) -> Option<String> {
        let at = self.codes.remove(code)?;
        if now.duration_since(at) >= CODE_TTL {
            return None;
        }
        let token = secret();
        self.sessions.insert(token.clone());
        Some(token)
    }
}

static LOGINS: Mutex<Option<Logins>> = Mutex::new(None);

fn with_logins<T>(f: impl FnOnce(&mut Logins) -> T) -> T {
    let mut guard = LOGINS.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(Logins::default))
}

fn secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub fn session_valid(token: &str) -> bool {
    with_logins(|l| l.sessions.contains(token))
}

/// Only our own name for the socket. Anything else is a page that resolved its
/// own hostname to 127.0.0.1 (DNS rebinding), or a request that never came
/// from a browser on this machine.
pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else { return false };
    let host = host.to_ascii_lowercase();
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

pub async fn host_check(State(st): State<ApiState>, req: Request, next: Next) -> Response {
    let port = st.local_port.unwrap_or(0);
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok());
    if !host_allowed(host, port) {
        return (StatusCode::MISDIRECTED_REQUEST, "wrong host").into_response();
    }
    next.run(req).await
}

// ─── The listener ────────────────────────────────────────────────────────────

static SERVER: tokio::sync::Mutex<Option<(u16, crate::api::ApiHandle)>> =
    tokio::sync::Mutex::const_new(None);

/// Bring the loopback listener up if it is not already, and return its port.
pub async fn ensure_server(app: &AppHandle) -> crate::error::AppResult<u16> {
    let mut server = SERVER.lock().await;
    if let Some((port, _)) = server.as_ref() {
        return Ok(*port);
    }
    let st = app.state::<AppState>();
    let handle = crate::api::start_local(
        app.clone(),
        st.db.clone(),
        st.http.clone(),
        st.active_streams.clone(),
        st.tool_approvals.clone(),
        PREFERRED_PORT,
    )
    .await?;
    let port = handle.port;
    *server = Some((port, handle));
    Ok(port)
}

/// The sign-in URL for a new tab: the UI's address with a fresh one-time code.
///
/// In a dev build the UI is Vite's, on its own origin, so the API's address
/// rides along; a release build serves both from the one socket and the page
/// ignores any address it is handed.
pub async fn login_url(app: &AppHandle) -> crate::error::AppResult<String> {
    let port = ensure_server(app).await?;
    let code = with_logins(|l| l.mint(Instant::now()));
    let api = format!("http://127.0.0.1:{port}");
    let dev = app.config().build.dev_url.clone().filter(|_| tauri::is_dev());
    Ok(match dev {
        Some(url) => format!("{}#mzlogin={code}&api={api}", url.as_str().trim_end_matches('/')),
        None => format!("{api}/#mzlogin={code}"),
    })
}

/// Open the default browser on a fresh session.
pub fn open_in_browser(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match login_url(&app).await {
            Ok(url) => {
                if let Err(e) = opener::open_browser(&url) {
                    tracing::warn!("could not open the browser: {e}");
                }
            }
            Err(e) => tracing::error!("browser mode: the loopback listener did not start: {e}"),
        }
    });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginBody {
    code: String,
}

/// Unauthenticated, like pairing, and for the same reason: it is how a caller
/// with no token gets one. A code is 256 bits, single-use and two minutes old
/// at most, so there is nothing to guess.
pub async fn login(Json(body): Json<LoginBody>) -> Response {
    match with_logins(|l| l.redeem(body.code.trim(), Instant::now())) {
        Some(token) => Json(json!({ "token": token })).into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "this sign-in link has expired or was already used — open MultiZone again" })),
        )
            .into_response(),
    }
}

/// The UI itself, from the assets compiled into the binary. The resolver falls
/// back to `index.html` for any path it does not know, which is what a
/// single-page app wants on a reload.
pub async fn asset(State(st): State<ApiState>, uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "no such route" }))).into_response();
    }
    // Spelled out for a dev build, whose resolver reads `dist/` file by file
    // with no index fallback.
    let path = if uri.path() == "/" { "/index.html" } else { uri.path() };
    match st.app.asset_resolver().get(path.to_string()) {
        Some(a) => {
            let mut res = (
                [(header::CONTENT_TYPE, a.mime_type), (header::CACHE_CONTROL, "no-cache".into())],
                a.bytes,
            )
                .into_response();
            if let Some(csp) = a.csp_header.and_then(|c| c.parse().ok()) {
                res.headers_mut().insert(header::CONTENT_SECURITY_POLICY, csp);
            }
            res
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[derive(Deserialize)]
pub struct InvokeBody {
    command: String,
    #[serde(default)]
    args: Value,
}

fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, ApiError> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| ApiError(AppError::Invalid(format!("'{key}': {e}"))))
}

async fn refuse_locked(st: &ApiState, chat_id: &str) -> Result<(), ApiError> {
    match crate::chat_lock::lock_root(&st.db, chat_id).await {
        Ok(None) => Ok(()),
        // This tab's own unlock, from the request's scope (`chat_lock_mw`).
        Ok(Some(root)) if crate::chat_lock::is_unlocked(&root) => Ok(()),
        Ok(Some(_)) => Err(ApiError(AppError::Invalid(crate::chat_lock::LOCKED_MESSAGE.into()))),
        Err(e) => Err(ApiError(e.into())),
    }
}

/// The GUI-only commands a browser on this machine may use.
///
/// Each is GUI-only because a *remote* caller cannot see or use the result — a
/// dialog or an Explorer window opens on a screen it is not looking at — not
/// because the user should not have it. The person at this tab is at that
/// screen. Not on the list, deliberately: changing chat locks or passwords
/// (a tab unlocks a chat for itself over the ordinary route, as a phone does),
/// the API's own settings and token, the database reset, and the desktop's
/// microphone (a tab records in the browser, as a phone does).
///
/// Reached only on the loopback listener (the route is not mounted anywhere
/// else, so neither `app_control` nor a paired phone can call it), and only
/// with a browser session. The frontend's copy of the list is `LOCAL_OK` in
/// `src/lib/remote/transport.ts`; this match is the gate.
pub async fn invoke(
    State(st): State<ApiState>,
    caller: Option<Extension<DeviceAuth>>,
    Json(body): Json<InvokeBody>,
) -> ApiResult<Response> {
    if !matches!(caller.as_deref(), Some(DeviceAuth::LocalBrowser(_))) {
        return Ok((StatusCode::FORBIDDEN, Json(json!({ "error": "browser sessions only" })))
            .into_response());
    }
    use crate::commands::{attachments, files, layout, projects};
    let a = &body.args;
    let state = || st.app.state::<AppState>();
    let value = match body.command.as_str() {
        "dialog_open" => dialog(&st.app, a.clone(), false).await?,
        "dialog_save" => dialog(&st.app, a.clone(), true).await?,
        "open_path" => files::open_path(arg(a, "path")?).await.map(|_| Value::Null)?,
        "reveal_path" => files::reveal_path(arg(a, "path")?).await.map(|_| Value::Null)?,
        "read_output_file" => json!(files::read_output_file(arg(a, "path")?).await?),
        "report_layout" => layout::report_layout(arg(a, "layout")?).await.map(|_| Value::Null)?,
        "write_export_file" => {
            attachments::write_export_file(arg(a, "path")?, arg(a, "contents")?).await?;
            Value::Null
        }
        "save_pdf_attachment" => {
            let chat_id: String = arg(a, "chatId")?;
            refuse_locked(&st, &chat_id).await?;
            json!(attachments::save_pdf_attachment(state(), chat_id, arg(a, "fileName")?, arg(a, "pagesB64")?).await?)
        }
        "upload_attachment" => {
            let chat_id: String = arg(a, "chatId")?;
            refuse_locked(&st, &chat_id).await?;
            json!(attachments::upload_attachment(state(), chat_id, arg(a, "filePath")?).await?)
        }
        "get_attachment_images" => {
            json!(attachments::get_attachment_images(state(), arg(a, "attachmentId")?).await?)
        }
        "add_project_sources" => json!(
            projects::add_project_sources(st.app.clone(), state(), arg(a, "projectId")?, arg(a, "paths")?)
                .await?
        ),
        other => {
            return Ok((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": format!("\"{other}\" is not available in the browser — open the app window from the tray") })),
            )
                .into_response())
        }
    };
    Ok(Json(json!({ "value": value })).into_response())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DialogOptions {
    title: Option<String>,
    filters: Vec<DialogFilter>,
    multiple: bool,
    directory: bool,
    default_path: Option<String>,
}

#[derive(Deserialize)]
struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// The plugin's `open`/`save`, run on the desktop. Same answers as the plugin
/// gives the window: a path, a list of paths, or null for a cancel.
async fn dialog(app: &AppHandle, options: Value, save: bool) -> Result<Value, ApiError> {
    use tauri_plugin_dialog::DialogExt;
    let o: DialogOptions = serde_json::from_value(options)
        .map_err(|e| ApiError(AppError::Invalid(format!("dialog options: {e}"))))?;
    let mut b = app.dialog().file();
    if let Some(t) = o.title {
        b = b.set_title(t);
    }
    for f in &o.filters {
        let ext: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        b = b.add_filter(&f.name, &ext);
    }
    if let Some(p) = o.default_path.map(std::path::PathBuf::from) {
        if p.is_dir() {
            b = b.set_directory(&p);
        } else {
            if let Some(dir) = p.parent().filter(|d| d.is_dir()) {
                b = b.set_directory(dir);
            }
            if let Some(name) = p.file_name() {
                b = b.set_file_name(name.to_string_lossy());
            }
        }
    }
    let one = |p: Option<tauri_plugin_dialog::FilePath>| p.map(|p| json!(p.to_string())).unwrap_or(Value::Null);
    let many = |p: Option<Vec<tauri_plugin_dialog::FilePath>>| {
        p.map(|v| json!(v.iter().map(|p| p.to_string()).collect::<Vec<_>>())).unwrap_or(Value::Null)
    };
    // The blocking calls wait for the person; off the async workers.
    tokio::task::spawn_blocking(move || match (save, o.directory, o.multiple) {
        (true, _, _) => one(b.blocking_save_file()),
        (false, true, true) => many(b.blocking_pick_folders()),
        (false, true, false) => one(b.blocking_pick_folder()),
        (false, false, true) => many(b.blocking_pick_files()),
        (false, false, false) => one(b.blocking_pick_file()),
    })
    .await
    .map_err(|e| ApiError(AppError::Other(format!("dialog: {e}"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_works_once_and_only_while_fresh() {
        let mut l = Logins::default();
        let t0 = Instant::now();
        let code = l.mint(t0);
        let token = l.redeem(&code, t0 + Duration::from_secs(5)).expect("fresh code redeems");
        assert!(l.sessions.contains(&token));
        assert!(l.redeem(&code, t0 + Duration::from_secs(6)).is_none(), "single use");

        let stale = l.mint(t0);
        assert!(l.redeem(&stale, t0 + CODE_TTL).is_none(), "expired");
        assert!(l.redeem(&stale, t0).is_none(), "an expired try still burns it");
        assert!(l.redeem("made-up", t0).is_none());
    }

    #[test]
    fn minting_sweeps_expired_codes() {
        let mut l = Logins::default();
        let t0 = Instant::now();
        l.mint(t0);
        l.mint(t0 + CODE_TTL + Duration::from_secs(1));
        assert_eq!(l.codes.len(), 1);
    }

    #[test]
    fn only_our_own_host_name_is_accepted() {
        assert!(host_allowed(Some("127.0.0.1:8766"), 8766));
        assert!(host_allowed(Some("LOCALHOST:8766"), 8766));
        for bad in [
            Some("evil.example:8766"), // DNS rebinding
            Some("127.0.0.1:8765"),
            Some("127.0.0.1"),
            Some("192.168.1.5:8766"),
            Some("localhost.evil.example:8766"),
            None,
        ] {
            assert!(!host_allowed(bad, 8766), "{bad:?}");
        }
    }
}
