//! Saved parameterised runs (0.15.4) — CRUD, and turning one into a prompt.

use crate::commands::{new_id, now_ts};
use crate::error::{AppError, AppResult};
use crate::runs::{self, RunParam, SavedRun};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

const RUN_COLS: &str = "id, name, description, template, params, zone_id, created_at, updated_at";

#[tauri::command]
pub async fn list_saved_runs(state: State<'_, AppState>) -> AppResult<Vec<SavedRun>> {
    Ok(
        sqlx::query_as::<_, SavedRun>(&format!("SELECT {RUN_COLS} FROM saved_runs ORDER BY name"))
            .fetch_all(&state.db)
            .await?,
    )
}

/// What the editor and the importer both send. `id` absent means create.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRunInput {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub template: String,
    #[serde(default)]
    pub params: Vec<RunParam>,
    pub zone_id: Option<String>,
}

#[tauri::command]
pub async fn upsert_saved_run(
    state: State<'_, AppState>,
    run: SavedRunInput,
) -> AppResult<SavedRun> {
    let name = run.name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("a saved run needs a name".into()));
    }
    let id = run.id.unwrap_or_else(new_id);
    let now = now_ts();
    let params = serde_json::to_string(&run.params).unwrap_or_else(|_| "[]".into());

    sqlx::query(
        "INSERT INTO saved_runs (id, name, description, template, params, zone_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET
           name = ?2, description = ?3, template = ?4, params = ?5, zone_id = ?6, updated_at = ?7",
    )
    .bind(&id)
    .bind(name)
    .bind(&run.description)
    .bind(&run.template)
    .bind(&params)
    .bind(&run.zone_id)
    .bind(now)
    .execute(&state.db)
    .await?;

    Ok(
        sqlx::query_as::<_, SavedRun>(&format!("SELECT {RUN_COLS} FROM saved_runs WHERE id = ?1"))
            .bind(&id)
            .fetch_one(&state.db)
            .await?,
    )
}

#[tauri::command]
pub async fn delete_saved_run(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM saved_runs WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// The prompt a run produces for a given set of values, plus anything required
/// that is still unfilled.
///
/// Rendering is a separate call from sending so the caller can show the user
/// what is about to be sent. A run is a thing you keep because it worked once —
/// seeing the filled-in prompt before it goes is how you tell it still does.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedRun {
    pub prompt: String,
    pub missing: Vec<String>,
    pub zone_id: Option<String>,
}

#[tauri::command]
pub async fn render_saved_run(
    state: State<'_, AppState>,
    id: String,
    values: Option<Value>,
) -> AppResult<RenderedRun> {
    let run =
        sqlx::query_as::<_, SavedRun>(&format!("SELECT {RUN_COLS} FROM saved_runs WHERE id = ?1"))
            .bind(&id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("saved run {id}")))?;

    let values = values.unwrap_or_else(|| Value::Object(Default::default()));
    let params = run.params();
    Ok(RenderedRun {
        prompt: runs::render(&run.template, &params, &values),
        missing: runs::missing_required(&params, &values),
        zone_id: run.zone_id.clone(),
    })
}
