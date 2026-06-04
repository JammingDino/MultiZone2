use crate::commands::{new_id, now_ts};
use crate::db::models::Provider;
use crate::error::{AppError, AppResult};
use crate::llm::client::LlmClient;
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;

#[tauri::command]
pub async fn list_providers(state: State<'_, AppState>) -> AppResult<Vec<Provider>> {
    let rows = sqlx::query_as::<_, Provider>(
        "SELECT id, name, base_url, api_key, created_at FROM providers ORDER BY name",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub id: Option<String>,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
}

#[tauri::command]
pub async fn upsert_provider(
    state: State<'_, AppState>,
    provider: ProviderInput,
) -> AppResult<Provider> {
    let id = provider.id.unwrap_or_else(new_id);
    let now = now_ts();

    sqlx::query(
        "INSERT INTO providers (id, name, base_url, api_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           api_key = excluded.api_key",
    )
    .bind(&id)
    .bind(&provider.name)
    .bind(&provider.base_url)
    .bind(&provider.api_key)
    .bind(now)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Provider>(
        "SELECT id, name, base_url, api_key, created_at FROM providers WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn delete_provider(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM providers WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn fetch_models(
    state: State<'_, AppState>,
    provider_id: String,
) -> AppResult<Vec<String>> {
    let row = sqlx::query_as::<_, Provider>(
        "SELECT id, name, base_url, api_key, created_at FROM providers WHERE id = ?1",
    )
    .bind(&provider_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("provider {provider_id}")))?;

    let client = LlmClient::new(&state.http, &row.base_url, row.api_key.as_deref());
    client.list_models().await
}
