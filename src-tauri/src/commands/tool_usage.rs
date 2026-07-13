//! Tool usage stats (0.9.3) — per-zone, per-tool counters.
//!
//! Zones accumulate tools over time and nobody prunes them, because there's no
//! way to tell which ones the model actually reaches for. Every tool in a zone's
//! set costs context on every single turn, so a bloated toolset is a real tax on
//! a small local model. These counters answer "does this zone use this, and does
//! it work" directly in the zone editor.
//!
//! Recording is best-effort and never blocks a turn: a failed counter write logs
//! and is dropped, since losing a statistic matters far less than losing a tool
//! result.

use crate::db::models::ToolUsage;
use crate::error::AppResult;
use crate::state::AppState;
use sqlx::SqlitePool;
use tauri::State;

/// Bump the counters for one tool call. `errored` is decided by the caller from
/// the tool's own result payload (an `error` key), so a tool that fails softly
/// still counts as an error.
pub async fn record(db: &SqlitePool, zone_id: &str, tool_name: &str, errored: bool) {
    let res = sqlx::query(
        "INSERT INTO tool_usage (zone_id, tool_name, calls, errors, last_used_at)
         VALUES (?1, ?2, 1, ?3, ?4)
         ON CONFLICT(zone_id, tool_name) DO UPDATE SET
           calls        = calls + 1,
           errors       = errors + ?3,
           last_used_at = ?4",
    )
    .bind(zone_id)
    .bind(tool_name)
    .bind(if errored { 1 } else { 0 })
    .bind(chrono::Utc::now().timestamp())
    .execute(db)
    .await;

    if let Err(e) = res {
        // Never fail a turn over a statistic.
        eprintln!("tool_usage: failed to record {tool_name} for zone {zone_id}: {e}");
    }
}

/// Did this tool result represent a failure? Tools here return their errors in
/// the payload (`{"error": "..."}`) rather than as a Rust `Err`, so that's what
/// we look for.
pub fn result_is_error(result: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(result)
        .ok()
        .and_then(|v| v.get("error").cloned())
        .is_some()
}

#[tauri::command]
pub async fn get_tool_usage(
    state: State<'_, AppState>,
    zone_id: Option<String>,
) -> AppResult<Vec<ToolUsage>> {
    let rows = match zone_id {
        Some(id) => {
            sqlx::query_as::<_, ToolUsage>(
                "SELECT zone_id, tool_name, calls, errors, last_used_at FROM tool_usage
                 WHERE zone_id = ?1 ORDER BY calls DESC",
            )
            .bind(id)
            .fetch_all(&state.db)
            .await?
        }
        None => {
            sqlx::query_as::<_, ToolUsage>(
                "SELECT zone_id, tool_name, calls, errors, last_used_at FROM tool_usage
                 ORDER BY calls DESC",
            )
            .fetch_all(&state.db)
            .await?
        }
    };
    Ok(rows)
}

/// Clear the counters — for one zone, or all of them.
#[tauri::command]
pub async fn reset_tool_usage(state: State<'_, AppState>, zone_id: Option<String>) -> AppResult<()> {
    match zone_id {
        Some(id) => {
            sqlx::query("DELETE FROM tool_usage WHERE zone_id = ?1")
                .bind(id)
                .execute(&state.db)
                .await?;
        }
        None => {
            sqlx::query("DELETE FROM tool_usage").execute(&state.db).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_a_soft_error_payload() {
        assert!(result_is_error(r#"{"error":"path is outside the allowed roots"}"#));
        assert!(!result_is_error(r#"{"ok":true,"path":"a.txt"}"#));
        // A non-JSON result (plain text) is not an error by itself.
        assert!(!result_is_error("some plain output"));
    }
}
