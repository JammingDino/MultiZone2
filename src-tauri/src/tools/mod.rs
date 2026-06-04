pub mod datetime;
pub mod web_search;
pub mod code_exec;
pub mod filesystem;
pub mod render_graph;
pub mod ask_user;
pub mod tags;

use crate::error::AppResult;
use crate::llm::types::Tool;
use serde_json::Value;
use sqlx::SqlitePool;

/// Theme palette resolved from the user's settings at request time. Currently
/// only consumed by `render_graph` so the model can pick colors readable
/// against the active background, but every tool gets it via [`ToolContext`].
#[derive(Debug, Clone)]
pub struct ThemePalette {
    pub mode: &'static str,
    pub background: &'static str,
    pub panel: &'static str,
    pub text: &'static str,
    pub accent: String,
}

impl ThemePalette {
    pub fn dark(accent: String) -> Self {
        Self {
            mode: "dark",
            background: "#0b0d10",
            panel: "#14171c",
            text: "#e4e6eb",
            accent,
        }
    }

    pub fn light(accent: String) -> Self {
        Self {
            mode: "light",
            background: "#fafafa",
            panel: "#ffffff",
            text: "#1f2329",
            accent,
        }
    }

    /// Parse `{"mode":"dark|light","accent":"#xxxxxx"}` as persisted by the
    /// frontend theme store. Falls back to dark on any error.
    pub fn from_settings_json(raw: Option<&str>) -> Self {
        let v: Value = raw
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null);
        let mode = v.get("mode").and_then(|m| m.as_str()).unwrap_or("dark");
        let accent = v
            .get("accent")
            .and_then(|a| a.as_str())
            .unwrap_or("#4f9cf9")
            .to_string();
        match mode {
            "light" => Self::light(accent),
            _ => Self::dark(accent),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolContext {
    pub theme: ThemePalette,
}

impl Default for ToolContext {
    fn default() -> Self {
        Self {
            theme: ThemePalette::dark("#4f9cf9".to_string()),
        }
    }
}

/// Identifier for a tool that can be enabled per-zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolId {
    DateTime,
    WebSearch,
    CodeExec,
    FileSystem,
    RenderGraph,
    AskUser,
    ManageTags,
}

impl ToolId {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "date_time" => Some(Self::DateTime),
            "web_search" => Some(Self::WebSearch),
            "code_exec" => Some(Self::CodeExec),
            "file_system" => Some(Self::FileSystem),
            "render_graph" => Some(Self::RenderGraph),
            "ask_user" => Some(Self::AskUser),
            "manage_tags" => Some(Self::ManageTags),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::DateTime => "date_time",
            Self::WebSearch => "web_search",
            Self::CodeExec => "code_exec",
            Self::FileSystem => "file_system",
            Self::RenderGraph => "render_graph",
            Self::AskUser => "ask_user",
            Self::ManageTags => "manage_tags",
        }
    }

    /// Build the JSON-schema tool definition for the OpenAI API. Tools that
    /// vary with the user's theme or other request-time state read it from
    /// `ctx`; the rest ignore it.
    pub fn definitions(self, ctx: &ToolContext) -> Vec<Tool> {
        match self {
            Self::DateTime => vec![datetime::definition()],
            Self::WebSearch => vec![web_search::definition()],
            Self::CodeExec => vec![code_exec::definition()],
            Self::FileSystem => filesystem::definitions(),
            Self::RenderGraph => render_graph::definitions(ctx),
            Self::AskUser => vec![ask_user::definition()],
            Self::ManageTags => vec![tags::definition()],
        }
    }
}

/// Dispatch a tool call by name to the appropriate handler. `db` and `chat_id`
/// are only used by tools that touch app state (currently `tag_chat`).
pub async fn dispatch(
    name: &str,
    arguments: &str,
    zone_config: &Value,
    db: &SqlitePool,
    chat_id: &str,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let args: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
    match name {
        "get_current_datetime" => datetime::run(&args).await,
        "web_search" => web_search::run(&args, zone_config).await,
        "execute_code" => code_exec::run(&args, zone_config).await,
        "read_file" => filesystem::read_file(&args, zone_config, project_dir).await,
        "list_directory" => filesystem::list_directory(&args, zone_config, project_dir).await,
        "plot_function" => render_graph::plot(&args).await,
        "draw_diagram" => render_graph::draw(&args).await,
        "ask_user" => ask_user::run(&args).await,
        "tag_chat" => tags::run(&args, db, chat_id).await,
        other => Ok(serde_json::json!({
            "error": format!("unknown tool: {other}")
        }).to_string()),
    }
}
