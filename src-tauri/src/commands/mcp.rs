//! Tauri commands for the Settings → MCP section: server CRUD, connecting (which
//! fetches + persists the tool list), per-tool danger levels, and live status.
//!
//! Also the launch-time autostart ([`start_enabled`]), which brings every
//! enabled server up without anyone pressing Connect.

use crate::commands::{new_id, now_ts};
use crate::db::models::{McpServer, McpTool};
use crate::error::{AppError, AppResult};
use crate::mcp::{self, DiscoveredTool, ServerStatus, SERVER_COLS, TOOL_COLS};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager, State};

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
    sync_tools(&state.db, &server.id, &discovered).await?;

    let tools = sqlx::query_as::<_, McpTool>(&format!(
        "SELECT {TOOL_COLS} FROM mcp_tools WHERE server_id = ?1 ORDER BY name"
    ))
    .bind(&server.id)
    .fetch_all(&state.db)
    .await?;
    let status = mcp::manager().status(&server.id).await;
    Ok(McpServerView { server, tools, status })
}

/// Reconcile the persisted `mcp_tools` rows for a server against the tool list
/// it just advertised: insert new ones (default danger = moderate), refresh
/// description/schema on ones we already had — keeping the user's danger level,
/// which is the whole point of persisting them — and delete ones the server no
/// longer offers.
///
/// Shared by the Connect button and by [`start_enabled`] so an autostarted
/// server ends up with exactly the same rows a hand-connected one does.
async fn sync_tools(
    db: &SqlitePool,
    server_id: &str,
    discovered: &[DiscoveredTool],
) -> AppResult<()> {
    let now = now_ts();
    let mut seen: Vec<String> = Vec::with_capacity(discovered.len());
    for tool in discovered {
        seen.push(tool.name.clone());
        let schema = tool.input_schema.as_ref().map(|s| s.to_string());
        sqlx::query(
            "INSERT INTO mcp_tools (id, server_id, name, description, input_schema, danger_level, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)
             ON CONFLICT(server_id, name) DO UPDATE SET
               description = excluded.description,
               input_schema = excluded.input_schema,
               updated_at = excluded.updated_at",
        )
        .bind(new_id())
        .bind(server_id)
        .bind(&tool.name)
        .bind(&tool.description)
        .bind(&schema)
        .bind(now)
        .execute(db)
        .await?;
    }

    // Prune tools the server no longer advertises.
    let existing = sqlx::query_as::<_, (String, String)>(
        "SELECT id, name FROM mcp_tools WHERE server_id = ?1",
    )
    .bind(server_id)
    .fetch_all(db)
    .await?;
    for (tool_id, name) in existing {
        if !seen.contains(&name) {
            sqlx::query("DELETE FROM mcp_tools WHERE id = ?1")
                .bind(&tool_id)
                .execute(db)
                .await?;
        }
    }
    Ok(())
}

/// Disconnect a server's live connection (status → disconnected). Persisted tool
/// rows are kept.
#[tauri::command]
pub async fn disconnect_mcp_server(_state: State<'_, AppState>, id: String) -> AppResult<()> {
    mcp::manager().disconnect(&id).await;
    Ok(())
}

/// Emitted as each server settles during autostart, so Settings → MCP shows the
/// real state instead of the "Disconnected" every row started life with.
const MCP_STATUS_EVENT: &str = "mcp-status-changed";

/// Connect every enabled MCP server at launch (0.14.0).
///
/// Before this, a server sat at "Disconnected" until someone opened Settings and
/// pressed Connect, or until a tool call happened to need it — `Manager::call`
/// connects lazily, so the *capability* was never missing. What was missing was
/// everything around it: the first tool call of a session paid npx startup
/// inside the turn, a server that has been broken since the last launch
/// announced itself as a failed tool call rather than a red row in Settings, and
/// the panel could not be told about tools whose server had never been asked for
/// its list.
///
/// Each server connects in its own task: they are independent, one of them being
/// a hosted endpoint on the far side of a slow network should not hold up the
/// npx one, and none of it may sit in front of the first window paint. Failures
/// are logged and left as the server's error status — a server that cannot start
/// is a thing to see in Settings, not a dialog on launch.
pub async fn start_enabled(app: &AppHandle) {
    let (db, servers) = {
        let state = app.state::<AppState>();
        let db = state.db.clone();
        let servers = match sqlx::query_as::<_, McpServer>(&format!(
            "SELECT {SERVER_COLS} FROM mcp_servers WHERE enabled = 1 ORDER BY name"
        ))
        .fetch_all(&db)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("MCP autostart: could not read servers: {e}");
                return;
            }
        };
        (db, servers)
    };

    if servers.is_empty() {
        return;
    }
    tracing::info!("MCP autostart: connecting {} enabled server(s)", servers.len());

    for server in servers {
        let db = db.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let name = server.name.clone();
            match mcp::manager().connect(&server).await {
                Ok(discovered) => {
                    let count = discovered.len();
                    match sync_tools(&db, &server.id, &discovered).await {
                        Ok(()) => tracing::info!("MCP autostart: {name} connected, {count} tool(s)"),
                        // Connected but the rows did not land: the live connection
                        // is still good, so leave it up rather than tearing it
                        // down over a database write.
                        Err(e) => tracing::warn!(
                            "MCP autostart: {name} connected but its tool list could not be saved: {e}"
                        ),
                    }
                }
                Err(e) => tracing::warn!("MCP autostart: {name} failed to connect: {e}"),
            }
            let _ = app.emit(
                MCP_STATUS_EVENT,
                serde_json::json!({ "serverId": server.id }),
            );
        });
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// A database with the real schema and one enabled stdio server in it.
    async fn fixture() -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::MIGRATOR.run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO mcp_servers (id, name, transport, command, enabled, created_at, updated_at)
             VALUES ('s1', 'files', 'stdio', 'npx -y @scope/files', 1, 1, 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        db
    }

    fn tool(name: &str, description: &str) -> DiscoveredTool {
        DiscoveredTool {
            name: name.into(),
            description: Some(description.into()),
            input_schema: Some(serde_json::json!({ "type": "object" })),
        }
    }

    async fn tool_names(db: &SqlitePool) -> Vec<String> {
        sqlx::query_scalar::<_, String>("SELECT name FROM mcp_tools ORDER BY name")
            .fetch_all(db)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_first_sync_stores_every_advertised_tool() {
        let db = fixture().await;
        sync_tools(&db, "s1", &[tool("read", "reads"), tool("write", "writes")])
            .await
            .unwrap();
        assert_eq!(tool_names(&db).await, vec!["read", "write"]);
    }

    /// The reason the rows are persisted at all: the danger level is the user's,
    /// and a reconnect must not hand it back to the default. An autostart runs
    /// this on every launch, so a bug here would quietly reset every level the
    /// user had set the first time the app restarted.
    #[tokio::test]
    async fn a_resync_refreshes_the_description_but_keeps_the_danger_level() {
        let db = fixture().await;
        sync_tools(&db, "s1", &[tool("write", "writes")]).await.unwrap();
        sqlx::query("UPDATE mcp_tools SET danger_level = 2 WHERE name = 'write'")
            .execute(&db)
            .await
            .unwrap();

        sync_tools(&db, "s1", &[tool("write", "writes a file, carefully")])
            .await
            .unwrap();

        let (description, danger) =
            sqlx::query_as::<_, (String, i64)>(
                "SELECT description, danger_level FROM mcp_tools WHERE name = 'write'",
            )
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(description, "writes a file, carefully");
        assert_eq!(danger, 2);
    }

    #[tokio::test]
    async fn a_tool_the_server_no_longer_offers_is_dropped() {
        let db = fixture().await;
        sync_tools(&db, "s1", &[tool("read", "reads"), tool("write", "writes")])
            .await
            .unwrap();
        sync_tools(&db, "s1", &[tool("read", "reads")]).await.unwrap();
        assert_eq!(tool_names(&db).await, vec!["read"]);
    }

    /// A server that answers `tools/list` with nothing is a server that offers
    /// nothing — not a reason to keep the last list it gave us.
    #[tokio::test]
    async fn an_empty_tool_list_empties_the_table() {
        let db = fixture().await;
        sync_tools(&db, "s1", &[tool("read", "reads")]).await.unwrap();
        sync_tools(&db, "s1", &[]).await.unwrap();
        assert!(tool_names(&db).await.is_empty());
    }
}


// ---------------------------------------------------------------------------
// Resources and prompts (0.15.3)
// ---------------------------------------------------------------------------
//
// We called `tools/list` and `tools/call` and nothing else, so a server
// offering fifty documents and a dozen prompt templates offered this app none
// of them. Two more protocol calls each buy a whole surface.
//
// Both lists answer with an empty vector when the server does not implement the
// method. That is not swallowing an error: a server without resources returns
// exactly the same JSON-RPC "method not found" as a broken one, and most
// servers have no resources. The alternative is an error banner on every
// settings panel for every well-behaved server that simply does not offer them.

/// Every resource the server currently offers. Empty when it offers none, or
/// does not implement `resources/list` at all.
#[tauri::command]
pub async fn list_mcp_resources(
    _state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<mcp::DiscoveredResource>> {
    Ok(mcp::manager().list_resources(&id).await.unwrap_or_default())
}

/// Read one resource as text, to be attached to a message.
///
/// This one *does* surface its error: the user picked a specific document and
/// is waiting for it, so silence would look like an empty file.
#[tauri::command]
pub async fn read_mcp_resource(
    _state: State<'_, AppState>,
    id: String,
    uri: String,
) -> AppResult<String> {
    mcp::manager().read_resource(&id, &uri).await
}

/// Every prompt template the server offers — the slash commands.
#[tauri::command]
pub async fn list_mcp_prompts(
    _state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<mcp::DiscoveredPrompt>> {
    Ok(mcp::manager().list_prompts(&id).await.unwrap_or_default())
}

/// Expand a prompt template into the text it stands for.
#[tauri::command]
pub async fn get_mcp_prompt(
    _state: State<'_, AppState>,
    id: String,
    name: String,
    arguments: Option<serde_json::Value>,
) -> AppResult<String> {
    mcp::manager()
        .get_prompt(&id, &name, arguments.unwrap_or_else(|| serde_json::json!({})))
        .await
}
