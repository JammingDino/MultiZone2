//! Embedded HTTP API server. Exposes the same capabilities as the GUI
//! (list/create chats, pick zones/projects, send messages and stream the
//! response, manage perspective zones) over a local REST + SSE interface so an
//! external CLI or script can drive the app.
//!
//! Bound to `127.0.0.1` only and gated behind a bearer token. Started/stopped
//! from the Settings UI via the `apply_api_settings` command.

use crate::commands::messages::{
    run_regenerate_entry, run_send_entry, EngineCtx, InputPart, StreamSink, TurnOverride,
};
use crate::commands::{new_id, now_ts};
use crate::db::models::{Chat, ChatZone, Message, Project, Tag, Zone};
use crate::error::AppError;

use axum::{
    extract::{Path, Query, State},
    http::{header::AUTHORIZATION, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, RwLock};
use tokio_stream::wrappers::UnboundedReceiverStream;

pub mod routes;

use crate::commands::chats::CHAT_COLS;
const MSG_COLS: &str =
    "id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, active_zone_id, edited, created_at";

/// Cheap-to-clone state shared by every request handler.
#[derive(Clone)]
pub(crate) struct ApiState {
    pub(crate) db: SqlitePool,
    pub(crate) http: reqwest::Client,
    pub(crate) active_streams: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    pub(crate) tool_approvals: Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<crate::commands::messages::ApprovalAnswer>>>>,
    pub(crate) app: AppHandle,
    pub(crate) token: String,
}

impl ApiState {
    fn engine(&self) -> EngineCtx {
        EngineCtx {
            db: self.db.clone(),
            http: self.http.clone(),
            active_streams: self.active_streams.clone(),
            tool_approvals: self.tool_approvals.clone(),
        }
    }
}

/// Handle to a running server; dropping or calling `stop` shuts it down.
pub struct ApiHandle {
    #[allow(dead_code)]
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

impl ApiHandle {
    pub fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// Bind to `127.0.0.1:port` and spawn the server. Returns once the socket is
/// bound so the caller learns of bind errors (e.g. port in use) synchronously.
pub async fn start(
    app: AppHandle,
    db: SqlitePool,
    http: reqwest::Client,
    active_streams: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    tool_approvals: Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<crate::commands::messages::ApprovalAnswer>>>>,
    port: u16,
    token: String,
) -> crate::error::AppResult<ApiHandle> {
    let state = ApiState { db, http, active_streams, tool_approvals, app, token };
    let router = build_router(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = server.await {
            tracing::error!("api server error: {e}");
        }
    });

    tracing::info!("API server listening on http://{addr}");
    Ok(ApiHandle { port, shutdown: Some(shutdown_tx) })
}

/// Call the API from inside the process, without a socket.
///
/// This is how the `app_control` tool reaches the app (0.11.0). It could have
/// called the Tauri commands directly, or spoken HTTP to `127.0.0.1` — the
/// first would have grown a third copy of the surface to keep in step with the
/// route table, and the second would have made a model's ability to change a
/// setting depend on whether the user had switched on a *remote* access server
/// and on a port being free. Serving the request through the same [`Router`]
/// means the tool cannot do anything the API cannot, and cannot fall behind it.
///
/// Auth is satisfied with a token minted for this one call: the bearer token
/// exists to keep strangers off the socket, and there is no socket here.
pub(crate) async fn call_in_process(
    app: AppHandle,
    ctx: &EngineCtx,
    method: &str,
    path_and_query: &str,
    body: Option<serde_json::Value>,
) -> crate::error::AppResult<(u16, String)> {
    use tower::ServiceExt;

    let token = new_id();
    let state = ApiState {
        db: ctx.db.clone(),
        http: ctx.http.clone(),
        active_streams: ctx.active_streams.clone(),
        tool_approvals: ctx.tool_approvals.clone(),
        app,
        token: token.clone(),
    };

    let method = axum::http::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| AppError::Invalid(format!("'{method}' is not an HTTP method")))?;
    let request = axum::http::Request::builder()
        .method(method)
        .uri(path_and_query)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(
            body.unwrap_or(serde_json::Value::Object(Default::default())).to_string(),
        ))
        .map_err(|e| AppError::Invalid(format!("could not build the request: {e}")))?;

    let response = build_router(state)
        .oneshot(request)
        .await
        .map_err(|e| AppError::Other(format!("api call failed: {e}")))?;
    let status = response.status().as_u16();

    // Bounded, because a tool result is context the model pays for: a caller
    // that asks for every message in every chat gets told to narrow it rather
    // than filling the window with the answer.
    const MAX_BODY: usize = 96 * 1024;
    let bytes = axum::body::to_bytes(response.into_body(), MAX_BODY)
        .await
        .map_err(|_| {
            AppError::Invalid(format!(
                "the response is larger than {MAX_BODY} bytes — ask for a narrower slice"
            ))
        })?;
    Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
}

fn build_router(state: ApiState) -> Router {
    use tower_http::cors::CorsLayer;
    use routes as h;

    let protected = Router::new()
        // Providers, zones, library
        .route("/api/providers", get(h::list_providers).post(h::upsert_provider))
        .route("/api/providers/:id", axum::routing::delete(h::delete_provider))
        .route("/api/providers/:id/models", get(h::provider_models))
        .route("/api/zones", get(list_zones).post(h::upsert_zone))
        .route("/api/zones/:id", axum::routing::delete(h::delete_zone))
        .route("/api/zone-library", get(h::list_library).post(h::upsert_library))
        .route("/api/zone-library/:id", axum::routing::delete(h::delete_library))
        // Projects, tags
        .route("/api/projects", get(list_projects).post(h::upsert_project))
        .route("/api/projects/:id", axum::routing::delete(h::delete_project))
        .route("/api/tags", get(list_tags).post(h::upsert_tag))
        .route("/api/tags/:id", axum::routing::delete(h::delete_tag))
        .route("/api/chat-tags", get(h::all_chat_tags))
        // Chats
        .route("/api/chats", get(list_chats).post(create_chat))
        .route("/api/chats/:id", axum::routing::delete(h::delete_chat))
        .route("/api/chats/:id/messages", get(get_messages).post(send_message))
        .route("/api/chats/:id/messages/:messageId", axum::routing::patch(h::update_message))
        .route("/api/chats/:id/messages/from", axum::routing::delete(h::delete_messages_from))
        .route(
            "/api/chats/:id/participant-messages",
            axum::routing::delete(h::delete_participant_messages),
        )
        .route("/api/chats/:id/zone", post(set_chat_zone))
        .route("/api/chats/:id/smart", post(h::set_chat_smart))
        .route("/api/chats/:id/spend-limit", post(h::set_chat_spend_limit))
        .route("/api/chats/:id/plan-mode", post(h::set_chat_plan_mode))
        .route("/api/chats/:id/plans", get(h::list_plans))
        .route("/api/chats/:id/plans/pending", get(h::pending_plan))
        .route("/api/plans/:id/approve", post(h::approve_plan))
        .route("/api/plans/:id/reject", post(h::reject_plan))
        .route("/api/plans/:id/steps", post(h::update_plan_steps))
        .route("/api/plans/:id/stop", post(h::request_plan_stop))
        .route("/api/chats/:id/plan-tree", get(h::plan_tree))
        .route("/api/chats/:id/events", get(h::list_session_events))
        .route("/api/chats/:id/title", post(h::rename_chat))
        .route("/api/chats/:id/generate-title", post(h::generate_title))
        .route("/api/chats/:id/project", post(h::set_chat_project))
        .route("/api/chats/:id/project-context", post(h::set_chat_project_context))
        .route("/api/chats/:id/knowledge", post(h::set_chat_knowledge))
        .route("/api/chats/:id/tags", get(h::chat_tags).post(h::add_chat_tag))
        .route("/api/chats/:id/tags/:tagId", axum::routing::delete(h::remove_chat_tag))
        .route("/api/chats/:id/tags/:tagId/context", post(h::set_chat_tag_context))
        .route(
            "/api/chats/:id/perspectives",
            get(list_perspectives).post(add_perspective).delete(remove_perspective),
        )
        .route("/api/chats/:id/perspective-mode", post(h::set_perspective_mode))
        .route("/api/chats/:id/subagents", get(h::list_subagents).post(h::set_subagents))
        .route("/api/chats/:id/subchats", get(h::subchat_tree))
        .route("/api/chats/:id/branch", post(h::branch_chat))
        .route("/api/chats/:id/regenerate", post(regenerate))
        .route("/api/chats/:id/regenerate-participant", post(h::regenerate_participant))
        .route("/api/chats/:id/cancel", post(cancel))
        .route("/api/chats/:id/approval", post(h::respond_approval))
        .route("/api/chats/:id/queue", post(h::queue_message))
        .route("/api/chats/:id/queue/:messageId", axum::routing::delete(h::cancel_queued))
        .route("/api/chats/:id/fix-diagram", post(h::fix_diagram))
        .route("/api/chats/:id/usage", get(h::chat_usage))
        // Reversible work
        .route("/api/chats/:id/checkpoints", get(h::list_checkpoints))
        .route("/api/chats/:id/checkpoints/since/:messageId", get(h::checkpoints_since))
        .route("/api/chats/:id/restore-to/:messageId", post(h::restore_to_message))
        .route("/api/chats/:id/rewind-to/:messageId", post(h::rewind_to_message))
        .route("/api/chats/:id/rewind-forward", post(h::rewind_forward))
        .route("/api/chats/:id/rewind-status", get(h::rewind_status))
        .route("/api/checkpoints/:id/restore", post(h::restore_checkpoint))
        .route("/api/checkpoints/usage", get(h::checkpoint_usage))
        .route("/api/checkpoints/prune", post(h::prune_checkpoints))
        .route(
            "/api/chats/:id/staged-edits",
            get(h::list_staged).delete(h::discard_all_staged),
        )
        .route("/api/chats/:id/staged-edits/apply", post(h::apply_all_staged))
        .route("/api/staged-edits/:id/apply", post(h::apply_staged))
        .route("/api/staged-edits/:id", axum::routing::delete(h::discard_staged))
        // Skills, memory, MCP
        .route("/api/skills", get(h::list_skills).post(h::upsert_skill))
        .route("/api/skills/:id", axum::routing::delete(h::delete_skill))
        .route("/api/skills/:id/enabled", post(h::set_skill_enabled))
        .route("/api/skill-packs", get(h::list_skill_packs))
        .route("/api/skill-packs/root", get(h::skill_packs_root))
        .route("/api/memories", get(h::list_memories).post(h::upsert_memory))
        .route("/api/memories/:id", axum::routing::delete(h::delete_memory))
        .route("/api/mcp/servers", get(h::list_mcp_servers).post(h::upsert_mcp_server))
        .route("/api/mcp/servers/:id", axum::routing::delete(h::delete_mcp_server))
        .route("/api/mcp/servers/:id/connect", post(h::connect_mcp_server))
        .route("/api/mcp/servers/:id/disconnect", post(h::disconnect_mcp_server))
        .route("/api/mcp/tools/:toolId/danger", post(h::set_mcp_tool_danger))
        .route("/api/mcp/servers/:id/diagnose", get(h::diagnose_mcp_server))
        .route("/api/connectors", get(h::list_connectors))
        .route("/api/connectors/install", post(h::install_connector))
        .route("/api/connectors/import", post(h::import_connectors))
        .route("/api/connectors/:entryId", axum::routing::delete(h::delete_connector))
        // Knowledge
        .route("/api/knowledge", get(h::global_kb).delete(h::clear_global_kb))
        .route("/api/knowledge/config", post(h::set_global_kb_config))
        .route("/api/knowledge/index", post(h::index_global_kb))
        .route("/api/knowledge/documents", get(h::global_kb_documents))
        .route(
            "/api/knowledge/documents/:documentId",
            axum::routing::delete(h::remove_kb_document),
        )
        .route(
            "/api/projects/:id/knowledge",
            get(h::project_kb_status).delete(h::clear_project_kb),
        )
        .route("/api/projects/:id/knowledge/config", post(h::set_project_kb_config))
        .route("/api/projects/:id/knowledge/index", post(h::index_project_kb))
        .route("/api/projects/:id/knowledge/default", post(h::set_project_kb_default))
        .route("/api/projects/:id/knowledge/documents", get(h::project_kb_documents))
        // Tools, usage, settings, storage
        .route("/api/tools", get(h::list_tools))
        .route("/api/tool-usage", get(h::tool_usage).delete(h::reset_tool_usage))
        .route("/api/usage", get(h::lifetime_usage))
        .route("/api/stats", get(h::db_stats))
        .route(
            "/api/settings/:key",
            get(h::get_setting).put(h::set_setting).patch(h::patch_setting),
        )
        .route("/api/theme", get(h::get_theme).patch(h::patch_theme))
        .route("/api/mirror", post(h::mirror_all))
        .route("/api/mirror/import", post(h::import_markdown))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth_mw));

    Router::new()
        // Both discovery routes are unauthenticated on purpose: a caller trying
        // to work out why nothing answers must not have to authenticate to find
        // out that its token is the thing that is wrong.
        .route("/api/health", get(health))
        .route("/api/routes", get(routes::routes))
        .merge(protected)
        .layer(middleware::from_fn_with_state(state.clone(), notify_gui_mw))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// Tell an open window that a request changed something.
///
/// A handful of routes already emitted their own targeted event and the rest
/// changed the database silently, which was survivable while the API's only
/// caller was a script driving a headless app. It stops being survivable once a
/// model can create a zone mid-conversation (`app_control`): the zone exists,
/// the sidebar does not show it, and the user is told about work they cannot
/// see. One event carrying the path, emitted for every write that succeeded,
/// leaves the window to decide what that path means for what it is displaying.
///
/// Writes only, successes only — a GET changes nothing, and a rejected write
/// changed nothing either.
async fn notify_gui_mw(
    State(st): State<ApiState>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let response = next.run(req).await;
    if method != axum::http::Method::GET && response.status().is_success() {
        let _ = st.app.emit(
            "app-data-changed",
            json!({ "method": method.as_str(), "path": path }),
        );
    }
    response
}

// ─── Auth ───────────────────────────────────────────────────────────────────

async fn auth_mw(
    State(st): State<ApiState>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let ok = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v == format!("Bearer {}", st.token))
        .unwrap_or(false);

    if ok {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response()
    }
}

// ─── Error mapping ────────────────────────────────────────────────────────────

pub(crate) struct ApiError(pub AppError);

impl From<AppError> for ApiError {
    fn from(e: AppError) -> Self {
        ApiError(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let code = match &self.0 {
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Invalid(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (code, Json(json!({ "error": self.0.to_string() }))).into_response()
    }
}

pub(crate) type ApiResult<T> = Result<T, ApiError>;

// ─── Read endpoints ───────────────────────────────────────────────────────────

/// What the API can honestly say about itself (0.11.0).
///
/// The old answer was `{status: "ok"}`, which proves a socket and nothing else
/// — and only in the case where you didn't need to ask. These are five separate
/// questions with five separate answers, and a caller that cannot reach the app
/// needs to know *which one* is false:
///
/// - `enabled` — the user has switched the API on in Settings.
/// - `bound` — the socket actually bound. A port already in use used to leave
///   the toggle reading "on" with no server behind it.
/// - `answering` — trivially true here; if you are reading this, it answered.
/// - `tokenPresent` — a token is configured at all.
/// - `tokenAccepted` — *your* token is the right one. Reported without
///   requiring auth, because "is my token wrong" is exactly the question you
///   cannot ask through a door your token has to open.
async fn health(State(st): State<ApiState>, req: axum::extract::Request) -> impl IntoResponse {
    let token_accepted = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v == format!("Bearer {}", st.token))
        .unwrap_or(false);

    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(&st.db)
            .await
            .ok()
            .flatten();
    let settings: serde_json::Value = raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    let enabled = settings.get("apiEnabled").and_then(|b| b.as_bool()).unwrap_or(false);

    let bind = crate::commands::api::read_bind_state(&st.db).await;

    Json(json!({
        "status": "ok",
        "name": "MultiZone",
        "version": env!("CARGO_PKG_VERSION"),
        "routeSetVersion": routes::ROUTE_SET_VERSION,
        "enabled": enabled,
        "bound": bind.as_ref().map(|b| b.ok).unwrap_or(true),
        "bindError": bind.as_ref().and_then(|b| b.error.clone()),
        "port": bind.as_ref().map(|b| b.port),
        "answering": true,
        "tokenPresent": !st.token.trim().is_empty(),
        "tokenAccepted": token_accepted,
    }))
}

use crate::db::models::ZONE_COLS;

async fn list_zones(State(st): State<ApiState>) -> ApiResult<Json<Vec<Zone>>> {
    let rows = sqlx::query_as::<_, Zone>(&format!("SELECT {ZONE_COLS} FROM zones ORDER BY name"))
        .fetch_all(&st.db)
        .await
        .map_err(AppError::from)?;
    Ok(Json(rows))
}

async fn list_projects(State(st): State<ApiState>) -> ApiResult<Json<Vec<Project>>> {
    let rows = sqlx::query_as::<_, Project>(
        "SELECT id, name, icon, accent_color, default_zone_id, context_snippet, directory, default_context_enabled, kb_provider_id, kb_embedding_model, kb_dimensions, kb_indexed_at, created_at, updated_at
         FROM projects ORDER BY name",
    )
    .fetch_all(&st.db)
    .await
    .map_err(AppError::from)?;
    Ok(Json(rows))
}

async fn list_tags(State(st): State<ApiState>) -> ApiResult<Json<Vec<Tag>>> {
    let rows = sqlx::query_as::<_, Tag>(
        "SELECT id, name, color, context_snippet, created_at, updated_at FROM tags ORDER BY name",
    )
    .fetch_all(&st.db)
    .await
    .map_err(AppError::from)?;
    Ok(Json(rows))
}

async fn list_chats(State(st): State<ApiState>) -> ApiResult<Json<Vec<Chat>>> {
    let rows = sqlx::query_as::<_, Chat>(&format!(
        "SELECT {CHAT_COLS} FROM chats ORDER BY updated_at DESC"
    ))
    .fetch_all(&st.db)
    .await
    .map_err(AppError::from)?;
    Ok(Json(rows))
}

async fn get_messages(
    State(st): State<ApiState>,
    Path(chat_id): Path<String>,
) -> ApiResult<Json<Vec<Message>>> {
    let rows = sqlx::query_as::<_, Message>(&format!(
        "SELECT {MSG_COLS} FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC"
    ))
    .bind(&chat_id)
    .fetch_all(&st.db)
    .await
    .map_err(AppError::from)?;
    Ok(Json(rows))
}

async fn list_perspectives(
    State(st): State<ApiState>,
    Path(chat_id): Path<String>,
) -> ApiResult<Json<Vec<ChatZone>>> {
    let rows = sqlx::query_as::<_, ChatZone>(
        "SELECT chat_id, zone_id FROM chat_zones WHERE chat_id = ?1",
    )
    .bind(&chat_id)
    .fetch_all(&st.db)
    .await
    .map_err(AppError::from)?;
    Ok(Json(rows))
}

// ─── Mutating endpoints ───────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChatBody {
    #[serde(default)]
    zone_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
}

async fn create_chat(
    State(st): State<ApiState>,
    Json(body): Json<CreateChatBody>,
) -> ApiResult<Json<Chat>> {
    let id = new_id();
    let now = now_ts();

    // Mirror the GUI's create_chat: inherit default zone + context from project.
    let (effective_zone_id, project_context_enabled) = match &body.project_id {
        Some(pid) => {
            let row: Option<(Option<String>, bool)> = sqlx::query_as(
                "SELECT default_zone_id, default_context_enabled FROM projects WHERE id = ?1",
            )
            .bind(pid)
            .fetch_optional(&st.db)
            .await
            .map_err(AppError::from)?;
            let (proj_zone, proj_ctx) = row.unwrap_or((None, false));
            (body.zone_id.clone().or(proj_zone), proj_ctx)
        }
        None => (body.zone_id.clone(), false),
    };

    sqlx::query(
        "INSERT INTO chats (id, title, zone_id, project_id, project_context_enabled, created_at, updated_at)
         VALUES (?1, 'New Chat', ?2, ?3, ?4, ?5, ?5)",
    )
    .bind(&id)
    .bind(&effective_zone_id)
    .bind(&body.project_id)
    .bind(project_context_enabled)
    .bind(now)
    .execute(&st.db)
    .await
    .map_err(AppError::from)?;

    let chat = sqlx::query_as::<_, Chat>(&format!("SELECT {CHAT_COLS} FROM chats WHERE id = ?1"))
        .bind(&id)
        .fetch_one(&st.db)
        .await
        .map_err(AppError::from)?;
    Ok(Json(chat))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZoneBody {
    zone_id: String,
}

async fn set_chat_zone(
    State(st): State<ApiState>,
    Path(chat_id): Path<String>,
    Json(body): Json<ZoneBody>,
) -> ApiResult<StatusCode> {
    sqlx::query("UPDATE chats SET zone_id = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(&body.zone_id)
        .bind(now_ts())
        .bind(&chat_id)
        .execute(&st.db)
        .await
        .map_err(AppError::from)?;
    // Keep an open GUI in sync.
    let _ = st.app.emit("chat-zone-updated", json!({ "chatId": chat_id, "zoneId": body.zone_id }));
    Ok(StatusCode::NO_CONTENT)
}

async fn add_perspective(
    State(st): State<ApiState>,
    Path(chat_id): Path<String>,
    Json(body): Json<ZoneBody>,
) -> ApiResult<StatusCode> {
    sqlx::query("INSERT OR IGNORE INTO chat_zones (chat_id, zone_id) VALUES (?1, ?2)")
        .bind(&chat_id)
        .bind(&body.zone_id)
        .execute(&st.db)
        .await
        .map_err(AppError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_perspective(
    State(st): State<ApiState>,
    Path(chat_id): Path<String>,
    Json(body): Json<ZoneBody>,
) -> ApiResult<StatusCode> {
    sqlx::query("DELETE FROM chat_zones WHERE chat_id = ?1 AND zone_id = ?2")
        .bind(&chat_id)
        .bind(&body.zone_id)
        .execute(&st.db)
        .await
        .map_err(AppError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cancel(State(st): State<ApiState>, Path(chat_id): Path<String>) -> StatusCode {
    let map = st.active_streams.read().await;
    if let Some(flag) = map.get(&chat_id) {
        flag.store(true, Ordering::Relaxed);
    }
    StatusCode::NO_CONTENT
}

// ─── Sending messages (SSE or blocking) ───────────────────────────────────────

#[derive(Deserialize)]
struct SendQuery {
    #[serde(default)]
    wait: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    parts: Option<Vec<InputPart>>,
    /// When set, the message is sent on behalf of a zone (a subchat turn) rather
    /// than the user. On first use this marks the chat as a subchat owned by the
    /// zone (`initiated_by_zone_id`). Used by orchestration over the API.
    #[serde(default)]
    sender_zone_id: Option<String>,
}

fn resolve_parts(body: SendBody) -> Result<Vec<InputPart>, ApiError> {
    if let Some(parts) = body.parts {
        if !parts.is_empty() {
            return Ok(parts);
        }
    }
    if let Some(text) = body.text {
        if !text.trim().is_empty() {
            return Ok(vec![InputPart::Text { text }]);
        }
    }
    Err(ApiError(AppError::Invalid(
        "request must include 'text' or non-empty 'parts'".into(),
    )))
}

async fn send_message(
    State(st): State<ApiState>,
    Path(chat_id): Path<String>,
    Query(q): Query<SendQuery>,
    Json(body): Json<SendBody>,
) -> ApiResult<Response> {
    let sender_zone_id = body.sender_zone_id.clone();
    let parts = resolve_parts(body)?;
    let ctx = st.engine();

    // A message sent on behalf of a zone marks the chat as that zone's subchat
    // (on first use). The turn itself runs normally — the prompt is persisted as
    // a user-role message and attribution is read at the chat level.
    if let Some(zone_id) = sender_zone_id {
        let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM zones WHERE id = ?1")
            .bind(&zone_id)
            .fetch_optional(&st.db)
            .await
            .map_err(AppError::from)?;
        if exists.is_none() {
            return Err(ApiError(AppError::NotFound(format!("zone {zone_id}"))));
        }
        sqlx::query(
            "UPDATE chats SET initiated_by_zone_id = ?1, updated_at = ?2
             WHERE id = ?3 AND initiated_by_zone_id IS NULL",
        )
        .bind(&zone_id)
        .bind(now_ts())
        .bind(&chat_id)
        .execute(&st.db)
        .await
        .map_err(AppError::from)?;
    }

    if q.wait {
        // Blocking: run to completion, then return the turn's new primary messages.
        let start = now_ts();
        let sink = StreamSink::tauri(st.app.clone());
        run_send_entry(&ctx, &sink, &chat_id, parts, TurnOverride::default()).await?;
        let rows = sqlx::query_as::<_, Message>(&format!(
            "SELECT {MSG_COLS} FROM messages
             WHERE chat_id = ?1 AND zone_id IS NULL AND created_at >= ?2
             ORDER BY created_at ASC"
        ))
        .bind(&chat_id)
        .bind(start)
        .fetch_all(&st.db)
        .await
        .map_err(AppError::from)?;
        return Ok(Json(json!({ "messages": rows })).into_response());
    }

    // Streaming: feed the same event envelopes the GUI gets over SSE.
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let sink = StreamSink::api(st.app.clone(), tx);
    tokio::spawn(async move {
        // Dropping `sink` (and thus the sender) when this finishes ends the SSE.
        let _ = run_send_entry(&ctx, &sink, &chat_id, parts, TurnOverride::default()).await;
    });

    let stream = UnboundedReceiverStream::new(rx)
        .map(|line| Ok::<Event, Infallible>(Event::default().data(line)));
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response())
}

async fn regenerate(
    State(st): State<ApiState>,
    Path(chat_id): Path<String>,
    Query(q): Query<SendQuery>,
) -> ApiResult<Response> {
    let ctx = st.engine();

    if q.wait {
        let start = now_ts();
        let sink = StreamSink::tauri(st.app.clone());
        run_regenerate_entry(&ctx, &sink, &chat_id).await?;
        let rows = sqlx::query_as::<_, Message>(&format!(
            "SELECT {MSG_COLS} FROM messages
             WHERE chat_id = ?1 AND zone_id IS NULL AND created_at >= ?2
             ORDER BY created_at ASC"
        ))
        .bind(&chat_id)
        .bind(start)
        .fetch_all(&st.db)
        .await
        .map_err(AppError::from)?;
        return Ok(Json(json!({ "messages": rows })).into_response());
    }

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let sink = StreamSink::api(st.app.clone(), tx);
    tokio::spawn(async move {
        let _ = run_regenerate_entry(&ctx, &sink, &chat_id).await;
    });

    let stream = UnboundedReceiverStream::new(rx)
        .map(|line| Ok::<Event, Infallible>(Event::default().data(line)));
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response())
}
