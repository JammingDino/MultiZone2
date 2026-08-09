//! Tauri commands for the connector catalog (0.11.2): list, install, import,
//! and diagnose.
//!
//! Installing writes an `mcp_servers` row and nothing else — no process is
//! started and no request is sent until the user connects. That matters because
//! these commands are reachable from the API, and therefore from a model through
//! `app_control`: the line the roadmap holds is that a model may *propose* a
//! connector and *diagnose* one, and the user approves the write. `app_control`
//! is a dangerous tool, so every install prompts; `list` and `diagnose` are
//! reads, which is what makes a model useful as a setup wizard without making it
//! one that installs a process-launcher on an injected instruction.

use crate::commands::mcp::McpServerInput;
use crate::commands::new_id;
use crate::db::models::McpServer;
use crate::error::{AppError, AppResult};
use crate::mcp::catalog::{self, ConnectorEntry};
use crate::mcp::{diagnose, SERVER_COLS};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use tauri::State;

/// The catalog as the picker renders it: the entries, plus which of them are
/// already installed so an entry can say so instead of quietly making a second
/// copy.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    pub entries: Vec<ConnectorEntry>,
    /// catalogId → the id of the server installed from it.
    pub installed: HashMap<String, String>,
}

#[tauri::command]
pub async fn list_connectors(state: State<'_, AppState>) -> AppResult<CatalogView> {
    let entries = catalog::load(&state.app_data_dir);
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT catalog_id, id FROM mcp_servers WHERE catalog_id IS NOT NULL",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(CatalogView { entries, installed: rows.into_iter().collect() })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallConnectorInput {
    /// Which catalog entry.
    pub entry_id: String,
    /// Field key → what the user typed. Templates (`Bearer {value}`) are applied
    /// here rather than in the UI, so the API and the panel install identically.
    #[serde(default)]
    pub values: HashMap<String, String>,
    /// Override the display name — two GitHub servers for two accounts is a
    /// reasonable thing to want.
    #[serde(default)]
    pub name: Option<String>,
    /// Appended to the entry's command line (the filesystem server's directories).
    #[serde(default)]
    pub command_suffix: Option<String>,
    /// Replace the server previously installed from this entry rather than
    /// adding a second one.
    #[serde(default)]
    pub replace: bool,
}

/// Install a catalog entry as an MCP server row. Refuses when a value the entry
/// marks required is missing: a row that cannot connect is worse than an error,
/// because the failure surfaces later and somewhere else.
#[tauri::command]
pub async fn install_connector(
    state: State<'_, AppState>,
    input: InstallConnectorInput,
) -> AppResult<McpServer> {
    let entry = catalog::find(&state.app_data_dir, &input.entry_id)
        .ok_or_else(|| AppError::NotFound(format!("connector '{}'", input.entry_id)))?;

    let missing: Vec<&str> = entry
        .fields()
        .filter(|f| f.required)
        .filter(|f| {
            input
                .values
                .get(&f.key)
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
        })
        .map(|f| f.key.as_str())
        .collect();
    if !missing.is_empty() {
        return Err(AppError::Invalid(format!(
            "{} needs {} before it can connect",
            entry.name,
            missing.join(", ")
        )));
    }

    let collect = |fields: &[catalog::ConnectorField]| -> Option<String> {
        let mut map = Map::new();
        for f in fields {
            let raw = input
                .values
                .get(&f.key)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .or(f.default.as_deref());
            if let Some(raw) = raw {
                map.insert(f.key.clone(), Value::String(f.render(raw)));
            }
        }
        (!map.is_empty()).then(|| Value::Object(map).to_string())
    };

    let command = entry.command.as_ref().map(|c| {
        match input.command_suffix.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(extra) => format!("{c} {extra}"),
            None => c.clone(),
        }
    });

    // Reuse the row already installed from this entry when asked to, so
    // re-running an install to fix a pasted token doesn't leave two servers and
    // a puzzle about which one a zone is enabled for.
    let existing: Option<String> = if input.replace {
        sqlx::query_as::<_, (String,)>("SELECT id FROM mcp_servers WHERE catalog_id = ?1 LIMIT 1")
            .bind(&entry.id)
            .fetch_optional(&state.db)
            .await?
            .map(|(id,)| id)
    } else {
        None
    };

    crate::commands::mcp::upsert_mcp_server(
        state,
        McpServerInput {
            id: Some(existing.unwrap_or_else(new_id)),
            name: input.name.unwrap_or_else(|| entry.name.clone()),
            transport: entry.transport.clone(),
            command,
            url: entry.url.clone(),
            env: collect(&entry.env),
            headers: collect(&entry.headers),
            catalog_id: Some(entry.id.clone()),
            enabled: Some(true),
        },
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportConnectorsInput {
    /// A URL serving one entry, a list of them, or `{"entries": [...]}`.
    #[serde(default)]
    pub url: Option<String>,
    /// The same JSON pasted directly, for a file the user already has.
    #[serde(default)]
    pub json: Option<String>,
}

/// Import catalog entries from a URL or pasted JSON. Entries are written to
/// `<app_data_dir>/connectors/` — data, not code, and removable by deleting a
/// file. Nothing is installed by importing: the entries join the picker and the
/// user still chooses one.
#[tauri::command]
pub async fn import_connectors(
    state: State<'_, AppState>,
    input: ImportConnectorsInput,
) -> AppResult<Vec<ConnectorEntry>> {
    let (text, source) = match (&input.json, &input.url) {
        (Some(json), _) if !json.trim().is_empty() => (json.clone(), None),
        (_, Some(url)) if !url.trim().is_empty() => {
            let url = url.trim();
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return Err(AppError::Invalid("a catalog URL must start with https://".into()));
            }
            let resp = state.http.get(url).send().await?;
            let status = resp.status();
            let body = resp.text().await?;
            if !status.is_success() {
                return Err(AppError::Other(format!("{url} returned HTTP {status}")));
            }
            (body, Some(url.to_string()))
        }
        _ => return Err(AppError::Invalid("give a URL or some JSON to import".into())),
    };

    let entries = catalog::parse_import(&text)?;
    catalog::save(&state.app_data_dir, &entries, source.as_deref())?;
    Ok(entries)
}

/// Remove an imported catalog entry (a shipped one cannot be removed — it has no
/// file to delete, and would come back on the next load).
#[tauri::command]
pub async fn delete_connector(state: State<'_, AppState>, entry_id: String) -> AppResult<()> {
    if !entry_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Invalid("not a connector id".into()));
    }
    let path = catalog::connectors_dir(&state.app_data_dir).join(format!("{entry_id}.json"));
    if !path.exists() {
        return Err(AppError::Invalid(
            "that entry ships with the app, so there is no file to remove".into(),
        ));
    }
    std::fs::remove_file(path)?;
    Ok(())
}

/// Why a server isn't working — see [`crate::mcp::diagnose`]. A read: it may
/// start the configured process, which connecting does anyway, and it writes
/// nothing.
#[tauri::command]
pub async fn diagnose_mcp_server(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<diagnose::Diagnosis> {
    let server = sqlx::query_as::<_, McpServer>(&format!(
        "SELECT {SERVER_COLS} FROM mcp_servers WHERE id = ?1"
    ))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("MCP server {id}")))?;

    let entry = server
        .catalog_id
        .as_deref()
        .and_then(|cid| catalog::find(&state.app_data_dir, cid));
    Ok(diagnose::run(&server, entry.as_ref()).await)
}
