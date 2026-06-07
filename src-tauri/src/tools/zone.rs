use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// Tool definitions for discovering and switching the chat's active zone.
/// Both are exposed under the `switch_zone` tool id.
pub fn definitions() -> Vec<Tool> {
    vec![list_definition(), change_definition()]
}

fn list_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "list_zones".into(),
            description:
                "List the available zones (LLM configurations) you can switch this \
                 conversation to. Returns each zone's id, name and model. Call this \
                 before change_zone if you are unsure of the exact name."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {},
            }),
        },
    }
}

fn change_definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "change_zone".into(),
            description:
                "Switch the current conversation to a different zone (a different LLM \
                 configuration: model, system prompt, tools, etc.). The switch is \
                 permanent for this chat and takes effect immediately — subsequent steps \
                 in this same turn run under the new zone. Use this when the user's request \
                 is better handled by another zone. If the requested zone cannot be found, \
                 the call returns an error and the conversation simply continues on the \
                 current zone."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "zone": {
                        "type": "string",
                        "description": "The zone to switch to — its name (case-insensitive) or its id. Call list_zones first if unsure."
                    }
                },
                "required": ["zone"]
            }),
        },
    }
}

/// Return all zones as a compact JSON array the model can read back.
pub async fn list_zones(db: &SqlitePool) -> AppResult<String> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, name, model FROM zones ORDER BY name")
            .fetch_all(db)
            .await?;
    let zones: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, model)| json!({ "id": id, "name": name, "model": model }))
        .collect();
    Ok(json!({ "zones": zones }).to_string())
}

/// Resolve `zone` (by id or case-insensitive name) and set it as the chat's
/// primary zone. Returns a small JSON status the model (and the step UI) reads.
pub async fn change_zone(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let query = args
        .get("zone")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return Ok(json!({ "error": "change_zone requires a non-empty 'zone'" }).to_string());
    }

    // Try id first, then exact case-insensitive name.
    let matches: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM zones WHERE id = ?1 OR lower(name) = lower(?1)",
    )
    .bind(&query)
    .fetch_all(db)
    .await?;

    let (zone_id, zone_name) = match matches.as_slice() {
        [] => {
            return Ok(json!({
                "error": format!("no zone matching '{query}'. Call list_zones to see available zones."),
            })
            .to_string());
        }
        [one] => one.clone(),
        _many => {
            return Ok(json!({
                "error": format!("multiple zones match '{query}'; specify the exact id instead."),
            })
            .to_string());
        }
    };

    sqlx::query("UPDATE chats SET zone_id = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(&zone_id)
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(chat_id)
        .execute(db)
        .await?;

    Ok(json!({
        "status": "ok",
        "switched_to": { "id": zone_id, "name": zone_name },
        "note": "This chat is now using the new zone; continue with it."
    })
    .to_string())
}
