use crate::commands::{new_id, now_ts};
use crate::db::models::Zone;
use crate::error::AppResult;
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;

use crate::db::models::ZONE_COLS;

#[tauri::command]
pub async fn list_zones(state: State<'_, AppState>) -> AppResult<Vec<Zone>> {
    let rows = sqlx::query_as::<_, Zone>(&format!(
        "SELECT {ZONE_COLS} FROM zones ORDER BY name"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneInput {
    pub id: Option<String>,
    pub name: String,
    pub provider_id: Option<String>,
    pub model: String,
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub top_p: Option<f64>,
    /// JSON-encoded array of tool IDs
    pub tools_enabled: Option<String>,
    /// JSON-encoded config object
    pub tool_config: Option<String>,
    pub thinking_enabled: Option<bool>,
    /// `low` / `medium` / `high`; anything else is stored as medium.
    pub thinking_effort: Option<String>,
    pub include_thinking_in_context: Option<bool>,
    pub icon: Option<String>,
    pub accent_color: Option<String>,
    /// Response Leader flag — marks the zone as a sub-agent coordinator.
    pub is_leader: Option<bool>,
    /// Zone to answer with when this one's provider will not serve (0.14.1).
    pub fallback_zone_id: Option<String>,
    /// JSON approval overrides for this zone (0.14.2). Null inherits.
    pub approvals: Option<String>,
}

#[tauri::command]
pub async fn upsert_zone(state: State<'_, AppState>, zone: ZoneInput) -> AppResult<Zone> {
    let id = zone.id.unwrap_or_else(new_id);
    let now = now_ts();
    let tools_enabled = zone.tools_enabled.unwrap_or_else(|| "[]".to_string());
    let tool_config = zone.tool_config.unwrap_or_else(|| "{}".to_string());
    let thinking_enabled = zone.thinking_enabled.unwrap_or(false);
    let thinking_effort = match zone.thinking_effort.as_deref().map(str::trim) {
        Some("low") => "low",
        Some("high") => "high",
        _ => "medium",
    };
    let include_thinking_in_context = zone.include_thinking_in_context.unwrap_or(false);
    let is_leader = zone.is_leader.unwrap_or(false);

    sqlx::query(
        "INSERT INTO zones (id, name, provider_id, model, system_prompt, temperature_override,
                            max_tokens, top_p, tools_enabled, tool_config, thinking_enabled,
                            include_thinking_in_context, icon, accent_color, is_leader,
                            fallback_zone_id, approvals, created_at, updated_at, thinking_effort)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18, ?19)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           provider_id = excluded.provider_id,
           model = excluded.model,
           system_prompt = excluded.system_prompt,
           temperature_override = excluded.temperature_override,
           max_tokens = excluded.max_tokens,
           top_p = excluded.top_p,
           tools_enabled = excluded.tools_enabled,
           tool_config = excluded.tool_config,
           thinking_enabled = excluded.thinking_enabled,
           thinking_effort = excluded.thinking_effort,
           include_thinking_in_context = excluded.include_thinking_in_context,
           icon = excluded.icon,
           accent_color = excluded.accent_color,
           is_leader = excluded.is_leader,
           fallback_zone_id = excluded.fallback_zone_id,
           approvals = excluded.approvals,
           updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(&zone.name)
    .bind(&zone.provider_id)
    .bind(&zone.model)
    .bind(&zone.system_prompt)
    .bind(zone.temperature)
    .bind(zone.max_tokens)
    .bind(zone.top_p)
    .bind(&tools_enabled)
    .bind(&tool_config)
    .bind(thinking_enabled)
    .bind(include_thinking_in_context)
    .bind(&zone.icon)
    .bind(&zone.accent_color)
    .bind(is_leader)
    // A zone that falls back to itself would retry the dead provider and call
    // it recovery. Normalised here rather than trusted from the editor, since
    // the API writes zones too.
    .bind(zone.fallback_zone_id.filter(|f| f != &id))
    // An empty object is "this zone overrides nothing", which is what NULL
    // already means — stored as NULL so the two cannot drift apart.
    .bind(zone.approvals.filter(|a| {
        let t = a.trim();
        !t.is_empty() && t != "{}"
    }))
    .bind(now)
    .bind(thinking_effort)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Zone>(&format!(
        "SELECT {ZONE_COLS} FROM zones WHERE id = ?1"
    ))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn delete_zone(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM zones WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// What the thinking switch will do for this model on this provider (0.17.9),
/// so the zone editor can show the levels it takes — or say that it has no
/// reasoning mode — instead of offering every model the same checkbox.
///
/// With no provider id the first provider stands in, as it does for quick chat;
/// with none at all the model is judged as hosted, which only affects the
/// unrecognised-model fallback.
#[tauri::command]
pub async fn thinking_profile(
    state: State<'_, AppState>,
    provider_id: Option<String>,
    model: String,
) -> AppResult<crate::llm::thinking::Profile> {
    let base_url: Option<String> = match provider_id.filter(|p| !p.is_empty()) {
        Some(id) => {
            sqlx::query_scalar("SELECT base_url FROM providers WHERE id = ?1")
                .bind(id)
                .fetch_optional(&state.db)
                .await?
        }
        None => {
            sqlx::query_scalar("SELECT base_url FROM providers ORDER BY created_at ASC LIMIT 1")
                .fetch_optional(&state.db)
                .await?
        }
    };
    Ok(crate::llm::thinking::profile(&model, base_url.as_deref().unwrap_or("")))
}
