pub mod datetime;
pub mod web_search;
pub mod extract;
pub mod code_exec;
pub mod filesystem;
pub mod render_graph;
pub mod ask_user;
pub mod tags;
pub mod zone;
pub mod shell;
pub mod memory;
pub mod skills;
pub mod knowledge;
pub mod subchat;
pub mod plan;
pub mod http;

use crate::commands::messages::{EngineCtx, StreamSink};
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
    Extract,
    CodeExec,
    FileSystem,
    RenderGraph,
    AskUser,
    ManageTags,
    SwitchZone,
    Shell,
    Memory,
    Skills,
    Subchat,
    PresentFile,
    /// 0.9.1 — move/rename, copy, delete, create folder.
    FileManage,
    /// 0.9.1 — find_files (by name) + search_file_text (by content).
    FileSearch,
    /// 0.9.3 — the model's own multi-step checklist.
    Plan,
    /// 0.9.3 — general HTTP call (API access), distinct from `extract`'s page read.
    HttpRequest,
}

impl ToolId {
    /// Parse a zone's stored tool id. Renamed tools keep their old id resolving
    /// here — a zone's `tools_enabled` array and the curated presets are stored
    /// data we don't get to migrate everywhere, so every rename adds an alias
    /// rather than breaking zones that predate it.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "date_time" => Some(Self::DateTime),
            "web_search" => Some(Self::WebSearch),
            "extract" => Some(Self::Extract),
            "code_exec" => Some(Self::CodeExec),
            "file_system" => Some(Self::FileSystem),
            "render_graph" => Some(Self::RenderGraph),
            "ask_user" => Some(Self::AskUser),
            "manage_tags" => Some(Self::ManageTags),
            "switch_zone" => Some(Self::SwitchZone),
            "shell_exec" => Some(Self::Shell),
            "memory" => Some(Self::Memory),
            "skills" => Some(Self::Skills),
            "subchat" => Some(Self::Subchat),
            "file_manage" => Some(Self::FileManage),
            "file_search" => Some(Self::FileSearch),
            "plan" => Some(Self::Plan),
            "http_request" => Some(Self::HttpRequest),
            // `save_output` is the legacy id for this group (briefly shipped as a
            // write+present tool); it now maps to the present-only tool.
            "present_file" | "save_output" => Some(Self::PresentFile),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::DateTime => "date_time",
            Self::WebSearch => "web_search",
            Self::Extract => "extract",
            Self::CodeExec => "code_exec",
            Self::FileSystem => "file_system",
            Self::RenderGraph => "render_graph",
            Self::AskUser => "ask_user",
            Self::ManageTags => "manage_tags",
            Self::SwitchZone => "switch_zone",
            Self::Shell => "shell_exec",
            Self::Memory => "memory",
            Self::Skills => "skills",
            Self::Subchat => "subchat",
            Self::PresentFile => "present_file",
            Self::FileManage => "file_manage",
            Self::FileSearch => "file_search",
            Self::Plan => "plan",
            Self::HttpRequest => "http_request",
        }
    }

    /// Build the JSON-schema tool definition for the OpenAI API. Tools that
    /// vary with the user's theme or other request-time state read it from
    /// `ctx`; the rest ignore it.
    pub fn definitions(self, ctx: &ToolContext) -> Vec<Tool> {
        match self {
            Self::DateTime => vec![datetime::definition()],
            Self::WebSearch => vec![web_search::definition()],
            Self::Extract => vec![extract::definition()],
            Self::CodeExec => vec![code_exec::definition()],
            Self::FileSystem => filesystem::definitions(),
            Self::RenderGraph => render_graph::definitions(ctx),
            Self::AskUser => vec![ask_user::definition()],
            Self::ManageTags => vec![tags::definition()],
            Self::SwitchZone => zone::definitions(),
            Self::Shell => vec![shell::definition()],
            Self::Memory => memory::definitions(),
            // The skills group is load + author: `load_skill` reads the catalog,
            // `create_skill` / `update_skill` write to it (0.9.2).
            Self::Skills => {
                let mut defs = vec![skills::definition()];
                defs.extend(skills::authoring_definitions());
                defs
            }
            Self::Subchat => subchat::definitions(),
            Self::PresentFile => filesystem::present_file_definitions(),
            Self::FileManage => filesystem::manage_definitions(),
            Self::FileSearch => filesystem::search_definitions(),
            Self::Plan => vec![plan::definition()],
            Self::HttpRequest => vec![http::definition()],
        }
    }

    /// Safety classification: 0 = safe, 1 = moderate, 2 = dangerous.
    pub fn safety_level(self) -> u8 {
        match self {
            // PresentFile only surfaces an existing file inline — read-only, no writes.
            // Plan is pure bookkeeping. Skills groups load + create (safe: a created
            // skill is disabled until the user enables it) with update (moderate) —
            // per-call gating by name keeps the group in the safe default set while
            // still prompting before an agent rewrites an existing skill.
            Self::DateTime | Self::AskUser | Self::ManageTags | Self::RenderGraph
            | Self::Memory | Self::Skills | Self::PresentFile | Self::Plan => 0,
            // Subchat groups read (safe) + spawn/send (moderate); classed moderate
            // here so it isn't in the safe default set. Per-call gating uses the
            // function name (see `tool_safety_by_name`). FileSearch reads file
            // contents, so it is gated like the other file reads rather than as safe.
            Self::WebSearch | Self::Extract | Self::FileSystem | Self::FileSearch
            | Self::SwitchZone | Self::Subchat => 1,
            // FileManage contains `delete_file`; the group is dangerous so it never
            // lands in a default toolset, and per-call gating keeps move/copy at
            // moderate while every delete prompts.
            // HttpRequest can send data off the machine and mutate remote state;
            // the approval prompt is its security boundary (see http.rs).
            Self::CodeExec | Self::Shell | Self::FileManage | Self::HttpRequest => 2,
        }
    }
}

/// Tool ids classified as "safe" (safety level 0). Used as the default toolset
/// for quick/simple chats so the default model is useful out of the box without
/// exposing anything that needs approval.
pub fn safe_tool_ids() -> Vec<&'static str> {
    [
        ToolId::DateTime,
        ToolId::WebSearch,
        ToolId::Extract,
        ToolId::CodeExec,
        ToolId::FileSystem,
        ToolId::RenderGraph,
        ToolId::AskUser,
        ToolId::ManageTags,
        ToolId::SwitchZone,
        ToolId::Shell,
        ToolId::Memory,
        ToolId::Skills,
        ToolId::Plan,
    ]
    .into_iter()
    .filter(|t| t.safety_level() == 0)
    .map(ToolId::as_str)
    .collect()
}

/// Map a raw tool function name to its safety level.
/// 0 = safe, 1 = moderate, 2 = dangerous.
pub fn tool_safety_by_name(name: &str) -> u8 {
    match name {
        "get_current_datetime" | "ask_user" | "tag_chat"
        | "plot_function" | "draw_diagram"
        | "save_memory" | "read_memory" | "delete_memory"
        | "load_skill" | "read_subchat"
        | "present_file" | "update_plan"
        // A created skill is disabled until the user enables it, so writing one
        // changes nothing an agent can act on — safe. Revising an existing skill
        // does, so `update_skill` is moderate below.
        | "create_skill"
        // `search_knowledge` is the pre-0.9.0 name for `search_local_files`;
        // stored tool-call history still carries it.
        | "search_local_files" | "search_knowledge" => 0,
        "web_search" | "extract_url" | "read_file" | "list_directory"
        | "create_file" | "edit_file" | "list_zones" | "change_zone"
        | "spawn_subagent" | "send_subchat_message"
        | "update_skill"
        | "find_files" | "search_file_text"
        | "move_file" | "copy_file" | "create_folder" => 1,
        "execute_code" | "run_command" | "delete_file" | "http_request" => 2,
        _ => 1,
    }
}

/// Dispatch a tool call by name to the appropriate handler. `db` and `chat_id`
/// are only used by tools that touch app state (e.g. `tag_chat`). `ctx`, `sink`
/// and `caller_zone_id` are used by the subchat tools, which run nested turns.
pub async fn dispatch(
    name: &str,
    arguments: &str,
    zone_config: &Value,
    db: &SqlitePool,
    chat_id: &str,
    project_dir: Option<&str>,
    http: &reqwest::Client,
    ctx: &EngineCtx,
    sink: &StreamSink,
    caller_zone_id: Option<&str>,
) -> AppResult<String> {
    let args: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);

    // MCP tools (`mcp__<server>__<tool>`) route through the global MCP manager,
    // which connects lazily and forwards `tools/call`.
    if crate::mcp::is_mcp_tool(name) {
        let call_args = if args.is_null() {
            Value::Object(Default::default())
        } else {
            args
        };
        return crate::mcp::manager().call(name, call_args).await;
    }

    match name {
        "get_current_datetime" => datetime::run(&args).await,
        "web_search" => web_search::run(&args, zone_config, http).await,
        "extract_url" => extract::run(&args, http).await,
        "execute_code" => code_exec::run(&args, zone_config).await,
        "read_file" => filesystem::read_file(&args, zone_config, project_dir).await,
        "list_directory" => filesystem::list_directory(&args, zone_config, project_dir).await,
        "create_file" => filesystem::create_file(&args, zone_config, project_dir).await,
        "edit_file" => filesystem::edit_file(&args, zone_config, project_dir).await,
        "present_file" => filesystem::present_file(&args, project_dir).await,
        "plot_function" => render_graph::plot(&args).await,
        "draw_diagram" => render_graph::draw(&args).await,
        "ask_user" => ask_user::run(&args).await,
        "tag_chat" => tags::run(&args, db, chat_id).await,
        "list_zones" => zone::list_zones(db).await,
        "change_zone" => zone::change_zone(&args, db, chat_id).await,
        "run_command" => shell::run(&args, zone_config, project_dir).await,
        "save_memory" => memory::save(&args, db, chat_id).await,
        "read_memory" => memory::read(&args, db, chat_id).await,
        "delete_memory" => memory::delete(&args, db).await,
        "load_skill" => skills::run(&args, db).await,
        "create_skill" => skills::create(&args, db, caller_zone_id).await,
        "update_skill" => skills::update(&args, db).await,
        // `search_knowledge` is the pre-0.9.0 name; kept so a zone or a replayed
        // tool call written before the rename still dispatches.
        "search_local_files" | "search_knowledge" => knowledge::run(&args, db, chat_id, http).await,
        "move_file" => filesystem::move_file(&args, zone_config, project_dir).await,
        "copy_file" => filesystem::copy_file(&args, zone_config, project_dir).await,
        "delete_file" => filesystem::delete_file(&args, zone_config, project_dir).await,
        "create_folder" => filesystem::create_folder(&args, zone_config, project_dir).await,
        "find_files" => filesystem::find_files(&args, zone_config, project_dir).await,
        "search_file_text" => filesystem::search_file_text(&args, zone_config, project_dir).await,
        "update_plan" => plan::run(&args).await,
        "http_request" => http::run(&args, http).await,
        "spawn_subagent" => subchat::spawn(&args, ctx, sink, caller_zone_id, chat_id).await,
        "send_subchat_message" => subchat::send(&args, ctx, sink).await,
        "read_subchat" => subchat::read(&args, db).await,
        other => Ok(serde_json::json!({
            "error": format!("unknown tool: {other}")
        }).to_string()),
    }
}
