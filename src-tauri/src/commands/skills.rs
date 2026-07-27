use crate::commands::{new_id, now_ts};
use crate::db::models::Skill;
use crate::error::AppResult;
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;

const SKILL_COLS: &str =
    "id, name, description, content, enabled, authored_by_zone_id, created_at, updated_at";

#[tauri::command]
pub async fn list_skills(state: State<'_, AppState>) -> AppResult<Vec<Skill>> {
    let rows = sqlx::query_as::<_, Skill>(&format!(
        "SELECT {SKILL_COLS} FROM skills ORDER BY name"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

/// Folder-backed skills found on disk (impeccable, HyperFrames, any Agent
/// Skills tree). Discovered fresh on every call — an installer can add or remove
/// one between calls and Settings should reflect that without a restart.
#[tauri::command]
pub async fn list_skill_packs(state: State<'_, AppState>) -> AppResult<Vec<crate::skillpacks::SkillPack>> {
    let packs = crate::skillpacks::discover(&state.db).await;
    // The counts cost a full walk per pack, so they are filled here (Settings is
    // open) and never on the per-message catalog path.
    Ok(tokio::task::spawn_blocking(move || crate::skillpacks::with_file_counts(packs))
        .await
        .unwrap_or_default())
}

/// The managed skills folder — where the app tells the user to install packs.
#[tauri::command]
pub async fn skill_packs_root() -> AppResult<String> {
    Ok(crate::skillpacks::managed_root()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInput {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub content: Option<String>,
    pub enabled: Option<bool>,
}

#[tauri::command]
pub async fn upsert_skill(state: State<'_, AppState>, skill: SkillInput) -> AppResult<Skill> {
    let id = skill.id.unwrap_or_else(new_id);
    let now = now_ts();
    let content = skill.content.unwrap_or_default();
    let enabled = skill.enabled.unwrap_or(true);
    sqlx::query(
        "INSERT INTO skills (id, name, description, content, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           content = excluded.content,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(&skill.name)
    .bind(&skill.description)
    .bind(&content)
    .bind(enabled)
    .bind(now)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Skill>(&format!(
        "SELECT {SKILL_COLS} FROM skills WHERE id = ?1"
    ))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

/// Toggle whether a skill appears in the catalog offered to agents.
#[tauri::command]
pub async fn set_skill_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> AppResult<()> {
    sqlx::query("UPDATE skills SET enabled = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(enabled)
        .bind(now_ts())
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_skill(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM skills WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}
