//! Tauri commands for the Settings → MCP section: server CRUD, connecting (which
//! fetches + persists the tool list), per-tool danger levels, and live status.

use crate::commands::{new_id, now_ts};
use crate::db::models::{McpServer, McpTool};
use crate::error::{AppError, AppResult};
use crate::mcp::{self, ServerStatus, SERVER_COLS, TOOL_COLS};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// A server plus its persisted tools and current connection status — the shape
/// the Settings UI renders.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerView {
    #[serde(flatten)]
    pub server: McpServer,
    pub tools: Vec<McpTool>,
    pub status: ServerStatus,
}

#[tauri::command]
pub async fn list_mcp_servers(state: State<'_, AppState>) -> AppResult<Vec<McpServerView>> {
    let servers = sqlx::query_as::<_, McpServer>(&format!(
        "SELECT {SERVER_COLS} FROM mcp_servers ORDER BY name"
    ))
    .fetch_all(&state.db)
    .await?;

    let mut views = Vec::with_capacity(servers.len());
    for server in servers {
        let tools = sqlx::query_as::<_, McpTool>(&format!(
            "SELECT {TOOL_COLS} FROM mcp_tools WHERE server_id = ?1 ORDER BY name"
        ))
        .bind(&server.id)
        .fetch_all(&state.db)
        .await?;
        let status = mcp::manager().status(&server.id).await;
        views.push(McpServerView { server, tools, status });
    }
    Ok(views)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    pub id: Option<String>,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub url: Option<String>,
    pub env: Option<String>,
    /// JSON object of HTTP headers for the sse/http transport — where an
    /// `Authorization` header for a hosted server goes (0.11.2).
    pub headers: Option<String>,
    /// The catalog entry this came from, when it was installed rather than typed.
    pub catalog_id: Option<String>,
    pub enabled: Option<bool>,
}

#[tauri::command]
pub async fn upsert_mcp_server(
    state: State<'_, AppState>,
    server: McpServerInput,
) -> AppResult<McpServer> {
    let id = server.id.unwrap_or_else(new_id);
    let now = now_ts();
    let enabled = server.enabled.unwrap_or(true);
    sqlx::query(
        "INSERT INTO mcp_servers (id, name, transport, command, url, env, headers, catalog_id, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           transport = excluded.transport,
           command = excluded.command,
           url = excluded.url,
           env = excluded.env,
           headers = excluded.headers,
           catalog_id = COALESCE(excluded.catalog_id, mcp_servers.catalog_id),
           enabled = excluded.enabled,
           updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(&server.name)
    .bind(&server.transport)
    .bind(&server.command)
    .bind(&server.url)
    .bind(&server.env)
    .bind(&server.headers)
    .bind(&server.catalog_id)
    .bind(enabled)
    .bind(now)
    .execute(&state.db)
    .await?;

    // Connection settings may have changed — drop any stale live connection so
    // the next connect/call re-handshakes with the new config.
    mcp::manager().disconnect(&id).await;

    let row = sqlx::query_as::<_, McpServer>(&format!(
        "SELECT {SERVER_COLS} FROM mcp_servers WHERE id = ?1"
    ))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn delete_mcp_server(state: State<'_, AppState>, id: String) -> AppResult<()> {
    mcp::manager().disconnect(&id).await;
    // mcp_tools cascade-delete via the FK.
    sqlx::query("DELETE FROM mcp_servers WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Connect to a server, fetch its tool list, and reconcile the persisted
/// `mcp_tools` rows: new tools are inserted (default danger = moderate), removed
/// tools are deleted, and existing tools keep their user-assigned danger level
/// while refreshing description/schema. Returns the refreshed server view.
#[tauri::command]
pub async fn connect_mcp_server(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<McpServerView> {
    let server = sqlx::query_as::<_, McpServer>(&format!(
        "SELECT {SERVER_COLS} FROM mcp_servers WHERE id = ?1"
    ))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("MCP server {id}")))?;

    let discovered = mcp::manager().connect(&server).await?;
    let now = now_ts();

    let mut seen: Vec<String> = Vec::with_capacity(discovered.len());
    for tool in &discovered {
        seen.push(tool.name.clone());
        let schema = tool
            .input_schema
            .as_ref()
            .map(|s| s.to_string());
        sqlx::query(
            "INSERT INTO mcp_tools (id, server_id, name, description, input_schema, danger_level, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)
             ON CONFLICT(server_id, name) DO UPDATE SET
               description = excluded.description,
               input_schema = excluded.input_schema,
               updated_at = excluded.updated_at",
        )
        .bind(new_id())
        .bind(&server.id)
        .bind(&tool.name)
        .bind(&tool.description)
        .bind(&schema)
        .bind(now)
        .execute(&state.db)
        .await?;
    }

    // Prune tools the server no longer advertises.
    let existing = sqlx::query_as::<_, (String, String)>(
        "SELECT id, name FROM mcp_tools WHERE server_id = ?1",
    )
    .bind(&server.id)
    .fetch_all(&state.db)
    .await?;
    for (tool_id, name) in existing {
        if !seen.contains(&name) {
            sqlx::query("DELETE FROM mcp_tools WHERE id = ?1")
                .bind(&tool_id)
                .execute(&state.db)
                .await?;
        }
    }

    let tools = sqlx::query_as::<_, McpTool>(&format!(
        "SELECT {TOOL_COLS} FROM mcp_tools WHERE server_id = ?1 ORDER BY name"
    ))
    .bind(&server.id)
    .fetch_all(&state.db)
    .await?;
    let status = mcp::manager().status(&server.id).await;
    Ok(McpServerView { server, tools, status })
}

/// Disconnect a server's live connection (status → disconnected). Persisted tool
/// rows are kept.
#[tauri::command]
pub async fn disconnect_mcp_server(_state: State<'_, AppState>, id: String) -> AppResult<()> {
    mcp::manager().disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn set_mcp_tool_danger(
    state: State<'_, AppState>,
    tool_id: String,
    danger_level: i64,
) -> AppResult<()> {
    let level = danger_level.clamp(0, 2);
    sqlx::query("UPDATE mcp_tools SET danger_level = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(level)
        .bind(now_ts())
        .bind(&tool_id)
        .execute(&state.db)
        .await?;
    Ok(())
}
