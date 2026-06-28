use crate::commands::{new_id, now_ts};
use crate::error::AppResult;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

/// A portable zone preset stored as a JSON file in the on-disk zone library.
///
/// Provider and model are intentionally not bound here — a library entry is
/// environment-independent. Curated entries carry no model at all; user-saved
/// snapshots may keep one. `install` (frontend) resolves the provider/model
/// from the user's own settings when turning an entry into a live zone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub name: String,
    /// Shipped-with-the-app preset (vs. a user "Save to library" snapshot).
    #[serde(default)]
    pub curated: bool,
    pub icon: Option<String>,
    pub accent_color: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    #[serde(default = "default_temp")]
    pub temperature: f64,
    pub max_tokens: Option<i64>,
    pub top_p: Option<f64>,
    /// JSON array string of tool ids (mirrors `Zone.tools_enabled`).
    #[serde(default = "empty_array")]
    pub tools_enabled: String,
    /// JSON object string of per-tool config (mirrors `Zone.tool_config`).
    #[serde(default = "empty_object")]
    pub tool_config: String,
    #[serde(default)]
    pub thinking_enabled: bool,
    #[serde(default)]
    pub include_thinking_in_context: bool,
    /// Response Leader preset — installs as a sub-agent-coordinating zone.
    #[serde(default)]
    pub is_leader: bool,
    /// One-line blurb shown on the library card.
    #[serde(default)]
    pub description: Option<String>,
    /// Library-detail metadata (cosmetic): who authored it, where it came from,
    /// a version label, and example prompts.
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub examples: Vec<String>,
    /// True for shipped MultiZone presets; false for user imports/snapshots.
    #[serde(default)]
    pub curated_team: bool,
    #[serde(default)]
    pub created_at: i64,
}

fn default_temp() -> f64 {
    0.7
}
fn empty_array() -> String {
    "[]".to_string()
}
fn empty_object() -> String {
    "{}".to_string()
}

fn library_dir(state: &AppState) -> PathBuf {
    state.app_data_dir.join("zone_library")
}

/// All library entries, read from the JSON files in the library directory.
/// Curated entries are listed first, then alphabetically by name.
#[tauri::command]
pub async fn list_library_entries(state: State<'_, AppState>) -> AppResult<Vec<LibraryEntry>> {
    let dir = library_dir(&state);
    let mut entries: Vec<LibraryEntry> = Vec::new();
    if let Ok(read) = std::fs::read_dir(&dir) {
        for e in read.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read_to_string(&path) {
                Ok(text) => match serde_json::from_str::<LibraryEntry>(&text) {
                    Ok(entry) => entries.push(entry),
                    Err(err) => tracing::warn!("skipping bad library file {path:?}: {err}"),
                },
                Err(err) => tracing::warn!("could not read library file {path:?}: {err}"),
            }
        }
    }
    entries.sort_by(|a, b| {
        b.curated
            .cmp(&a.curated)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Write a library entry to disk (one JSON file per entry). Fills in a fresh id
/// and timestamp when missing. Used both to seed curated presets and to save a
/// user snapshot.
#[tauri::command]
pub async fn upsert_library_entry(
    state: State<'_, AppState>,
    entry: LibraryEntry,
) -> AppResult<LibraryEntry> {
    let dir = library_dir(&state);
    std::fs::create_dir_all(&dir)?;

    let mut entry = entry;
    if entry.id.trim().is_empty() {
        entry.id = new_id();
    }
    if entry.created_at == 0 {
        entry.created_at = now_ts();
    }

    let path = dir.join(format!("{}.json", entry.id));
    std::fs::write(&path, serde_json::to_string_pretty(&entry)?)?;
    Ok(entry)
}

#[tauri::command]
pub async fn delete_library_entry(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let path = library_dir(&state).join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}
