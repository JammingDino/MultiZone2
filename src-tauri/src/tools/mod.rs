pub mod datetime;
pub mod web_search;
pub mod extract;
// Hound-based searching tools — https://github.com/dondai1234/master-fetch
pub mod web_util;
pub mod smart_search;
pub mod smart_fetch;
pub mod smart_crawl;
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
pub mod teamwork;
pub mod plan;
pub mod http;
pub mod citations;
pub mod compact;
pub mod wsl;
pub mod terminal;

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
    /// The chat's working directory, when it has one. The file tools name it in
    /// their descriptions so the model writes a path that resolves on the first
    /// try instead of learning the shape from a scope error.
    pub project_dir: Option<String>,
}

impl Default for ToolContext {
    fn default() -> Self {
        Self {
            theme: ThemePalette::dark("#4f9cf9".to_string()),
            project_dir: None,
        }
    }
}

/// Identifier for a tool that can be enabled per-zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolId {
    DateTime,
    WebSearch,
    Extract,
    /// Hound-based multi-engine keyless search (https://github.com/dondai1234/master-fetch).
    SmartSearch,
    /// Hound-based HTTP-first page/PDF reader.
    SmartFetch,
    /// Hound-based shallow same-site crawl.
    SmartCrawl,
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
    /// 0.9.3 — the model summarizes its own older turns when a chat grows long.
    Compact,
    /// 0.9.5 — run Linux commands in WSL, optionally in a shell that persists
    /// across calls so multi-step work can build up state.
    Wsl,
    /// 0.9.10 — file claims and a shared note board, so several sub-agents can
    /// edit one working tree at the same time without overwriting each other.
    Teamwork,
    /// 0.9.11 — terminals that keep running between calls, so an agent can start
    /// a server or a REPL and go on typing into it.
    Terminal,
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
            "smart_search" => Some(Self::SmartSearch),
            "smart_fetch" => Some(Self::SmartFetch),
            "smart_crawl" => Some(Self::SmartCrawl),
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
            "compact" => Some(Self::Compact),
            "wsl_exec" => Some(Self::Wsl),
            "teamwork" => Some(Self::Teamwork),
            "terminal" => Some(Self::Terminal),
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
            Self::SmartSearch => "smart_search",
            Self::SmartFetch => "smart_fetch",
            Self::SmartCrawl => "smart_crawl",
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
            Self::Compact => "compact",
            Self::Wsl => "wsl_exec",
            Self::Teamwork => "teamwork",
            Self::Terminal => "terminal",
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
            Self::SmartSearch => vec![smart_search::definition()],
            Self::SmartFetch => vec![smart_fetch::definition()],
            Self::SmartCrawl => vec![smart_crawl::definition()],
            Self::CodeExec => vec![code_exec::definition()],
            Self::FileSystem => filesystem::definitions(ctx.project_dir.as_deref()),
            Self::RenderGraph => render_graph::definitions(ctx),
            Self::AskUser => vec![ask_user::definition()],
            Self::ManageTags => vec![tags::definition()],
            Self::SwitchZone => zone::definitions(),
            Self::Shell => vec![shell::definition()],
            Self::Wsl => vec![wsl::definition()],
            Self::Memory => memory::definitions(),
            // The skills group is load + author: `load_skill` reads the catalog,
            // `create_skill` / `update_skill` write to it (0.9.2).
            Self::Skills => {
                let mut defs = vec![skills::definition()];
                defs.extend(skills::authoring_definitions());
                defs
            }
            Self::Subchat => subchat::definitions(),
            Self::PresentFile => filesystem::present_file_definitions(ctx.project_dir.as_deref()),
            Self::FileManage => filesystem::manage_definitions(ctx.project_dir.as_deref()),
            Self::FileSearch => filesystem::search_definitions(ctx.project_dir.as_deref()),
            Self::Plan => vec![plan::definition()],
            Self::HttpRequest => vec![http::definition()],
            Self::Compact => vec![compact::definition()],
            Self::Teamwork => teamwork::definitions(),
            Self::Terminal => terminal::definitions(),
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
            // Teamwork only writes coordination metadata — claims and notes the
            // other agents read. Nothing it does reaches the user's files.
            Self::DateTime | Self::AskUser | Self::ManageTags | Self::RenderGraph
            | Self::Memory | Self::Skills | Self::PresentFile | Self::Plan
            | Self::Teamwork => 0,
            // Subchat groups reads (read/list/collect: safe) + spawn/send (moderate); classed moderate
            // here so it isn't in the safe default set. Per-call gating uses the
            // function name (see `tool_safety_by_name`). FileSearch reads file
            // contents, so it is gated like the other file reads rather than as safe.
            // Compact is a lossy rewrite of what the model can see, so the user
            // approves it rather than having it happen behind their back.
            // The smart_* web tools read the network like web_search/extract do —
            // moderate, so they're not in the safe default set but need no per-call
            // approval once a zone enables them.
            Self::WebSearch | Self::Extract | Self::SmartSearch | Self::SmartFetch
            | Self::SmartCrawl | Self::FileSystem | Self::FileSearch
            | Self::SwitchZone | Self::Subchat | Self::Compact => 1,
            // FileManage contains `delete_file`; the group is dangerous so it never
            // lands in a default toolset, and per-call gating keeps move/copy at
            // moderate while every delete prompts.
            // HttpRequest can send data off the machine and mutate remote state;
            // the approval prompt is its security boundary (see http.rs).
            // Terminal groups reads (read/list: safe) with start/write, which run
            // and drive arbitrary programs; the group is dangerous so it never
            // lands in a default toolset, and per-call gating keeps watching a
            // terminal cheap while starting or typing into one prompts.
            Self::CodeExec | Self::Shell | Self::FileManage | Self::HttpRequest | Self::Wsl
            | Self::Terminal => 2,
        }
    }
}

/// Every built-in tool group. The single source of truth for enumerating tools
/// (e.g. `list_tool_functions`, which flattens each group into the functions the
/// model actually sees). Keep in step with the `ToolId` variants.
pub const ALL_TOOL_IDS: [ToolId; 24] = [
    ToolId::DateTime,
    ToolId::WebSearch,
    ToolId::Extract,
    ToolId::SmartSearch,
    ToolId::SmartFetch,
    ToolId::SmartCrawl,
    ToolId::HttpRequest,
    ToolId::CodeExec,
    ToolId::FileSystem,
    ToolId::FileSearch,
    ToolId::FileManage,
    ToolId::PresentFile,
    ToolId::RenderGraph,
    ToolId::AskUser,
    ToolId::ManageTags,
    ToolId::SwitchZone,
    ToolId::Shell,
    ToolId::Memory,
    ToolId::Skills,
    ToolId::Compact,
    ToolId::Plan,
    ToolId::Subchat,
    ToolId::Teamwork,
    ToolId::Terminal,
];

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
        // Reading a subchat, listing the ones a chat already has, and waiting on
        // background subagents are all reads of work the user already approved
        // when the spawn went through.
        | "load_skill" | "read_subchat" | "list_subchats" | "collect_subagents"
        | "team_status" | "claim_files" | "release_files" | "post_note"
        // Watching a terminal someone already approved starting is a read.
        | "terminal_read" | "terminal_list"
        | "present_file" | "update_plan"
        // A created skill is disabled until the user enables it, so writing one
        // changes nothing an agent can act on — safe. Revising an existing skill
        // does, so `update_skill` is moderate below.
        | "create_skill"
        // `search_knowledge` is the pre-0.9.0 name for `search_local_files`;
        // stored tool-call history still carries it.
        | "search_local_files" | "search_knowledge" => 0,
        "web_search" | "extract_url"
        | "smart_search" | "smart_fetch" | "smart_crawl"
        | "read_file" | "list_directory"
        | "create_file" | "edit_file" | "list_zones" | "change_zone"
        | "spawn_subagent" | "send_subchat_message"
        | "update_skill"
        | "find_files" | "search_file_text"
        | "move_file" | "copy_file" | "create_folder"
        | "compact_context"
        | "terminal_stop" => 1,
        "execute_code" | "run_command" | "delete_file" | "http_request"
        | "terminal_start" | "terminal_write" => 2,
        _ => 1,
    }
}

/// Every tool function the model can be shown, with the JSON size of its
/// definition. The tool list is rendered before the system prompt and the
/// conversation on every single request, so it is the one part of the context
/// the user never sees and always pays for.
///
/// Test-only: this measures the whole built-in surface, which is a budget check
/// rather than anything a request needs. `#[cfg(test)]` keeps it from being dead
/// code in the shipped build — a warning on every compile is a warning nobody
/// reads.
#[cfg(test)]
pub fn definition_sizes(ctx: &ToolContext) -> Vec<(&'static str, usize)> {
    let mut out = Vec::new();
    for id in ALL_TOOL_IDS {
        for def in id.definitions(ctx) {
            let bytes = serde_json::to_string(&def).map(|s| s.len()).unwrap_or(0);
            out.push((id.as_str(), bytes));
        }
    }
    out
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

    // Multi-agent write coordination (0.9.10). In a session that has sub-agents,
    // a write to a file another agent is editing is refused instead of silently
    // clobbering it, and an unclaimed write takes an implicit claim so the writer
    // is protected in turn. A no-op for an ordinary single-zone chat.
    if let Some(refusal) =
        teamwork::guard_write(name, &args, db, chat_id, caller_zone_id, project_dir).await?
    {
        return Ok(refusal);
    }

    match name {
        "get_current_datetime" => datetime::run(&args).await,
        "web_search" => web_search::run(&args, zone_config, http).await,
        "extract_url" => extract::run(&args, http).await,
        "smart_search" => smart_search::run(&args).await,
        "smart_fetch" => smart_fetch::run(&args).await,
        "smart_crawl" => smart_crawl::run(&args).await,
        "execute_code" => code_exec::run(&args, zone_config).await,
        // `sink` carries the window handle: a PDF's pages are rasterized by the
        // frontend's PDF.js (see `pdf_bridge`).
        "read_file" => filesystem::read_file(&args, zone_config, project_dir, sink).await,
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
        "wsl_exec" => wsl::run(&args, chat_id).await,
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
        "compact_context" => compact::run(&args, db, chat_id).await,
        "spawn_subagent" => subchat::spawn(&args, ctx, sink, caller_zone_id, chat_id).await,
        "send_subchat_message" => subchat::send(&args, ctx, sink).await,
        "collect_subagents" => subchat::collect(&args, db, chat_id).await,
        "list_subchats" => subchat::list(db, chat_id).await,
        "read_subchat" => subchat::read(&args, db).await,
        "terminal_start" => terminal::start(&args, db, chat_id, project_dir).await,
        "terminal_write" => terminal::write(&args, db, chat_id).await,
        "terminal_read" => terminal::read(&args, db, chat_id).await,
        "terminal_list" => terminal::list(db, chat_id).await,
        "terminal_stop" => terminal::stop(&args, db, chat_id).await,
        "team_status" => teamwork::status(db, chat_id).await,
        "claim_files" => teamwork::claim(&args, db, chat_id, caller_zone_id, project_dir).await,
        "release_files" => teamwork::release(&args, db, chat_id, caller_zone_id, project_dir).await,
        "post_note" => teamwork::note(&args, db, chat_id, caller_zone_id).await,
        other => Ok(serde_json::json!({
            "error": format!("unknown tool: {other}")
        }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A budget on the size of the tool definitions themselves.
    ///
    /// Tool schemas are rendered ahead of the system prompt and the whole
    /// conversation on every request, so every word in a description is billed
    /// on every turn, forever, whether or not the tool is used. Descriptions
    /// still have to earn their length — the guidance that holds up is to say
    /// *when* to call a tool, not to restate what its own schema already says —
    /// but "explain it thoroughly" has no natural stopping point, and a
    /// description only ever grows. This test is the stopping point.
    ///
    /// If it fails, first look for prose that repeats the parameter schema, or
    /// the same paragraph pasted into several tools in a group; that is almost
    /// always where the growth is. Raising the ceiling is a legitimate outcome —
    /// deliberately, not by reflex.
    #[test]
    fn toolset_is_concise() {
        // The full built-in surface. No real zone enables all of it at once, so
        // this is the worst case rather than a typical request — a zone in the
        // Code Team enables six of the twenty-three groups.
        //
        // Measured at 39,165 bytes before the 0.9.10 pass and 30,348 after. The
        // multi-agent work took it to 34,411 across six new *functions*
        // (`collect_subagents`, `list_subchats`, and the four coordination tools),
        // at ~600 bytes each — in line with the existing surface rather than a
        // re-inflation of it, and none of them lands in the top five.
        //
        // 0.9.11 adds the five `terminal_*` functions, taking it to 38,093. Three
        // of them carry the same `wait_for`/`timeout_ms`/`wait_ms` block, which is
        // repetition of the kind this test exists to catch — but the timing
        // vocabulary is the whole point of the group, and a model that only sees
        // it on one function will reach for that function. Shared verbatim from
        // one helper so it cannot drift into three explanations of one thing.
        //
        // The first draft of the group came in at 4,380 bytes and put `terminal`
        // in the top five; trimmed to 3,682, it is back in line with the rest of
        // the surface. The ceiling is raised for the new capabilities and no
        // further — under a kilobyte of slack, which is a rounding error against
        // one tool, not room to grow the descriptions.
        const BUDGET_BYTES: usize = 39_000;

        let ctx = ToolContext {
            project_dir: Some(r"C:\Users\me\project".to_string()),
            ..Default::default()
        };
        let sizes = definition_sizes(&ctx);
        let total: usize = sizes.iter().map(|(_, n)| n).sum();

        let mut report: Vec<_> = sizes.clone();
        report.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        let worst: Vec<String> = report
            .iter()
            .take(5)
            .map(|(id, n)| format!("{id}={n}B"))
            .collect();

        eprintln!(
            "tool definitions: {total} bytes across {} functions (budget {BUDGET_BYTES}). \
             Largest: {}",
            sizes.len(),
            worst.join(", "),
        );

        assert!(
            total <= BUDGET_BYTES,
            "tool definitions total {total} bytes across {} functions, over the \
             {BUDGET_BYTES} byte budget. Largest: {}",
            sizes.len(),
            worst.join(", "),
        );
    }

    /// The filesystem group takes the working directory and names it so the
    /// model writes a path that resolves first time. That hint used to be
    /// pasted into both the tool description *and* every `path` parameter, so
    /// it shipped twice per tool and ~19 times across the four file groups.
    /// Once per tool is enough to steer the model; more than that is rent.
    #[test]
    fn path_hint_appears_once_per_file_tool() {
        let ctx = ToolContext {
            project_dir: Some(r"C:\Users\me\project".to_string()),
            ..Default::default()
        };

        for group in [
            ToolId::FileSystem,
            ToolId::FileManage,
            ToolId::FileSearch,
            ToolId::PresentFile,
        ] {
            for def in group.definitions(&ctx) {
                let json = serde_json::to_string(&def).unwrap();
                // The hint is the only place the working directory is spelled
                // out, so counting it counts the hint.
                let occurrences = json.matches("PATHS:").count();
                assert!(
                    occurrences <= 1,
                    "{} repeats the path hint {occurrences} times",
                    def.function.name,
                );
            }
        }
    }
}
