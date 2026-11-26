use crate::commands::{new_id, now_ts};
use crate::db::models::{Project, Tag};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::State;

// ─── Projects ────────────────────────────────────────────────────────────────

pub const PROJECT_COLS: &str = "id, name, icon, accent_color, default_zone_id, context_snippet, directory, default_context_enabled, lint_command, test_command, kb_provider_id, kb_embedding_model, kb_dimensions, kb_indexed_at, kb_default_enabled, study_mode, approvals, spend_limit, created_at, updated_at";

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    // The reserved global-KB project is hidden — it backs the default-directory
    // knowledge base, not a user-facing project.
    let rows = sqlx::query_as::<_, Project>(
        &format!("SELECT {PROJECT_COLS} FROM projects WHERE id != ?1 ORDER BY name"),
    )
    .bind(crate::knowledge::GLOBAL_KB_ID)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

/// Absent → `None`, `null` → `Some(None)`, a value → `Some(Some(v))`.
///
/// What makes a partial save possible: an agent sending `{"icon": "Code"}`
/// must not clear the directory it never mentioned, while `{"directory": null}`
/// must still clear it.
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// A project write. Every field but `id` is optional: on an existing project an
/// absent field keeps its value and `null` clears it, so the same body serves
/// a full save from the editor and a one-field change from an agent. Unknown
/// keys are refused rather than ignored, so a typo (`"color"`) is an error the
/// caller sees instead of a change that silently did not happen.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectInput {
    pub id: Option<String>,
    /// Required when creating.
    pub name: Option<String>,
    /// A shipped icon id (see [`SHIPPED_ICONS`]) or `gen:<id>` of a drawn one.
    #[serde(default, deserialize_with = "present")]
    pub icon: Option<Option<String>>,
    /// `#rrggbb` (or `#rgb`).
    #[serde(default, deserialize_with = "present")]
    pub accent_color: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub default_zone_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub context_snippet: Option<Option<String>>,
    /// An existing absolute directory.
    #[serde(default, deserialize_with = "present")]
    pub directory: Option<Option<String>>,
    pub default_context_enabled: Option<bool>,
    /// Commands run against this project's own tree once a turn's edits have
    /// landed (0.14.5). Empty clears the stored one.
    #[serde(default, deserialize_with = "present")]
    pub lint_command: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub test_command: Option<Option<String>>,
    pub study_mode: Option<bool>,
    /// Whether new chats start with knowledge on; `null` inherits the global.
    #[serde(default, deserialize_with = "present")]
    pub kb_default_enabled: Option<Option<bool>>,
    /// Approval overrides: an object (or its JSON string) in the zone
    /// `approvals` shape plus `planEntry`. See `approvals::check_config`.
    #[serde(default, deserialize_with = "present")]
    pub approvals: Option<Option<Value>>,
    /// Session token ceiling for chats here; 0 = unmetered.
    #[serde(default, deserialize_with = "present")]
    pub spend_limit: Option<Option<i64>>,
}

/// The icon ids the picker offers, read out of the frontend's own icon table
/// at compile time so the two cannot disagree about which ids exist.
pub fn shipped_icons() -> &'static [String] {
    static ICONS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    ICONS.get_or_init(|| {
        include_str!("../../../src/lib/zoneIcons.tsx")
            .split("{ id: \"")
            .skip(1)
            .filter_map(|s| s.split('"').next().map(str::to_string))
            .collect()
    })
}

/// The picker's preset colours, from the same file. Any `#rrggbb` is accepted;
/// these are what to choose from when nothing in particular was asked for.
pub fn preset_colors() -> Vec<String> {
    let src = include_str!("../../../src/lib/zoneIcons.tsx");
    let Some((_, rest)) = src.split_once("ZONE_COLOR_PRESETS = [") else { return vec![] };
    let list = rest.split(']').next().unwrap_or_default();
    list.split('"').skip(1).step_by(2).map(str::to_string).collect()
}

fn normalize_color(raw: &str) -> AppResult<String> {
    let hex = raw.trim().trim_start_matches('#');
    let hex = match hex.len() {
        3 => hex.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => hex.to_string(),
        _ => String::new(),
    };
    if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::Invalid(format!(
            "accentColor `{raw}` is not a hex colour: use #rrggbb, e.g. one of {}",
            preset_colors().join(", ")
        )));
    }
    Ok(format!("#{}", hex.to_ascii_lowercase()))
}

async fn check_icon(db: &SqlitePool, icon: &str) -> AppResult<()> {
    if shipped_icons().iter().any(|i| i == icon) {
        return Ok(());
    }
    if let Some(id) = icon.strip_prefix(crate::project_setup::GENERATED_PREFIX) {
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM generated_icons WHERE id = ?1")
            .bind(id)
            .fetch_optional(db)
            .await?;
        if found.is_some() {
            return Ok(());
        }
    }
    Err(AppError::Invalid(format!(
        "unknown icon `{icon}`: use an id from GET /api/projects/schema (icons), e.g. Code, BookOpen, \
         Brain, Briefcase — or gen:<id> of a drawn icon from GET /api/icons"
    )))
}

/// Empty and whitespace-only text means "none", whichever client sent it.
fn text(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The chat's project's approval overrides, if it is in a project that has
/// any. Read by the approval policy and by plan-entry, which both layer it
/// between the global setting and the zone.
pub async fn approvals_for_chat(db: &SqlitePool, chat_id: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT p.approvals FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id = ?1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .flatten()
}

pub async fn get_project(db: &SqlitePool, id: &str) -> AppResult<Project> {
    sqlx::query_as::<_, Project>(&format!("SELECT {PROJECT_COLS} FROM projects WHERE id = ?1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("project {id}")))
}

/// Create or update a project: validate what was sent, keep what was not.
///
/// Only the fields present are validated. A project whose stored directory has
/// since been deleted must still be renamable, so the merged row is not
/// re-checked — only what this write changes.
pub async fn save_project(db: &SqlitePool, input: ProjectInput) -> AppResult<Project> {
    let old = match &input.id {
        Some(id) => get_project(db, id).await.ok(),
        None => None,
    };
    let is_new = old.is_none();
    let id = input.id.clone().unwrap_or_else(new_id);

    // Absent keeps the old name; blank is an error, not "keep".
    let name = match (input.name.as_deref().map(str::trim), &old) {
        (Some(n), _) if !n.is_empty() => n.to_string(),
        (None, Some(p)) => p.name.clone(),
        _ => return Err(AppError::Invalid("a project needs a non-empty name".into())),
    };

    // A field's new value, and whether it needs checking: only a value this
    // write changes. The editor resends every field on each autosave, and a
    // project whose folder was since deleted must still be renamable.
    let keep = |v: Option<Option<String>>, was: Option<&String>| -> (Option<String>, bool) {
        match v {
            None => (was.cloned(), false),
            Some(v) => {
                let v = text(v);
                let check = v.is_some() && v.as_ref() != was;
                (v, check)
            }
        }
    };

    let (icon, check) = keep(input.icon, old.as_ref().and_then(|p| p.icon.as_ref()));
    if let (true, Some(i)) = (check, &icon) {
        check_icon(db, i).await?;
    }

    let (accent_color, check) = keep(input.accent_color, old.as_ref().and_then(|p| p.accent_color.as_ref()));
    let accent_color = match (check, accent_color) {
        (true, Some(c)) => Some(normalize_color(&c)?),
        (_, c) => c,
    };

    let (default_zone_id, check) = keep(input.default_zone_id, old.as_ref().and_then(|p| p.default_zone_id.as_ref()));
    if let (true, Some(z)) = (check, &default_zone_id) {
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM zones WHERE id = ?1")
            .bind(z)
            .fetch_optional(db)
            .await?;
        if found.is_none() {
            return Err(AppError::Invalid(format!(
                "no zone `{z}`: defaultZoneId takes a zone id from GET /api/zones"
            )));
        }
    }

    let (directory, check) = keep(input.directory, old.as_ref().and_then(|p| p.directory.as_ref()));
    if let (true, Some(d)) = (check, &directory) {
        let path = std::path::Path::new(d);
        if !path.is_absolute() || !path.is_dir() {
            return Err(AppError::Invalid(format!(
                "directory `{d}` is not an existing absolute folder on this machine: create it first \
                 (create_folder), or check the path"
            )));
        }
    }

    let approvals = match input.approvals {
        None => old.as_ref().and_then(|p| p.approvals.clone()),
        Some(None) => None,
        Some(Some(v)) => {
            // A JSON string is accepted too, which is how the editor holds it.
            let v = match v {
                Value::String(s) if s.trim().is_empty() => Value::Null,
                Value::String(s) => serde_json::from_str(&s)
                    .map_err(|e| AppError::Invalid(format!("approvals is not valid JSON: {e}")))?,
                v => v,
            };
            if v.is_null() {
                None
            } else {
                crate::approvals::check_config(&v).map_err(AppError::Invalid)?;
                // `{}` overrides nothing, which NULL already means.
                v.as_object().filter(|o| !o.is_empty()).map(|_| v.to_string())
            }
        }
    };

    let spend_limit = match input.spend_limit {
        None => old.as_ref().and_then(|p| p.spend_limit),
        Some(Some(n)) if n < 0 => {
            return Err(AppError::Invalid("spendLimit is a token count: 0 (unmetered) or more".into()))
        }
        Some(v) => v,
    };

    let context_snippet = match input.context_snippet {
        None => old.as_ref().and_then(|p| p.context_snippet.clone()),
        // Kept as written apart from blank meaning none: it is prompt text.
        Some(v) => v.filter(|s| !s.trim().is_empty()),
    };
    let (lint_command, _) = keep(input.lint_command, old.as_ref().and_then(|p| p.lint_command.as_ref()));
    let (test_command, _) = keep(input.test_command, old.as_ref().and_then(|p| p.test_command.as_ref()));
    let default_context = input
        .default_context_enabled
        .unwrap_or_else(|| old.as_ref().is_some_and(|p| p.default_context_enabled));
    let study_mode = input.study_mode.unwrap_or_else(|| old.as_ref().is_some_and(|p| p.study_mode));
    let kb_default = match input.kb_default_enabled {
        None => old.as_ref().and_then(|p| p.kb_default_enabled),
        Some(v) => v,
    };

    sqlx::query(
        "INSERT INTO projects (id, name, icon, accent_color, default_zone_id, context_snippet, directory,
           default_context_enabled, lint_command, test_command, study_mode, kb_default_enabled,
           approvals, spend_limit, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           icon = excluded.icon,
           accent_color = excluded.accent_color,
           default_zone_id = excluded.default_zone_id,
           context_snippet = excluded.context_snippet,
           directory = excluded.directory,
           default_context_enabled = excluded.default_context_enabled,
           lint_command = excluded.lint_command,
           test_command = excluded.test_command,
           study_mode = excluded.study_mode,
           kb_default_enabled = excluded.kb_default_enabled,
           approvals = excluded.approvals,
           spend_limit = excluded.spend_limit,
           updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(&name)
    .bind(&icon)
    .bind(&accent_color)
    .bind(&default_zone_id)
    .bind(&context_snippet)
    .bind(&directory)
    .bind(default_context)
    .bind(&lint_command)
    .bind(&test_command)
    .bind(study_mode)
    .bind(kb_default)
    .bind(&approvals)
    .bind(spend_limit)
    .bind(now_ts())
    .execute(db)
    .await?;

    // New projects inherit the global default embedding provider+model so the
    // user doesn't reconfigure it per project (they can still override it).
    if is_new {
        let (provider, model) = crate::knowledge::default_embedding_config(db).await;
        if provider.is_some() || model.is_some() {
            sqlx::query(
                "UPDATE projects SET kb_provider_id = ?1, kb_embedding_model = ?2 WHERE id = ?3",
            )
            .bind(&provider)
            .bind(&model)
            .bind(&id)
            .execute(db)
            .await?;
        }
    }
    get_project(db, &id).await
}

#[tauri::command]
pub async fn upsert_project(state: State<'_, AppState>, project: ProjectInput) -> AppResult<Project> {
    let row = save_project(&state.db, project).await?;
    // Directory may have changed — re-sync the knowledge watcher.
    crate::knowledge::watcher::resync().await;
    Ok(row)
}

/// What a project write accepts, for a caller that has not read this file —
/// an agent setting a project up. Served at `GET /api/projects/schema`.
pub async fn project_schema(db: &SqlitePool) -> AppResult<Value> {
    let zones: Vec<(String, String)> = sqlx::query_as("SELECT id, name FROM zones ORDER BY name")
        .fetch_all(db)
        .await?;
    let drawn: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM generated_icons ORDER BY created_at DESC")
            .fetch_all(db)
            .await?;
    Ok(json!({
        "create": "POST /api/projects with a body (no id); `name` is required.",
        "update": "PATCH /api/projects/:id with only the fields to change; null clears one.",
        "fields": {
            "name": "string, required on create",
            "icon": "one of `icons` below, or gen:<id> of a drawn icon (`drawnIcons`); POST /api/projects/:id/draw-icon draws a new one",
            "accentColor": "#rrggbb; `colors` are the picker's presets",
            "directory": "absolute path of an existing folder; the file tools are scoped to it",
            "defaultZoneId": "zone id from `zones` below; new chats in the project start on it",
            "contextSnippet": "text prepended to the system prompt of chats with project context on",
            "defaultContextEnabled": "boolean: new chats start with the context snippet on",
            "lintCommand": "command run in the directory after a turn's edits",
            "testCommand": "command run in the directory after a turn's edits",
            "studyMode": "boolean: chats answer only from the project's sources",
            "kbDefaultEnabled": "boolean or null (inherit): new chats start with knowledge search on",
            "approvals": {
                "about": "permission overrides for every chat in the project, layered over Settings → Approvals and under a zone's own",
                "categories": "object of category → true (auto-approve) | false (always ask)",
                "categoryKeys": ["read", "edit", "shell", "web", "mcp", "spawn", "state"],
                "shellAllow": "command prefixes that run without asking",
                "shellDeny": "command prefixes that are refused",
                "editAllow": "paths edits may touch without asking; {project} is the project directory",
                "editDeny": "paths edits are refused in",
                "planEntry": ["auto", "ask", "manual"]
            },
            "spendLimit": "integer tokens per session for chats with no limit of their own; 0 = unmetered, null = global default"
        },
        "icons": shipped_icons(),
        "drawnIcons": drawn.into_iter().map(|(id, name)| json!({ "icon": format!("{}{id}", crate::project_setup::GENERATED_PREFIX), "name": name })).collect::<Vec<_>>(),
        "colors": preset_colors(),
        "zones": zones.into_iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        "example": {
            "name": "Garden Planner",
            "icon": "Leaf",
            "accentColor": "#22c55e",
            "directory": "C:\\Users\\me\\code\\garden",
            "approvals": { "categories": { "read": true, "edit": true, "shell": false }, "editAllow": ["{project}"], "shellDeny": ["git push"], "planEntry": "ask" }
        }
    }))
}

/// Delete a project. By default its chats are kept and moved to "Ungrouped"
/// (the `chats.project_id` FK is `ON DELETE SET NULL`). Pass `delete_chats =
/// true` to also delete every chat in the project (and, via cascade, their
/// messages) before removing the project.
#[tauri::command]
pub async fn delete_project(
    state: State<'_, AppState>,
    id: String,
    delete_chats: Option<bool>,
) -> AppResult<()> {
    if delete_chats.unwrap_or(false) {
        sqlx::query("DELETE FROM chats WHERE project_id = ?1")
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    sqlx::query("DELETE FROM projects WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    crate::knowledge::watcher::resync().await;
    Ok(())
}

// ─── Projects the model sets up (see `project_setup`) ─────────────────────────

/// Name a just-created project, choose its icon and colour from the lists
/// given, and make its folder under the save directory, from `prompt` — the
/// message it was started with. The lists come from the frontend, which owns
/// the icon set, so the two cannot disagree about which ids exist. Drawing an
/// icon is `draw_project_icon`, called separately because nothing should wait
/// on it.
#[tauri::command]
pub async fn setup_new_project(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    chat_id: String,
    prompt: String,
    icon_ids: Vec<String>,
    colors: Vec<String>,
) -> AppResult<Project> {
    crate::project_setup::setup(
        &state.db, &state.http, &app, &project_id, &chat_id, &prompt, &icon_ids, &colors,
    )
    .await
}

/// Have a model draw an SVG icon for the project and make it the project's
/// icon. It is kept, and offered in the icon picker under "Generated".
#[tauri::command]
pub async fn draw_project_icon(
    state: State<'_, AppState>,
    project_id: String,
    chat_id: Option<String>,
) -> AppResult<Project> {
    crate::project_setup::draw_icon(&state.db, &state.http, &project_id, chat_id.as_deref()).await
}

#[tauri::command]
pub async fn list_generated_icons(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::project_setup::GeneratedIcon>> {
    crate::project_setup::list_icons(&state.db).await
}

#[tauri::command]
pub async fn delete_generated_icon(state: State<'_, AppState>, icon_id: String) -> AppResult<()> {
    crate::project_setup::delete_icon(&state.db, &icon_id).await
}

/// Copy files into the project's folder and index it. GUI-only: the paths are
/// this machine's, picked in its file dialog.
#[tauri::command]
pub async fn add_project_sources(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> AppResult<usize> {
    crate::project_setup::add_sources(&state.db, &state.http, &app, &project_id, &paths).await
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> AppResult<Vec<Tag>> {
    let rows = sqlx::query_as::<_, Tag>(
        "SELECT id, name, color, context_snippet, created_at, updated_at FROM tags ORDER BY name",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInput {
    pub id: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub context_snippet: Option<String>,
}

#[tauri::command]
pub async fn upsert_tag(state: State<'_, AppState>, tag: TagInput) -> AppResult<Tag> {
    let id = tag.id.unwrap_or_else(new_id);
    let now = now_ts();
    sqlx::query(
        "INSERT INTO tags (id, name, color, context_snippet, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           color = excluded.color,
           context_snippet = excluded.context_snippet,
           updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(&tag.name)
    .bind(&tag.color)
    .bind(&tag.context_snippet)
    .bind(now)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Tag>(
        "SELECT id, name, color, context_snippet, created_at, updated_at FROM tags WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn delete_tag(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM tags WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        db
    }

    fn input(v: Value) -> ProjectInput {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn the_icon_and_colour_lists_are_read_from_the_frontend() {
        let icons = shipped_icons();
        assert!(icons.len() > 50, "parsed {} icons — has zoneIcons.tsx changed shape?", icons.len());
        assert!(icons.iter().any(|i| i == "Code") && icons.iter().any(|i| i == "BookOpen"));
        let colors = preset_colors();
        assert!(colors.len() >= 8 && colors.iter().all(|c| c.starts_with('#') && c.len() == 7), "{colors:?}");
    }

    #[test]
    fn unknown_fields_are_refused() {
        assert!(serde_json::from_value::<ProjectInput>(json!({ "name": "x", "color": "#fff" })).is_err());
    }

    #[tokio::test]
    async fn a_bad_icon_colour_zone_or_policy_is_refused() {
        let db = db().await;
        for bad in [
            json!({ "name": "x", "icon": "BookStack" }),
            json!({ "name": "x", "icon": "gen:nope" }),
            json!({ "name": "x", "accentColor": "blue" }),
            json!({ "name": "x", "defaultZoneId": "nope" }),
            json!({ "name": "x", "directory": "not/absolute" }),
            json!({ "name": "x", "approvals": { "categories": { "shel": true } } }),
            json!({ "name": "x", "approvals": { "categories": { "shell": "yes" } } }),
            json!({ "name": "x", "approvals": { "planEntry": "sometimes" } }),
            json!({ "name": "x", "approvals": { "shellDeny": "git push" } }),
            json!({ "name": "x", "spendLimit": -1 }),
            json!({ "name": "  " }),
            json!({ "icon": "Code" }),
        ] {
            assert!(save_project(&db, input(bad.clone())).await.is_err(), "accepted {bad}");
        }
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects").fetch_one(&db).await.unwrap();
        assert_eq!(n, 0, "a refused write must not leave a row behind");
    }

    #[tokio::test]
    async fn defaults_apply_and_a_partial_update_keeps_the_rest() {
        let db = db().await;
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let p = save_project(
            &db,
            input(json!({
                "name": " Garden ",
                "icon": "Leaf",
                "accentColor": "#2C5",
                "directory": dir,
                "contextSnippet": "Be brief.",
                "approvals": { "categories": { "edit": true }, "planEntry": "manual" },
                "spendLimit": 5000
            })),
        )
        .await
        .unwrap();
        assert_eq!(p.name, "Garden");
        assert_eq!(p.accent_color.as_deref(), Some("#22cc55"));
        assert!(!p.default_context_enabled && !p.study_mode && p.kb_default_enabled.is_none());

        // One field changed: everything else stays.
        let q = save_project(&db, input(json!({ "id": p.id, "icon": "Code" }))).await.unwrap();
        assert_eq!(q.icon.as_deref(), Some("Code"));
        assert_eq!(q.name, "Garden");
        assert_eq!(q.directory.as_deref(), Some(dir.as_str()));
        assert_eq!(q.context_snippet.as_deref(), Some("Be brief."));
        assert_eq!(q.spend_limit, Some(5000));
        assert!(q.approvals.as_deref().unwrap().contains("manual"));

        // null clears; `{}` approvals is stored as none.
        let r = save_project(&db, input(json!({ "id": p.id, "directory": null, "approvals": {} }))).await.unwrap();
        assert!(r.directory.is_none() && r.approvals.is_none());
        assert_eq!(r.icon.as_deref(), Some("Code"));
    }

    #[tokio::test]
    async fn the_project_policy_reaches_its_chats() {
        let db = db().await;
        let p = save_project(
            &db,
            input(json!({ "name": "p", "approvals": { "planEntry": "manual" }, "spendLimit": 7000 })),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO chats (id, title, project_id, created_at, updated_at) VALUES ('c', 't', ?1, 0, 0)")
            .bind(&p.id)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(crate::plans::PlanEntry::load(&db, "c").await, crate::plans::PlanEntry::Manual);
        assert_eq!(crate::plans::PlanEntry::load(&db, "elsewhere").await, crate::plans::PlanEntry::Ask);
        assert_eq!(crate::commands::messages::max_session_tokens(&db, "c").await, 7000);
    }
}
