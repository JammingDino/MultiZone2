//! Projects the model sets up, so starting one is typing a message.
//!
//! A project used to begin in settings: a name, an icon, a colour, a folder,
//! and for a study project a knowledge index — five decisions before the first
//! word, none of which the user came to make. Here the composer makes the
//! project under a placeholder, and the model reads the opening message and
//! fills the rest in:
//!
//! - **Naming** ([`setup`]): a name, one of the shipped icons and one of the
//!   preset colours, in a single small request with thinking off, and a folder
//!   under the save directory named after it. Fast enough to wait for, so the
//!   first turn already works in the project's own folder.
//! - **Drawing** ([`draw_icon`]): optionally, an SVG icon of the model's own.
//!   Slower, so nothing waits on it. Drawn icons are kept in `generated_icons`
//!   and offered in the icon picker under "Generated", for any project or zone.
//! - **Sources** ([`add_sources`]): files copied into the folder and indexed,
//!   which is all a study project needs to be usable.

use crate::commands::{new_id, now_ts};
use crate::db::models::Project;
use crate::error::{AppError, AppResult};
use crate::llm::client::LlmClient;
use crate::llm::types::{ChatMessage, ChatRequest, ContentPart, MessageContent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

/// The folder new projects are made in, under the save directory.
const PROJECTS_FOLDER: &str = "MultiZone Projects";
const NAME_MAX_CHARS: usize = 40;
/// Prompt excerpt the namer sees. The opening message is enough to name a
/// project by; a pasted chapter is not more so.
const PROMPT_EXCERPT_CHARS: usize = 2_000;
/// A drawn icon larger than this is not an icon.
const SVG_MAX_BYTES: usize = 16_000;
pub const GENERATED_PREFIX: &str = "gen:";

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedIcon {
    pub id: String,
    pub name: String,
    pub svg: String,
    pub created_at: i64,
}

// ─── Asking the model ────────────────────────────────────────────────────────

/// One short completion, thinking off, from the chat's model — or, with no
/// chat, from the base zone (or the default provider's model).
async fn complete(
    db: &SqlitePool,
    http: &reqwest::Client,
    chat_id: Option<&str>,
    prompt: String,
    max_tokens: i64,
) -> AppResult<String> {
    let (zone, provider) = match chat_id {
        Some(c) => crate::commands::messages::effective_zone_and_provider(db, c).await?,
        None => crate::commands::messages::base_zone_and_provider(db).await?,
    };
    let req = ChatRequest {
        model: zone.model.clone(),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: Some(MessageContent::Text(prompt)),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }],
        temperature: Some(0.5),
        max_tokens: Some(max_tokens),
        top_p: None,
        tools: None,
        tool_choice: None,
        reasoning_effort: None,
        chat_template_kwargs: None,
        thinking_extra: Default::default(),
        thinking_ask: None,
        stream_options: None,
        stream: false,
    };
    let mut client = LlmClient::new(http, &provider.base_url, provider.api_key.as_deref());
    if let Some(c) = chat_id {
        client = client.for_chat(c);
    }
    let resp = crate::commands::chats::request_quietly(&client, req).await?;
    Ok(resp
        .choices
        .first()
        .and_then(|c| match &c.message.content {
            Some(MessageContent::Text(s)) => Some(s.clone()),
            Some(MessageContent::Parts(parts)) => Some(
                parts
                    .iter()
                    .filter_map(|p| match p {
                        ContentPart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            None => None,
        })
        .unwrap_or_default())
}

/// A reasoning model that ignored "thinking off" wraps its answer in a
/// `<think>` block; what matters is after it.
fn after_thinking(raw: &str) -> &str {
    match raw.rfind("</think>") {
        Some(i) => &raw[i + "</think>".len()..],
        None => raw,
    }
}

// ─── Naming ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, PartialEq)]
struct Identity {
    name: Option<String>,
    icon: Option<String>,
    color: Option<String>,
}

/// Read `{"name","icon","color"}` out of a reply, keeping only an icon and a
/// colour from the lists offered — a model that invents `"BookStack"` gets the
/// default icon, not a broken one.
fn parse_identity(raw: &str, icons: &[String], colors: &[String]) -> Identity {
    let text = after_thinking(raw);
    let json = match (text.find('{'), text.rfind('}')) {
        (Some(a), Some(b)) if b > a => serde_json::from_str::<Value>(&text[a..=b]).ok(),
        _ => None,
    };
    let Some(v) = json else { return Identity::default() };
    let field = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let name = field("name").map(clean_name).filter(|n| !n.is_empty());
    let icon = field("icon").and_then(|i| icons.iter().find(|x| x.eq_ignore_ascii_case(i)).cloned());
    let color = field("color").and_then(|c| colors.iter().find(|x| x.eq_ignore_ascii_case(c)).cloned());
    Identity { name, icon, color }
}

fn clean_name(raw: &str) -> String {
    let s: String = raw
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '.' || c == '*')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    s.chars().take(NAME_MAX_CHARS).collect::<String>().trim().to_string()
}

/// The opening message's first few words, for when the model's reply is not
/// usable — better than leaving "New project" on every one of them.
fn fallback_name(prompt: &str, study: bool) -> String {
    let words: Vec<&str> = prompt
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .take(5)
        .collect();
    if words.is_empty() {
        return if study { "Study project".into() } else { "New project".into() };
    }
    let mut name = clean_name(&words.join(" "));
    if let Some(first) = name.get(..1) {
        name = first.to_uppercase() + &name[1..];
    }
    name
}

/// A folder name Windows, macOS and Linux will all accept.
fn folder_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() { "Project".into() } else { s }
}

/// Where new projects go: the save directory (the app's default directory)
/// if one is set, else the app's own data directory.
async fn projects_root(db: &SqlitePool, app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
        .fetch_optional(db)
        .await?;
    let saved = raw
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("defaultDirectory").and_then(Value::as_str).map(str::to_string))
        .filter(|s| !s.trim().is_empty());
    let base = match saved {
        Some(d) => PathBuf::from(d),
        None => {
            use tauri::Manager;
            app.path()
                .app_data_dir()
                .map_err(|e| AppError::Invalid(format!("no save directory: {e}")))?
        }
    };
    Ok(base.join(PROJECTS_FOLDER))
}

/// A fresh folder for `name` under `root`: "Signals", then "Signals 2", …
fn unique_dir(root: &Path, name: &str) -> PathBuf {
    let base = folder_name(name);
    let mut dir = root.join(&base);
    let mut n = 2;
    while dir.exists() {
        dir = root.join(format!("{base} {n}"));
        n += 1;
    }
    dir
}

async fn load_project(db: &SqlitePool, id: &str) -> AppResult<Project> {
    sqlx::query_as::<_, Project>(&format!(
        "SELECT {} FROM projects WHERE id = ?1",
        crate::commands::projects::PROJECT_COLS
    ))
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("project {id}")))
}

/// Give a just-made project its name, icon, colour and folder, from the
/// message it was started with. The folder is made whatever the model says,
/// so a failed naming call still leaves a project that works.
pub async fn setup(
    db: &SqlitePool,
    http: &reqwest::Client,
    app: &tauri::AppHandle,
    project_id: &str,
    chat_id: &str,
    prompt: &str,
    icons: &[String],
    colors: &[String],
) -> AppResult<Project> {
    let project = load_project(db, project_id).await?;
    let excerpt: String = prompt.chars().take(PROMPT_EXCERPT_CHARS).collect();
    let kind = if project.study_mode { "a study project — material the user wants to learn" } else { "a project" };
    let ask = format!(
        "The user is starting {kind} with this message:\n\n<message>\n{excerpt}\n</message>\n\n\
         Name the project and choose its icon and colour. Reply with JSON only, no prose, no code fence:\n\
         {{\"name\": \"…\", \"icon\": \"…\", \"color\": \"…\"}}\n\
         - name: 1 to 4 words, a noun phrase for the subject (\"Signals and Systems\", \"Garden Planner\"); \
         no quotes, no trailing period, not \"Project\".\n\
         - icon: exactly one of: {}\n\
         - color: exactly one of: {}",
        icons.join(", "),
        colors.join(", "),
    );
    let identity = match complete(db, http, Some(chat_id), ask, 300).await {
        Ok(raw) => parse_identity(&raw, icons, colors),
        Err(e) => {
            tracing::warn!("project naming failed: {e}");
            Identity::default()
        }
    };
    let name = identity.name.unwrap_or_else(|| fallback_name(prompt, project.study_mode));

    let root = projects_root(db, app).await?;
    let dir = unique_dir(&root, &name);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Invalid(format!("couldn't create {}: {e}", dir.display())))?;

    sqlx::query(
        "UPDATE projects SET name = ?1, icon = COALESCE(?2, icon), accent_color = COALESCE(?3, accent_color),
           directory = ?4, updated_at = ?5 WHERE id = ?6",
    )
    .bind(&name)
    .bind(&identity.icon)
    .bind(&identity.color)
    .bind(dir.to_string_lossy().to_string())
    .bind(now_ts())
    .bind(project_id)
    .execute(db)
    .await?;
    crate::knowledge::watcher::resync().await;
    load_project(db, project_id).await
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

/// Element names a drawn icon may use. Shapes and their grouping, nothing that
/// loads, links, embeds or runs.
const SVG_ELEMENTS: &[&str] = &[
    "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs",
    "clipPath", "mask", "use", "title", "desc", "linearGradient", "radialGradient", "stop",
];

/// The `<svg>` element out of a reply, if it is one we are willing to keep.
///
/// The icon is drawn as a CSS mask, where an SVG cannot run anything anyway;
/// this is the second line, for wherever else a stored icon ends up. Anything
/// outside the element allowlist, any event handler, any `javascript:`, any
/// reference that is not to a fragment of itself — refused, not repaired.
pub fn sanitize_svg(raw: &str) -> Option<String> {
    let text = after_thinking(raw);
    let start = text.find("<svg")?;
    let end = text.rfind("</svg>")? + "</svg>".len();
    if end <= start {
        return None;
    }
    let mut svg = text[start..end].trim().to_string();
    if svg.len() > SVG_MAX_BYTES {
        return None;
    }
    let lower = svg.to_ascii_lowercase();
    if lower.contains("javascript:") || lower.contains("<!") || lower.contains("<?") {
        return None;
    }
    let tag = regex::Regex::new(r"<\s*/?\s*([A-Za-z][\w:-]*)").ok()?;
    if tag.captures_iter(&svg).any(|c| !SVG_ELEMENTS.contains(&&c[1])) {
        return None;
    }
    let handler = regex::Regex::new(r#"(?i)\son[a-z]+\s*="#).ok()?;
    if handler.is_match(&svg) {
        return None;
    }
    let href = regex::Regex::new(r#"(?i)href\s*=\s*["']\s*([^"'\s]*)"#).ok()?;
    if href.captures_iter(&svg).any(|c| !c[1].starts_with('#')) {
        return None;
    }
    let url = regex::Regex::new(r#"(?i)url\(\s*['"]?\s*([^)'"\s]*)"#).ok()?;
    if url.captures_iter(&svg).any(|c| !c[1].starts_with('#')) {
        return None;
    }
    // A data URL needs the namespace to render at all, and models leave it off.
    if !svg[..svg.find('>').unwrap_or(svg.len())].contains("xmlns=") {
        svg = svg.replacen("<svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"", 1);
    }
    Some(svg)
}

/// Have the model draw an icon for a project, keep it, and make it the
/// project's icon. One retry: the first drawing is refused often enough
/// (prose around it, a `<text>` element) that a second ask is worth it.
pub async fn draw_icon(
    db: &SqlitePool,
    http: &reqwest::Client,
    project_id: &str,
    chat_id: Option<&str>,
) -> AppResult<Project> {
    let project = load_project(db, project_id).await?;
    let ask = format!(
        "Draw an app icon for a project called \"{}\" as SVG.\n\
         Rules: viewBox=\"0 0 24 24\"; one colour only (black) on a transparent background — it is \
         used as a silhouette and recoloured; bold shapes or 2px strokes that read at 16px; a single \
         clear symbol for the subject, not a scene; no text, no images, no gradients, no filters. \
         Allowed elements: path, circle, ellipse, rect, line, polyline, polygon, g.\n\
         Reply with only the <svg>…</svg> element.",
        project.name
    );
    let mut svg = None;
    for _ in 0..2 {
        let raw = complete(db, http, chat_id, ask.clone(), 2_000).await?;
        svg = sanitize_svg(&raw);
        if svg.is_some() {
            break;
        }
    }
    let svg = svg.ok_or_else(|| AppError::Invalid("the model didn't draw a usable SVG icon".into()))?;
    let id = new_id();
    sqlx::query("INSERT INTO generated_icons (id, name, svg, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(&id)
        .bind(&project.name)
        .bind(&svg)
        .bind(now_ts())
        .execute(db)
        .await?;
    sqlx::query("UPDATE projects SET icon = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(format!("{GENERATED_PREFIX}{id}"))
        .bind(now_ts())
        .bind(project_id)
        .execute(db)
        .await?;
    load_project(db, project_id).await
}

pub async fn list_icons(db: &SqlitePool) -> AppResult<Vec<GeneratedIcon>> {
    Ok(sqlx::query_as::<_, GeneratedIcon>(
        "SELECT id, name, svg, created_at FROM generated_icons ORDER BY created_at DESC",
    )
    .fetch_all(db)
    .await?)
}

/// Delete a drawn icon. Whatever wore it goes back to the default icon rather
/// than pointing at nothing.
pub async fn delete_icon(db: &SqlitePool, id: &str) -> AppResult<()> {
    let stored = format!("{GENERATED_PREFIX}{id}");
    sqlx::query("UPDATE projects SET icon = NULL WHERE icon = ?1").bind(&stored).execute(db).await?;
    sqlx::query("UPDATE zones SET icon = NULL WHERE icon = ?1").bind(&stored).execute(db).await?;
    sqlx::query("DELETE FROM generated_icons WHERE id = ?1").bind(id).execute(db).await?;
    Ok(())
}

// ─── Sources ─────────────────────────────────────────────────────────────────

/// Copy files into a project's folder — making one under the save directory
/// if it has none — and index the folder. Returns how many files were copied.
/// A name already taken in the folder gets " (2)" rather than overwriting.
pub async fn add_sources(
    db: &SqlitePool,
    http: &reqwest::Client,
    app: &tauri::AppHandle,
    project_id: &str,
    paths: &[String],
) -> AppResult<usize> {
    let project = load_project(db, project_id).await?;
    let dir = match project.directory.as_deref().filter(|d| !d.trim().is_empty()) {
        Some(d) => PathBuf::from(d),
        None => {
            let dir = unique_dir(&projects_root(db, app).await?, &project.name);
            sqlx::query("UPDATE projects SET directory = ?1, updated_at = ?2 WHERE id = ?3")
                .bind(dir.to_string_lossy().to_string())
                .bind(now_ts())
                .bind(project_id)
                .execute(db)
                .await?;
            dir
        }
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Invalid(format!("couldn't create {}: {e}", dir.display())))?;

    let mut copied = 0;
    for p in paths {
        let src = PathBuf::from(p);
        let Some(file_name) = src.file_name() else { continue };
        if !src.is_file() {
            continue;
        }
        let mut dest = dir.join(file_name);
        if dest == src {
            continue;
        }
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let mut n = 2;
        while dest.exists() {
            dest = dir.join(format!("{stem} ({n}){ext}"));
            n += 1;
        }
        std::fs::copy(&src, &dest)
            .map_err(|e| AppError::Invalid(format!("couldn't copy {}: {e}", src.display())))?;
        copied += 1;
    }

    // Embedding needs a provider and model; a project made before one was set
    // up globally has neither, and inherits them now if they exist.
    if project.kb_provider_id.is_none() || project.kb_embedding_model.is_none() {
        let (provider, model) = crate::knowledge::default_embedding_config(db).await;
        if provider.is_some() && model.is_some() {
            sqlx::query("UPDATE projects SET kb_provider_id = ?1, kb_embedding_model = ?2 WHERE id = ?3")
                .bind(&provider)
                .bind(&model)
                .bind(project_id)
                .execute(db)
                .await?;
        } else {
            return Err(AppError::Invalid(
                "Copied, but not indexed: choose an embedding model in Settings → Knowledge first.".into(),
            ));
        }
    }
    crate::knowledge::index_project(db, http, project_id).await?;
    crate::knowledge::watcher::resync().await;
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn identity_keeps_only_offered_icons_and_colours() {
        let icons = s(&["BookOpen", "Brain"]);
        let colors = s(&["#3b82f6"]);
        let id = parse_identity(
            "<think>hmm</think>Sure: {\"name\": \"Signals and Systems.\", \"icon\": \"bookopen\", \"color\": \"#ff00ff\"}",
            &icons,
            &colors,
        );
        assert_eq!(id.name.as_deref(), Some("Signals and Systems"));
        assert_eq!(id.icon.as_deref(), Some("BookOpen"));
        assert_eq!(id.color, None, "a colour that was not offered is dropped");
        assert_eq!(parse_identity("no json here", &icons, &colors), Identity::default());
    }

    #[test]
    fn fallback_and_folder_names_are_usable() {
        assert_eq!(fallback_name("help me learn   laplace transforms for my exam", false), "Help me learn laplace transforms");
        assert_eq!(fallback_name("  ", true), "Study project");
        assert_eq!(folder_name("C++: a/b? notes."), "C++ a b notes");
        assert_eq!(folder_name("..."), "Project");
    }

    #[test]
    fn a_plain_icon_is_kept_and_given_its_namespace() {
        let out = sanitize_svg("Here you go:\n<svg viewBox=\"0 0 24 24\"><path d=\"M2 2h20v20H2z\"/></svg>\nDone.").unwrap();
        assert!(out.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(out.ends_with("</svg>"));
    }

    #[test]
    fn anything_that_could_run_or_load_is_refused() {
        for bad in [
            "<svg><script>alert(1)</script></svg>",
            "<svg onload=\"x()\"><path d=\"\"/></svg>",
            "<svg><foreignObject><div/></foreignObject></svg>",
            "<svg><image href=\"http://x/y.png\"/></svg>",
            "<svg><use href=\"http://x/y.svg#a\"/></svg>",
            "<svg><path style=\"fill:url(http://x)\"/></svg>",
            "<svg><a href=\"javascript:x()\"><path/></a></svg>",
            "<svg><text>hi</text></svg>",
            "no svg at all",
        ] {
            assert!(sanitize_svg(bad).is_none(), "kept: {bad}");
        }
        assert!(sanitize_svg("<svg><defs><clipPath id=\"c\"/></defs><use href=\"#c\"/></svg>").is_some());
    }
}
