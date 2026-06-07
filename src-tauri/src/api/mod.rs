//! Embedded HTTP API server. Exposes the same capabilities as the GUI
//! (list/create chats, pick zones/projects, send messages and stream the
//! response, manage perspective zones) over a local REST + SSE interface so an
//! external CLI or script can drive the app.
//!
//! Bound to `127.0.0.1` only and gated behind a bearer token. Started/stopped
//! from the Settings UI via the `apply_api_settings` command.

use crate::commands::messages::{
    run_regenerate_entry, run_send_entry, EngineCtx, InputPart, StreamSink,
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

const CHAT_COLS: &str =
    "id, title, zone_id, project_id, project_context_enabled, created_at, updated_at";
const MSG_COLS: &str =
    "id, chat_id, role, content, tool_calls, tool_call_id, reasoning, zone_id, created_at";

/// Cheap-to-clone state shared by every request handler.
#[derive(Clone)]
struct ApiState {
    db: SqlitePool,
    http: reqwest::Client,
    active_streams: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    app: AppHandle,
    token: String,
}

impl ApiState {
    fn engine(&self) -> EngineCtx {
        EngineCtx {
            db: self.db.clone(),
            http: self.http.clone(),
            active_streams: self.active_streams.clone(),
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
    port: u16,
    token: String,
) -> crate::error::AppResult<ApiHandle> {
    let state = ApiState { db, http, active_streams, app, token };
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

fn build_router(state: ApiState) -> Router {
    use tower_http::cors::CorsLayer;

    let protected = Router::new()
        .route("/api/zones", get(list_zones))
        .route("/api/projects", get(list_projects))
        .route("/api/tags", get(list_tags))
        .route("/api/chats", get(list_chats).post(create_chat))
        .route("/api/chats/:id/messages", get(get_messages).post(send_message))
        .route("/api/chats/:id/zone", post(set_chat_zone))
        .route("/api/chats/:id/regenerate", post(regenerate))
        .route("/api/chats/:id/cancel", post(cancel))
        .route(
            "/api/chats/:id/perspectives",
            get(list_perspectives).post(add_perspective).delete(remove_perspective),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), auth_mw));

    Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .layer(CorsLayer::permissive())
        .with_state(state)
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

struct ApiError(AppError);

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

type ApiResult<T> = Result<T, ApiError>;

// ─── Read endpoints ───────────────────────────────────────────────────────────

async fn health() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "name": "MultiZone",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

const ZONE_COLS: &str = "id, name, provider_id, model, system_prompt, temperature, max_tokens, top_p,
    tools_enabled, tool_config, thinking_enabled, include_thinking_in_context,
    icon, accent_color, created_at, updated_at";

async fn list_zones(State(st): State<ApiState>) -> ApiResult<Json<Vec<Zone>>> {
    let rows = sqlx::query_as::<_, Zone>(&format!("SELECT {ZONE_COLS} FROM zones ORDER BY name"))
        .fetch_all(&st.db)
        .await
        .map_err(AppError::from)?;
    Ok(Json(rows))
}

async fn list_projects(State(st): State<ApiState>) -> ApiResult<Json<Vec<Project>>> {
    let rows = sqlx::query_as::<_, Project>(
        "SELECT id, name, icon, accent_color, default_zone_id, context_snippet, directory, default_context_enabled, created_at, updated_at
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
struct SendBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    parts: Option<Vec<InputPart>>,
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
    let parts = resolve_parts(body)?;
    let ctx = st.engine();

    if q.wait {
        // Blocking: run to completion, then return the turn's new primary messages.
        let start = now_ts();
        let sink = StreamSink::tauri(st.app.clone());
        run_send_entry(&ctx, &sink, &chat_id, parts).await?;
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
        let _ = run_send_entry(&ctx, &sink, &chat_id, parts).await;
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
