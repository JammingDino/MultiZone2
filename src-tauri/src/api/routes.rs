//! The route table, and the handlers that fill it (0.11.0).
//!
//! Two problems this file exists to solve, both consequences of the API having
//! been written once — alongside subchats — and never revisited:
//!
//! - **Drift.** Every release since added Tauri commands and no routes, and
//!   nothing failed when it did. [`COVERAGE`] pairs every command with either
//!   the route that reaches it or an explicit reason it is GUI-only, and a test
//!   checks the pairing against `lib.rs` and against [`ROUTES`]. Adding a
//!   command without deciding either way is now a build failure.
//! - **Duplication.** Handlers call the Tauri command functions rather than
//!   re-implementing them in SQL. `AppHandle::state()` hands back the same
//!   managed `AppState` the GUI uses, so a route and a button cannot behave
//!   differently — which is the other way an API rots.
//!
//! [`ROUTES`] is also served as `GET /api/routes`, so the surface is
//! discoverable without reading Rust and the README's table cannot silently
//! disagree with the app.

use super::{ApiError, ApiResult, ApiState};
use crate::commands;
use crate::state::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

/// One route, as `GET /api/routes` reports it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RouteDef {
    pub method: &'static str,
    pub path: &'static str,
    /// One line, written for someone who has never read this file.
    pub description: &'static str,
    /// False only for `/api/health` and `/api/routes`, which have to be
    /// answerable by a caller who is trying to work out why nothing else is.
    pub auth: bool,
}

const fn r(method: &'static str, path: &'static str, description: &'static str) -> RouteDef {
    RouteDef { method, path, description, auth: true }
}

const fn open(method: &'static str, path: &'static str, description: &'static str) -> RouteDef {
    RouteDef { method, path, description, auth: false }
}

/// Bumped whenever a route is added, removed or changes shape, so a caller can
/// tell "the app is older than my script" from "my script is wrong".
pub const ROUTE_SET_VERSION: u32 = 5;

pub const ROUTES: &[RouteDef] = &[
    // Discovery — deliberately unauthenticated. A caller debugging a broken
    // setup cannot be asked to authenticate to find out that its token is the
    // thing that is wrong.
    open("GET", "/api/health", "Whether the API is enabled, bound, answering, and whether your token was accepted"),
    open("GET", "/api/routes", "Every route this build serves, with a one-line description"),

    // Providers & zones
    r("GET", "/api/providers", "Configured model providers"),
    r("POST", "/api/providers", "Create or update a provider"),
    r("DELETE", "/api/providers/:id", "Delete a provider"),
    r("GET", "/api/providers/:id/models", "Models the provider advertises"),
    r("GET", "/api/zones", "All zones"),
    r("POST", "/api/zones", "Create or update a zone"),
    r("DELETE", "/api/zones/:id", "Delete a zone"),
    r("GET", "/api/zone-library", "Zone library entries, curated and saved"),
    r("POST", "/api/zone-library", "Create or update a library entry"),
    r("DELETE", "/api/zone-library/:id", "Delete a library entry"),

    // Projects & tags
    r("GET", "/api/projects", "All projects"),
    r("POST", "/api/projects", "Create or update a project"),
    r("DELETE", "/api/projects/:id", "Delete a project (?deleteChats=true also deletes its chats)"),
    r("GET", "/api/tags", "All tags"),
    r("POST", "/api/tags", "Create or update a tag"),
    r("DELETE", "/api/tags/:id", "Delete a tag"),
    r("GET", "/api/chat-tags", "Every chat↔tag link, for building a sidebar"),

    // Chats
    r("GET", "/api/chats", "All chats, most recently updated first"),
    r("GET", "/api/search", "Search every message of every chat (?q=)"),
    r("GET", "/api/runs", "Every saved parameterised run"),
    r("POST", "/api/runs", "Create or update a saved run"),
    r("DELETE", "/api/runs/:id", "Delete a saved run"),
    r("POST", "/api/runs/:id/render", "Fill a run's template. Body: { \"values\"? }"),
    r("POST", "/api/chats", "Create a chat"),
    r("DELETE", "/api/chats/:id", "Delete a chat"),
    r("GET", "/api/chats/:id/messages", "Every message in a chat"),
    r("POST", "/api/chats/:id/messages", "Send a message; streams SSE unless ?wait=true"),
    r("PATCH", "/api/chats/:id/messages/:messageId", "Replace a message's text in place"),
    r("DELETE", "/api/chats/:id/messages/from", "Delete a message and everything after it"),
    r("DELETE", "/api/chats/:id/participant-messages", "Delete one participant's latest-round messages"),
    r("POST", "/api/chats/:id/zone", "Set the chat's primary zone"),
    r("POST", "/api/chats/:id/smart", "Turn Smart chat routing on or off"),
    r("POST", "/api/chats/:id/spend-limit", "This session's token ceiling ({limit}: a number, 0 for unmetered, null to inherit the global default)"),
    r("POST", "/api/chats/:id/plan-mode", "Turn plan mode on or off for a chat ({on: bool})"),
    r("GET", "/api/chats/:id/plans", "Every plan this chat has proposed, approved or run"),
    r("GET", "/api/chats/:id/plans/pending", "The plan waiting on the user, if any"),
    r("POST", "/api/plans/:id/approve", "Approve a plan, optionally with edited steps ({steps?, edited?})"),
    r("POST", "/api/plans/:id/reject", "Turn a plan down; the chat stays in plan mode"),
    r("POST", "/api/plans/:id/steps", "Rewrite a plan's steps ({steps})"),
    r("POST", "/api/plans/:id/stop", "Ask the run to finish the current step and stop"),
    r("GET", "/api/chats/:id/plan-tree", "This chat's plans and every sub-agent's beneath it"),
    r("GET", "/api/chats/:id/events", "The session event log — every tool call, approval, error and plan decision in order (?limit=N for the tail)"),
    r("POST", "/api/chats/:id/title", "Rename a chat"),
    r("POST", "/api/chats/:id/generate-title", "Have the model title the chat"),
    r("POST", "/api/chats/:id/project", "Move the chat into a project (or out of one)"),
    r("POST", "/api/chats/:id/project-context", "Toggle project context injection"),
    r("POST", "/api/chats/:id/knowledge", "Toggle the knowledge tool for this chat"),
    r("GET", "/api/chats/:id/tags", "Tags on a chat, with their per-chat context toggles"),
    r("POST", "/api/chats/:id/tags", "Add a tag to a chat"),
    r("DELETE", "/api/chats/:id/tags/:tagId", "Remove a tag from a chat"),
    r("POST", "/api/chats/:id/tags/:tagId/context", "Toggle one tag's context snippet"),
    r("GET", "/api/chats/:id/perspectives", "Perspective zones on a chat"),
    r("POST", "/api/chats/:id/perspectives", "Add a perspective zone"),
    r("DELETE", "/api/chats/:id/perspectives", "Remove a perspective zone"),
    r("POST", "/api/chats/:id/perspective-mode", "Set sequential or parallel for this chat"),
    r("GET", "/api/chats/:id/subagents", "The leader's sub-agent roster"),
    r("POST", "/api/chats/:id/subagents", "Replace the sub-agent roster"),
    r("GET", "/api/chats/:id/subchats", "The leader→sub-agent call tree"),
    r("POST", "/api/chats/:id/branch", "Fork the chat at a message"),
    r("POST", "/api/chats/:id/regenerate", "Re-run the last turn; streams SSE unless ?wait=true"),
    r("POST", "/api/chats/:id/regenerate-participant", "Re-run one participant's answer"),
    r("POST", "/api/chats/:id/cancel", "Cancel the in-flight turn"),
    r("POST", "/api/chats/:id/approval", "Answer a pending tool approval; `hunks` narrows a file change"),
    r("POST", "/api/chats/:id/queue", "Queue a message to reach the model at the next step boundary"),
    r("DELETE", "/api/chats/:id/queue/:messageId", "Drop a queued message"),
    r("POST", "/api/chats/:id/fix-diagram", "Ask the model to repair a failed diagram"),
    r("GET", "/api/chats/:id/usage", "Estimated context carried by this chat's session"),

    // Reversible work
    r("GET", "/api/chats/:id/checkpoints", "Turns in this chat that changed files"),
    r("GET", "/api/chats/:id/checkpoints/since/:messageId", "Turns that changed files after a message"),
    r("POST", "/api/chats/:id/restore-to/:messageId", "Rewind the tree to how it stood at a message"),
    r("POST", "/api/chats/:id/rewind-to/:messageId", "Rewind the tree to a message, reversibly"),
    r("POST", "/api/chats/:id/rewind-forward", "Walk the most recent rewind forward again"),
    r("GET", "/api/chats/:id/rewind-status", "Whether this chat has a rewind to walk forward"),
    r("POST", "/api/checkpoints/:id/restore", "Put a turn's files back; optional path subset and force"),
    r("GET", "/api/checkpoints/usage", "What the checkpoint store is holding"),
    r("POST", "/api/checkpoints/prune", "Apply the configured retention limits now"),
    r("GET", "/api/chats/:id/staged-edits", "File changes queued for review in this chat"),
    r("POST", "/api/chats/:id/staged-edits/apply", "Apply every queued change in this chat"),
    r("DELETE", "/api/chats/:id/staged-edits", "Discard every queued change in this chat"),
    r("POST", "/api/staged-edits/:id/apply", "Apply one queued change; optional hunk subset and force"),
    r("DELETE", "/api/staged-edits/:id", "Discard one queued change"),

    // Skills, memory, MCP
    r("GET", "/api/skills", "All skills"),
    r("POST", "/api/skills", "Create or update a skill"),
    r("DELETE", "/api/skills/:id", "Delete a skill"),
    r("POST", "/api/skills/:id/enabled", "Enable or disable a skill"),
    r("GET", "/api/skill-packs", "Folder-backed skill packs found on disk"),
    r("GET", "/api/skill-packs/root", "The managed folder installers should write to"),
    r("GET", "/api/memories", "All memory entries across every scope"),
    r("POST", "/api/memories", "Create or update a memory entry"),
    r("DELETE", "/api/memories/:id", "Delete a memory entry"),
    r("GET", "/api/mcp/servers", "MCP servers with their tools and live status"),
    r("POST", "/api/mcp/servers", "Create or update an MCP server"),
    r("DELETE", "/api/mcp/servers/:id", "Delete an MCP server"),
    r("POST", "/api/mcp/servers/:id/connect", "Connect and re-read the server's tool list"),
    r("GET", "/api/mcp/servers/:id/resources", "Every resource the server offers"),
    r("POST", "/api/mcp/servers/:id/resources/read", "Read one resource as text. Body: { \"uri\" }"),
    r("GET", "/api/mcp/servers/:id/prompts", "Every prompt template the server offers"),
    r("POST", "/api/mcp/servers/:id/prompts/get", "Expand a prompt. Body: { \"name\", \"arguments\"? }"),
    r("POST", "/api/mcp/servers/:id/disconnect", "Drop the live connection"),
    r("POST", "/api/mcp/tools/:toolId/danger", "Set an MCP tool's danger level"),
    r("GET", "/api/mcp/servers/:id/diagnose", "Why a server isn't working: the first check that fails, and what to do"),

    // Connectors — the catalog an MCP server is installed from (0.11.2)
    r("GET", "/api/connectors", "The connector catalog, with which entries are already installed"),
    r("POST", "/api/connectors/install", "Install a catalog entry as an MCP server"),
    r("POST", "/api/connectors/import", "Import catalog entries from a URL or pasted JSON"),
    r("DELETE", "/api/connectors/:entryId", "Remove an imported catalog entry"),

    // Knowledge
    r("GET", "/api/knowledge", "Global knowledge base config and index status"),
    r("POST", "/api/knowledge/config", "Set the default embedding provider and model"),
    r("POST", "/api/knowledge/index", "Re-index the global knowledge base"),
    r("GET", "/api/knowledge/documents", "Documents in the global index"),
    r("DELETE", "/api/knowledge", "Clear the global index"),
    r("DELETE", "/api/knowledge/documents/:documentId", "Remove one document from its index"),
    r("GET", "/api/projects/:id/knowledge", "A project's index status"),
    r("POST", "/api/projects/:id/knowledge/config", "Set a project's embedding provider and model"),
    r("POST", "/api/projects/:id/knowledge/index", "Index the project's directory"),
    r("POST", "/api/projects/:id/knowledge/default", "Set whether new chats here start with knowledge on"),
    r("GET", "/api/projects/:id/knowledge/documents", "Documents in a project's index"),
    r("DELETE", "/api/projects/:id/knowledge", "Clear a project's index"),

    // Tools, usage, settings, storage
    r("GET", "/api/tools", "Every callable tool function, with its safety level"),
    r("GET", "/api/tool-usage", "Per-zone tool call counters (?zoneId= for one zone)"),
    r("DELETE", "/api/tool-usage", "Reset the counters (?zoneId= for one zone)"),
    r("GET", "/api/usage", "Lifetime token spend"),
    r("GET", "/api/stats", "Row counts: chats, messages, zones, projects, tags"),
    r("GET", "/api/settings/:key", "Read one settings row"),
    r("PUT", "/api/settings/:key", "Write one settings row"),
    r("PATCH", "/api/settings/:key", "Merge fields into a JSON settings row (e.g. {\"mode\":\"dark\"} on `theme`)"),
    r("GET", "/api/theme", "The appearance settings in force, with every field's type, range, default and meaning — and the CSS variables custom CSS should target"),
    r("PATCH", "/api/theme", "Change appearance: mode, accent, the palette colours (background · panels · hover · borders · text · muted text), background effect, glass, bloom, and custom CSS. Validated, and says what is wrong with a patch it rejects"),
    r("POST", "/api/mirror", "Re-write every chat to the markdown mirror folder"),
    r("POST", "/api/mirror/import", "Import a markdown chat file as a new chat"),
];

/// How the API covers one Tauri command.
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)] // Read by the drift test, and by anyone deciding where a new command belongs.
pub enum Coverage {
    /// Reachable at this `METHOD /path`, which must appear in [`ROUTES`].
    Route(&'static str),
    /// Deliberately not exposed, and why. A reason rather than a flag, because
    /// "we didn't get to it" and "this cannot mean anything remotely" are
    /// different answers and only one of them is finished.
    GuiOnly(&'static str),
}

use Coverage::{GuiOnly, Route};

/// Every Tauri command, paired with its route or its exemption.
///
/// The test below checks this against the `generate_handler!` list in `lib.rs`,
/// so a new command fails the build until somebody decides which it is. That is
/// the whole mechanism keeping this release from rotting the way the last one
/// did.
#[allow(dead_code)]
pub const COVERAGE: &[(&str, Coverage)] = &[
    ("providers::list_providers", Route("GET /api/providers")),
    ("providers::upsert_provider", Route("POST /api/providers")),
    ("providers::delete_provider", Route("DELETE /api/providers/:id")),
    ("providers::fetch_models", Route("GET /api/providers/:id/models")),
    ("zones::list_zones", Route("GET /api/zones")),
    ("zones::upsert_zone", Route("POST /api/zones")),
    ("zones::delete_zone", Route("DELETE /api/zones/:id")),
    ("library::list_library_entries", Route("GET /api/zone-library")),
    ("library::upsert_library_entry", Route("POST /api/zone-library")),
    ("library::delete_library_entry", Route("DELETE /api/zone-library/:id")),

    ("projects::list_projects", Route("GET /api/projects")),
    ("projects::upsert_project", Route("POST /api/projects")),
    ("projects::delete_project", Route("DELETE /api/projects/:id")),
    ("projects::list_tags", Route("GET /api/tags")),
    ("projects::upsert_tag", Route("POST /api/tags")),
    ("projects::delete_tag", Route("DELETE /api/tags/:id")),

    ("chats::list_chats", Route("GET /api/chats")),
    ("search::search_messages", Route("GET /api/search")),
    ("runs::list_saved_runs", Route("GET /api/runs")),
    ("runs::upsert_saved_run", Route("POST /api/runs")),
    ("runs::delete_saved_run", Route("DELETE /api/runs/:id")),
    ("runs::render_saved_run", Route("POST /api/runs/:id/render")),
    ("chats::create_chat", Route("POST /api/chats")),
    ("chats::delete_chat", Route("DELETE /api/chats/:id")),
    ("chats::get_messages", Route("GET /api/chats/:id/messages")),
    ("chats::rename_chat", Route("POST /api/chats/:id/title")),
    ("chats::generate_title", Route("POST /api/chats/:id/generate-title")),
    ("chats::set_chat_zone", Route("POST /api/chats/:id/zone")),
    ("chats::set_chat_smart", Route("POST /api/chats/:id/smart")),
    ("messages::set_chat_spend_limit", Route("POST /api/chats/:id/spend-limit")),
    ("chats::set_chat_project", Route("POST /api/chats/:id/project")),
    // Plan mode and plans (0.12.0). The reads are ordinary reads; approving a
    // plan is the user's decision, so it is a control route like the rest.
    ("plans::set_chat_plan_mode", Route("POST /api/chats/:id/plan-mode")),
    ("plans::list_plans", Route("GET /api/chats/:id/plans")),
    ("plans::pending_plan", Route("GET /api/chats/:id/plans/pending")),
    ("plans::approve_plan", Route("POST /api/plans/:id/approve")),
    ("plans::reject_plan", Route("POST /api/plans/:id/reject")),
    ("plans::update_plan_steps", Route("POST /api/plans/:id/steps")),
    ("plans::request_plan_stop", Route("POST /api/plans/:id/stop")),
    ("plans::plan_tree", Route("GET /api/chats/:id/plan-tree")),
    ("plans::list_session_events", Route("GET /api/chats/:id/events")),
    ("chats::set_chat_project_context", Route("POST /api/chats/:id/project-context")),
    ("chats::get_chat_tags", Route("GET /api/chats/:id/tags")),
    ("chats::get_all_chat_tags", Route("GET /api/chat-tags")),
    ("chats::add_chat_tag", Route("POST /api/chats/:id/tags")),
    ("chats::remove_chat_tag", Route("DELETE /api/chats/:id/tags/:tagId")),
    ("chats::set_chat_tag_context", Route("POST /api/chats/:id/tags/:tagId/context")),
    ("chats::get_chat_zones", Route("GET /api/chats/:id/perspectives")),
    ("chats::add_perspective_zone", Route("POST /api/chats/:id/perspectives")),
    ("chats::remove_perspective_zone", Route("DELETE /api/chats/:id/perspectives")),
    ("chats::set_chat_perspective_mode", Route("POST /api/chats/:id/perspective-mode")),
    ("chats::get_chat_subagents", Route("GET /api/chats/:id/subagents")),
    ("chats::set_chat_subagents", Route("POST /api/chats/:id/subagents")),
    ("chats::get_subchat_tree", Route("GET /api/chats/:id/subchats")),
    ("chats::branch_chat", Route("POST /api/chats/:id/branch")),
    ("chats::delete_messages_from", Route("DELETE /api/chats/:id/messages/from")),
    ("chats::delete_participant_messages", Route("DELETE /api/chats/:id/participant-messages")),

    ("messages::send_message", Route("POST /api/chats/:id/messages")),
    ("messages::regenerate_response", Route("POST /api/chats/:id/regenerate")),
    ("messages::regenerate_participant", Route("POST /api/chats/:id/regenerate-participant")),
    ("messages::cancel_stream", Route("POST /api/chats/:id/cancel")),
    ("messages::respond_tool_approval", Route("POST /api/chats/:id/approval")),
    ("messages::update_message", Route("PATCH /api/chats/:id/messages/:messageId")),
    ("messages::list_tool_functions", Route("GET /api/tools")),
    ("pending::queue_chat_message", Route("POST /api/chats/:id/queue")),
    ("pending::cancel_pending_message", Route("DELETE /api/chats/:id/queue/:messageId")),
    ("diagram::fix_diagram", Route("POST /api/chats/:id/fix-diagram")),

    ("checkpoints::list_checkpoints", Route("GET /api/chats/:id/checkpoints")),
    ("checkpoints::checkpoints_since_message", Route("GET /api/chats/:id/checkpoints/since/:messageId")),
    ("checkpoints::restore_to_message", Route("POST /api/chats/:id/restore-to/:messageId")),
    ("checkpoints::rewind_to_message", Route("POST /api/chats/:id/rewind-to/:messageId")),
    ("checkpoints::rewind_forward", Route("POST /api/chats/:id/rewind-forward")),
    ("checkpoints::rewind_status", Route("GET /api/chats/:id/rewind-status")),
    ("checkpoints::restore_checkpoint", Route("POST /api/checkpoints/:id/restore")),
    ("checkpoints::checkpoint_usage", Route("GET /api/checkpoints/usage")),
    ("checkpoints::prune_checkpoints", Route("POST /api/checkpoints/prune")),
    ("review::list_staged_edits", Route("GET /api/chats/:id/staged-edits")),
    ("review::apply_all_staged_edits", Route("POST /api/chats/:id/staged-edits/apply")),
    ("review::discard_all_staged_edits", Route("DELETE /api/chats/:id/staged-edits")),
    ("review::apply_staged_edit", Route("POST /api/staged-edits/:id/apply")),
    ("review::discard_staged_edit", Route("DELETE /api/staged-edits/:id")),

    ("skills::list_skills", Route("GET /api/skills")),
    ("skills::upsert_skill", Route("POST /api/skills")),
    ("skills::delete_skill", Route("DELETE /api/skills/:id")),
    ("skills::set_skill_enabled", Route("POST /api/skills/:id/enabled")),
    ("skills::list_skill_packs", Route("GET /api/skill-packs")),
    ("skills::skill_packs_root", Route("GET /api/skill-packs/root")),
    ("memory::list_memories", Route("GET /api/memories")),
    ("memory::upsert_memory", Route("POST /api/memories")),
    ("memory::delete_memory", Route("DELETE /api/memories/:id")),
    ("mcp::list_mcp_servers", Route("GET /api/mcp/servers")),
    ("mcp::upsert_mcp_server", Route("POST /api/mcp/servers")),
    ("mcp::delete_mcp_server", Route("DELETE /api/mcp/servers/:id")),
    ("mcp::connect_mcp_server", Route("POST /api/mcp/servers/:id/connect")),
    ("mcp::list_mcp_resources", Route("GET /api/mcp/servers/:id/resources")),
    ("mcp::read_mcp_resource", Route("POST /api/mcp/servers/:id/resources/read")),
    ("mcp::list_mcp_prompts", Route("GET /api/mcp/servers/:id/prompts")),
    ("mcp::get_mcp_prompt", Route("POST /api/mcp/servers/:id/prompts/get")),
    ("mcp::disconnect_mcp_server", Route("POST /api/mcp/servers/:id/disconnect")),
    ("mcp::set_mcp_tool_danger", Route("POST /api/mcp/tools/:toolId/danger")),
    ("connectors::list_connectors", Route("GET /api/connectors")),
    ("connectors::install_connector", Route("POST /api/connectors/install")),
    ("connectors::import_connectors", Route("POST /api/connectors/import")),
    ("connectors::delete_connector", Route("DELETE /api/connectors/:entryId")),
    ("connectors::diagnose_mcp_server", Route("GET /api/mcp/servers/:id/diagnose")),

    ("knowledge::get_global_kb", Route("GET /api/knowledge")),
    ("knowledge::set_global_kb_config", Route("POST /api/knowledge/config")),
    ("knowledge::index_global_knowledge", Route("POST /api/knowledge/index")),
    ("knowledge::list_global_kb_documents", Route("GET /api/knowledge/documents")),
    ("knowledge::clear_global_knowledge", Route("DELETE /api/knowledge")),
    ("knowledge::remove_knowledge_document", Route("DELETE /api/knowledge/documents/:documentId")),
    ("knowledge::get_knowledge_status", Route("GET /api/projects/:id/knowledge")),
    ("knowledge::set_project_kb_config", Route("POST /api/projects/:id/knowledge/config")),
    ("knowledge::index_project_knowledge", Route("POST /api/projects/:id/knowledge/index")),
    ("knowledge::set_project_kb_default", Route("POST /api/projects/:id/knowledge/default")),
    ("knowledge::list_knowledge_documents", Route("GET /api/projects/:id/knowledge/documents")),
    ("knowledge::clear_project_knowledge", Route("DELETE /api/projects/:id/knowledge")),
    ("knowledge::set_chat_knowledge", Route("POST /api/chats/:id/knowledge")),

    ("tool_usage::get_tool_usage", Route("GET /api/tool-usage")),
    ("tool_usage::reset_tool_usage", Route("DELETE /api/tool-usage")),
    ("usage::lifetime_token_usage", Route("GET /api/usage")),
    ("usage::session_context_usage", Route("GET /api/chats/:id/usage")),
    ("settings::get_db_stats", Route("GET /api/stats")),
    ("settings::get_setting", Route("GET /api/settings/:key")),
    ("settings::set_setting", Route("PUT /api/settings/:key")),
    ("mirror::mirror_all_chats", Route("POST /api/mirror")),
    ("mirror::import_chat_from_markdown", Route("POST /api/mirror/import")),

    // ── Deliberately GUI-only ────────────────────────────────────────────────
    ("settings::reset_database", GuiOnly(
        "deletes everything and exits the process; a two-step confirmation in front of a human is the whole safety mechanism",
    )),
    ("api::apply_api_settings", GuiOnly(
        "rebinds the server the request arrived on — a caller could lock itself out of the app with no way back in",
    )),
    ("api::api_bind_state", GuiOnly(
        "the Settings panel's read of the same row `/api/health` reports; a caller asks the API itself",
    )),
    ("api::generate_api_token", GuiOnly(
        "a token minted over an already-authenticated channel adds nothing; the point is to hand it to someone who has none",
    )),
    ("files::open_path", GuiOnly("opens a path in this machine's shell — nothing a remote caller can observe")),
    ("files::reveal_path", GuiOnly("shows a path in this machine's file manager")),
    ("files::read_output_file", GuiOnly("feeds the in-window report preview; the file tools read files for callers")),
    ("attachments::upload_attachment", GuiOnly("moves bytes the window already holds into app storage")),
    ("attachments::save_pdf_attachment", GuiOnly("same, for a PDF the window has rasterized")),
    ("attachments::write_export_file", GuiOnly("writes to a path the user picked in a native save dialog")),
    ("attachments::get_attachment_images", GuiOnly("hands the window back image bytes it is about to render")),
    ("voice::list_voice_input_devices", GuiOnly("this machine's microphones")),
    ("voice::start_dictation", GuiOnly("captures from this machine's microphone")),
    ("voice::stop_dictation", GuiOnly("ends a capture that only the window could have started")),
    ("voice::cancel_dictation", GuiOnly("ends a capture that only the window could have started")),
    ("voice::dictation_level", GuiOnly("live meter for the window's mic button")),
    ("voice::dictation_partial", GuiOnly("provisional transcript of a capture only the window could have started")),
    ("voice::synthesize_speech", GuiOnly("returns audio for the window's player")),
    ("voice::summarize_for_speech", GuiOnly("condenses an answer for the window's player")),
    ("voice::list_tts_voices", GuiOnly("populates a picker in Settings")),
    ("voice::list_cloned_voices", GuiOnly("populates a picker in Settings")),
    ("voice::create_cloned_voice", GuiOnly("uploads a reference sample chosen in a native file dialog")),
    ("voice::delete_cloned_voice", GuiOnly("removes a voice from a picker in Settings")),
    ("voice::transcribe_audio_file", GuiOnly("transcribes a file chosen in a native file dialog")),
    ("voice::transcribe_audio_upload", GuiOnly("transcribes bytes the window already holds as a composer attachment")),
];

// ─── Handlers ─────────────────────────────────────────────────────────────────
//
// Each is a thin adapter: pull the managed `AppState` back out of the app
// handle and call the same function the GUI calls. Nothing here re-implements
// behaviour, so a route and a button cannot drift apart.

fn app_state(st: &ApiState) -> tauri::State<'_, AppState> {
    st.app.state::<AppState>()
}

/// JSON body helpers, for the one-off shapes that don't deserve a named struct.
fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}
fn b(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(|x| x.as_bool())
}
fn required(v: &Value, key: &str) -> Result<String, ApiError> {
    s(v, key).ok_or_else(|| {
        ApiError(crate::error::AppError::Invalid(format!("'{key}' is required")))
    })
}

const NO_CONTENT: StatusCode = StatusCode::NO_CONTENT;

/// Every route this build serves. Unauthenticated on purpose: a caller working
/// out why nothing else answers should not have to authenticate to read the map.
pub async fn routes() -> impl IntoResponse {
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "routeSetVersion": ROUTE_SET_VERSION,
        "routes": ROUTES,
    }))
}

// ── Providers, zones, library ────────────────────────────────────────────────

pub async fn list_providers(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::providers::list_providers(app_state(&st)).await?).into_response())
}

pub async fn upsert_provider(
    State(st): State<ApiState>,
    Json(body): Json<commands::providers::ProviderInput>,
) -> ApiResult<Response> {
    Ok(Json(commands::providers::upsert_provider(app_state(&st), body).await?).into_response())
}

pub async fn delete_provider(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::providers::delete_provider(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn provider_models(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::providers::fetch_models(app_state(&st), id).await?).into_response())
}

pub async fn upsert_zone(
    State(st): State<ApiState>,
    Json(body): Json<commands::zones::ZoneInput>,
) -> ApiResult<Response> {
    Ok(Json(commands::zones::upsert_zone(app_state(&st), body).await?).into_response())
}

pub async fn delete_zone(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::zones::delete_zone(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn list_library(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::library::list_library_entries(app_state(&st)).await?).into_response())
}

pub async fn upsert_library(
    State(st): State<ApiState>,
    Json(entry): Json<commands::library::LibraryEntry>,
) -> ApiResult<Response> {
    Ok(Json(commands::library::upsert_library_entry(app_state(&st), entry).await?).into_response())
}

pub async fn delete_library(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::library::delete_library_entry(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

// ── Projects & tags ──────────────────────────────────────────────────────────

pub async fn upsert_project(
    State(st): State<ApiState>,
    Json(body): Json<commands::projects::ProjectInput>,
) -> ApiResult<Response> {
    Ok(Json(commands::projects::upsert_project(app_state(&st), body).await?).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectQuery {
    #[serde(default)]
    delete_chats: Option<bool>,
}

pub async fn delete_project(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Query(q): Query<DeleteProjectQuery>,
) -> ApiResult<StatusCode> {
    commands::projects::delete_project(app_state(&st), id, q.delete_chats).await?;
    Ok(NO_CONTENT)
}

pub async fn upsert_tag(
    State(st): State<ApiState>,
    Json(body): Json<commands::projects::TagInput>,
) -> ApiResult<Response> {
    Ok(Json(commands::projects::upsert_tag(app_state(&st), body).await?).into_response())
}

pub async fn delete_tag(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::projects::delete_tag(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn all_chat_tags(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::chats::get_all_chat_tags(app_state(&st)).await?).into_response())
}

// ── Chats ────────────────────────────────────────────────────────────────────

pub async fn delete_chat(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::chats::delete_chat(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn rename_chat(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    commands::chats::rename_chat(app_state(&st), id, required(&body, "title")?).await?;
    Ok(NO_CONTENT)
}

pub async fn generate_title(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let title = commands::chats::generate_title(
        st.app.clone(),
        app_state(&st),
        id,
        b(&body, "wholeConversation"),
    )
    .await?;
    Ok(Json(json!({ "title": title })).into_response())
}

// ── Plan mode (0.12.0) ───────────────────────────────────────────────────────

pub async fn set_chat_plan_mode(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let on = b(&body, "on").unwrap_or(false);
    commands::plans::set_chat_plan_mode(app_state(&st), id, on).await?;
    Ok(NO_CONTENT)
}

pub async fn list_plans(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let plans = commands::plans::list_plans(app_state(&st), id).await?;
    Ok(Json(plans).into_response())
}

pub async fn pending_plan(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let plan = commands::plans::pending_plan(app_state(&st), id).await?;
    Ok(Json(plan).into_response())
}

pub async fn approve_plan(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let steps = body
        .get("steps")
        .and_then(|v| v.as_array())
        .cloned();
    let edited = b(&body, "edited").unwrap_or(false);
    let plan = commands::plans::approve_plan(app_state(&st), id, steps, edited).await?;
    Ok(Json(plan).into_response())
}

pub async fn reject_plan(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::plans::reject_plan(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn update_plan_steps(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let steps = body
        .get("steps")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let plan = commands::plans::update_plan_steps(app_state(&st), id, steps).await?;
    Ok(Json(plan).into_response())
}

pub async fn request_plan_stop(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::plans::request_plan_stop(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn plan_tree(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let plans = commands::plans::plan_tree(app_state(&st), id).await?;
    Ok(Json(plans).into_response())
}

pub async fn list_session_events(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Response> {
    let limit = q.get("limit").and_then(|v| v.parse::<i64>().ok());
    let events = commands::plans::list_session_events(app_state(&st), id, limit).await?;
    Ok(Json(events).into_response())
}

pub async fn set_chat_smart(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let smart = b(&body, "smart").unwrap_or(false);
    commands::chats::set_chat_smart(app_state(&st), id, smart).await?;
    Ok(NO_CONTENT)
}

/// `{ "limit": 500000 }` sets this session's ceiling, `{ "limit": 0 }` runs it
/// unmetered, and `{}` — or a null — hands it back to the global default.
pub async fn set_chat_spend_limit(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let limit = body.get("limit").and_then(Value::as_i64);
    commands::messages::set_chat_spend_limit(app_state(&st), id, limit).await?;
    Ok(NO_CONTENT)
}

pub async fn set_chat_project(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    commands::chats::set_chat_project(app_state(&st), id, s(&body, "projectId")).await?;
    Ok(NO_CONTENT)
}

pub async fn set_chat_project_context(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let enabled = b(&body, "enabled").unwrap_or(false);
    commands::chats::set_chat_project_context(app_state(&st), id, enabled).await?;
    Ok(NO_CONTENT)
}

pub async fn set_chat_knowledge(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let enabled = b(&body, "enabled").unwrap_or(false);
    commands::knowledge::set_chat_knowledge(app_state(&st), id, enabled).await?;
    Ok(NO_CONTENT)
}

pub async fn chat_tags(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::chats::get_chat_tags(app_state(&st), id).await?).into_response())
}

pub async fn add_chat_tag(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    commands::chats::add_chat_tag(app_state(&st), id, required(&body, "tagId")?).await?;
    Ok(NO_CONTENT)
}

pub async fn remove_chat_tag(
    State(st): State<ApiState>,
    Path((id, tag_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    commands::chats::remove_chat_tag(app_state(&st), id, tag_id).await?;
    Ok(NO_CONTENT)
}

pub async fn set_chat_tag_context(
    State(st): State<ApiState>,
    Path((id, tag_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let enabled = b(&body, "enabled").unwrap_or(false);
    commands::chats::set_chat_tag_context(app_state(&st), id, tag_id, enabled).await?;
    Ok(NO_CONTENT)
}

pub async fn set_perspective_mode(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    commands::chats::set_chat_perspective_mode(app_state(&st), id, s(&body, "mode")).await?;
    Ok(NO_CONTENT)
}

pub async fn list_subagents(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::chats::get_chat_subagents(app_state(&st), id).await?).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentsBody {
    zone_ids: Vec<String>,
}

pub async fn set_subagents(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<SubagentsBody>,
) -> ApiResult<StatusCode> {
    commands::chats::set_chat_subagents(app_state(&st), id, body.zone_ids).await?;
    Ok(NO_CONTENT)
}

pub async fn subchat_tree(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::chats::get_subchat_tree(app_state(&st), id).await?).into_response())
}

pub async fn branch_chat(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let chat = commands::chats::branch_chat(
        app_state(&st),
        id,
        required(&body, "messageId")?,
        b(&body, "solo"),
        s(&body, "zoneId"),
        s(&body, "scope"),
        b(&body, "standalone"),
    )
    .await?;
    Ok(Json(chat).into_response())
}

pub async fn delete_messages_from(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    commands::chats::delete_messages_from(app_state(&st), id, required(&body, "messageId")?)
        .await?;
    Ok(NO_CONTENT)
}

pub async fn delete_participant_messages(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    commands::chats::delete_participant_messages(app_state(&st), id, s(&body, "zoneId")).await?;
    Ok(NO_CONTENT)
}

pub async fn update_message(
    State(st): State<ApiState>,
    Path((id, message_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let msg = commands::messages::update_message(
        app_state(&st),
        id,
        message_id,
        required(&body, "text")?,
    )
    .await?;
    Ok(Json(msg).into_response())
}

pub async fn respond_approval(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let hunks = body
        .get("hunks")
        .and_then(|h| h.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as usize)).collect());
    commands::messages::respond_tool_approval(
        app_state(&st),
        id,
        s(&body, "zoneId"),
        b(&body, "approved").unwrap_or(false),
        hunks,
    )
    .await?;
    Ok(NO_CONTENT)
}

pub async fn queue_message(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    // "steer" reaches the model at the running turn's next step; "next" waits
    // for the turn to finish and starts a fresh one. The composer's two modes.
    let mode = match s(&body, "mode").as_deref() {
        Some("next") => commands::pending::Mode::Next,
        _ => commands::pending::Mode::Steer,
    };
    let out = commands::pending::queue_chat_message(
        app_state(&st),
        id,
        s(&body, "id"),
        required(&body, "text")?,
        mode,
    )
    .await?;
    Ok(Json(out).into_response())
}

pub async fn cancel_queued(
    Path((chat_id, message_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let removed = commands::pending::cancel_pending_message(chat_id, message_id).await?;
    Ok(Json(json!({ "removed": removed })).into_response())
}

pub async fn fix_diagram(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let fixed = commands::diagram::fix_diagram(
        app_state(&st),
        id,
        s(&body, "messageId"),
        s(&body, "toolCallId"),
        required(&body, "source")?,
        s(&body, "error").unwrap_or_default(),
    )
    .await?;
    Ok(Json(fixed).into_response())
}

pub async fn chat_usage(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::usage::session_context_usage(app_state(&st), id).await?).into_response())
}

// ── Reversible work ──────────────────────────────────────────────────────────

pub async fn list_checkpoints(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::checkpoints::list_checkpoints(app_state(&st), id).await?).into_response())
}

pub async fn checkpoints_since(
    State(st): State<ApiState>,
    Path((id, message_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    Ok(Json(
        commands::checkpoints::checkpoints_since_message(app_state(&st), id, message_id).await?,
    )
    .into_response())
}

pub async fn restore_to_message(
    State(st): State<ApiState>,
    Path((id, message_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    Ok(Json(
        commands::checkpoints::restore_to_message(
            app_state(&st),
            id,
            message_id,
            b(&body, "force"),
        )
        .await?,
    )
    .into_response())
}

pub async fn rewind_to_message(
    State(st): State<ApiState>,
    Path((id, message_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    Ok(Json(
        commands::checkpoints::rewind_to_message(app_state(&st), id, message_id, b(&body, "force"))
            .await?,
    )
    .into_response())
}

pub async fn rewind_forward(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    Ok(Json(commands::checkpoints::rewind_forward(app_state(&st), id, b(&body, "force")).await?)
        .into_response())
}

pub async fn rewind_status(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::checkpoints::rewind_status(app_state(&st), id).await?).into_response())
}

pub async fn restore_checkpoint(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let paths = body.get("paths").and_then(|p| p.as_array()).map(|a| {
        a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>()
    });
    Ok(Json(
        commands::checkpoints::restore_checkpoint(app_state(&st), id, paths, b(&body, "force"))
            .await?,
    )
    .into_response())
}

pub async fn checkpoint_usage(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::checkpoints::checkpoint_usage(app_state(&st)).await?).into_response())
}

pub async fn prune_checkpoints(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::checkpoints::prune_checkpoints(app_state(&st)).await?).into_response())
}

pub async fn list_staged(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::review::list_staged_edits(app_state(&st), id).await?).into_response())
}

pub async fn apply_all_staged(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    Ok(Json(
        commands::review::apply_all_staged_edits(app_state(&st), id, b(&body, "force")).await?,
    )
    .into_response())
}

pub async fn discard_all_staged(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::review::discard_all_staged_edits(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn apply_staged(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let hunks = body
        .get("hunks")
        .and_then(|h| h.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as usize)).collect());
    Ok(Json(
        commands::review::apply_staged_edit(app_state(&st), id, hunks, b(&body, "force")).await?,
    )
    .into_response())
}

pub async fn discard_staged(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::review::discard_staged_edit(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

// ── Skills, memory, MCP ──────────────────────────────────────────────────────

pub async fn list_skills(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::skills::list_skills(app_state(&st)).await?).into_response())
}

pub async fn upsert_skill(
    State(st): State<ApiState>,
    Json(body): Json<commands::skills::SkillInput>,
) -> ApiResult<Response> {
    Ok(Json(commands::skills::upsert_skill(app_state(&st), body).await?).into_response())
}

pub async fn delete_skill(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::skills::delete_skill(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn set_skill_enabled(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let enabled = b(&body, "enabled").unwrap_or(false);
    commands::skills::set_skill_enabled(app_state(&st), id, enabled).await?;
    Ok(NO_CONTENT)
}

pub async fn list_skill_packs(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::skills::list_skill_packs(app_state(&st)).await?).into_response())
}

pub async fn skill_packs_root() -> ApiResult<Response> {
    Ok(Json(json!({ "root": commands::skills::skill_packs_root().await? })).into_response())
}

pub async fn list_memories(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::memory::list_memories(app_state(&st)).await?).into_response())
}

pub async fn upsert_memory(
    State(st): State<ApiState>,
    Json(body): Json<commands::memory::MemoryInput>,
) -> ApiResult<Response> {
    Ok(Json(commands::memory::upsert_memory(app_state(&st), body).await?).into_response())
}

pub async fn delete_memory(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::memory::delete_memory(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn list_mcp_servers(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::mcp::list_mcp_servers(app_state(&st)).await?).into_response())
}

pub async fn upsert_mcp_server(
    State(st): State<ApiState>,
    Json(body): Json<commands::mcp::McpServerInput>,
) -> ApiResult<Response> {
    Ok(Json(commands::mcp::upsert_mcp_server(app_state(&st), body).await?).into_response())
}

pub async fn delete_mcp_server(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::mcp::delete_mcp_server(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn connect_mcp_server(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::mcp::connect_mcp_server(app_state(&st), id).await?).into_response())
}

pub async fn list_mcp_resources(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::mcp::list_mcp_resources(app_state(&st), id).await?).into_response())
}

pub async fn read_mcp_resource(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let text = commands::mcp::read_mcp_resource(app_state(&st), id, required(&body, "uri")?).await?;
    Ok(Json(serde_json::json!({ "text": text })).into_response())
}

pub async fn list_mcp_prompts(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::mcp::list_mcp_prompts(app_state(&st), id).await?).into_response())
}

pub async fn get_mcp_prompt(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let text = commands::mcp::get_mcp_prompt(
        app_state(&st),
        id,
        required(&body, "name")?,
        body.get("arguments").cloned(),
    )
    .await?;
    Ok(Json(serde_json::json!({ "text": text })).into_response())
}

pub async fn disconnect_mcp_server(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::mcp::disconnect_mcp_server(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn set_mcp_tool_danger(
    State(st): State<ApiState>,
    Path(tool_id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let level = body.get("dangerLevel").and_then(|v| v.as_i64()).unwrap_or(1);
    commands::mcp::set_mcp_tool_danger(app_state(&st), tool_id, level).await?;
    Ok(NO_CONTENT)
}

// ── Connectors (0.11.2) ──────────────────────────────────────────────────────

pub async fn diagnose_mcp_server(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::connectors::diagnose_mcp_server(app_state(&st), id).await?).into_response())
}

pub async fn list_connectors(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::connectors::list_connectors(app_state(&st)).await?).into_response())
}

pub async fn install_connector(
    State(st): State<ApiState>,
    Json(body): Json<commands::connectors::InstallConnectorInput>,
) -> ApiResult<Response> {
    Ok(Json(commands::connectors::install_connector(app_state(&st), body).await?).into_response())
}

pub async fn import_connectors(
    State(st): State<ApiState>,
    Json(body): Json<commands::connectors::ImportConnectorsInput>,
) -> ApiResult<Response> {
    Ok(Json(commands::connectors::import_connectors(app_state(&st), body).await?).into_response())
}

pub async fn delete_connector(
    State(st): State<ApiState>,
    Path(entry_id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::connectors::delete_connector(app_state(&st), entry_id).await?;
    Ok(NO_CONTENT)
}

// ── Knowledge ────────────────────────────────────────────────────────────────

pub async fn global_kb(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::knowledge::get_global_kb(app_state(&st)).await?).into_response())
}

pub async fn set_global_kb_config(
    State(st): State<ApiState>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    Ok(Json(
        commands::knowledge::set_global_kb_config(
            app_state(&st),
            s(&body, "providerId"),
            s(&body, "embeddingModel"),
        )
        .await?,
    )
    .into_response())
}

pub async fn index_global_kb(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::knowledge::index_global_knowledge(app_state(&st)).await?).into_response())
}

pub async fn global_kb_documents(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::knowledge::list_global_kb_documents(app_state(&st)).await?).into_response())
}

pub async fn clear_global_kb(State(st): State<ApiState>) -> ApiResult<StatusCode> {
    commands::knowledge::clear_global_knowledge(app_state(&st)).await?;
    Ok(NO_CONTENT)
}

pub async fn remove_kb_document(
    State(st): State<ApiState>,
    Path(document_id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::knowledge::remove_knowledge_document(app_state(&st), document_id).await?;
    Ok(NO_CONTENT)
}

pub async fn project_kb_status(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::knowledge::get_knowledge_status(app_state(&st), id).await?).into_response())
}

pub async fn set_project_kb_config(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    Ok(Json(
        commands::knowledge::set_project_kb_config(
            app_state(&st),
            id,
            s(&body, "providerId"),
            s(&body, "embeddingModel"),
        )
        .await?,
    )
    .into_response())
}

pub async fn index_project_kb(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::knowledge::index_project_knowledge(app_state(&st), id).await?)
        .into_response())
}

pub async fn set_project_kb_default(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    Ok(Json(
        commands::knowledge::set_project_kb_default(app_state(&st), id, b(&body, "enabled"))
            .await?,
    )
    .into_response())
}

pub async fn project_kb_documents(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    Ok(Json(commands::knowledge::list_knowledge_documents(app_state(&st), id).await?)
        .into_response())
}

pub async fn clear_project_kb(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::knowledge::clear_project_knowledge(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

// ── Tools, usage, settings, storage ──────────────────────────────────────────

pub async fn list_tools(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::messages::list_tool_functions(app_state(&st)).await?).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneQuery {
    #[serde(default)]
    zone_id: Option<String>,
}

pub async fn tool_usage(
    State(st): State<ApiState>,
    Query(q): Query<ZoneQuery>,
) -> ApiResult<Response> {
    Ok(Json(commands::tool_usage::get_tool_usage(app_state(&st), q.zone_id).await?)
        .into_response())
}

pub async fn reset_tool_usage(
    State(st): State<ApiState>,
    Query(q): Query<ZoneQuery>,
) -> ApiResult<StatusCode> {
    commands::tool_usage::reset_tool_usage(app_state(&st), q.zone_id).await?;
    Ok(NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
}

/// Cross-chat message search (0.15.0). A remote caller wants this at least as
/// much as the window does: on a phone, scrolling a chat list to find the one
/// conversation is the whole problem.
pub async fn search_messages(
    State(st): State<ApiState>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Response> {
    Ok(Json(commands::search::search_messages(app_state(&st), q.q).await?).into_response())
}

pub async fn list_saved_runs(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::runs::list_saved_runs(app_state(&st)).await?).into_response())
}

pub async fn upsert_saved_run(
    State(st): State<ApiState>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let input: commands::runs::SavedRunInput =
        serde_json::from_value(body).map_err(|e| ApiError(crate::error::AppError::Invalid(e.to_string())))?;
    Ok(Json(commands::runs::upsert_saved_run(app_state(&st), input).await?).into_response())
}

pub async fn delete_saved_run(
    State(st): State<ApiState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    commands::runs::delete_saved_run(app_state(&st), id).await?;
    Ok(NO_CONTENT)
}

pub async fn render_saved_run(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let values = body.get("values").cloned();
    Ok(Json(commands::runs::render_saved_run(app_state(&st), id, values).await?).into_response())
}

pub async fn lifetime_usage(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::usage::lifetime_token_usage(app_state(&st)).await?).into_response())
}

pub async fn db_stats(State(st): State<ApiState>) -> ApiResult<Response> {
    Ok(Json(commands::settings::get_db_stats(app_state(&st)).await?).into_response())
}

pub async fn get_setting(
    State(st): State<ApiState>,
    Path(key): Path<String>,
) -> ApiResult<Response> {
    let value = commands::settings::get_setting(app_state(&st), key.clone()).await?;
    Ok(Json(json!({ "key": key, "value": value })).into_response())
}

pub async fn set_setting(
    State(st): State<ApiState>,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    commands::settings::set_setting(
        st.app.clone(),
        app_state(&st),
        key,
        required(&body, "value")?,
    )
    .await?;
    Ok(NO_CONTENT)
}

/// Merge fields into a JSON settings row — the one-call form of "change this
/// preference", and the reason a caller can turn on dark mode without having to
/// re-send every other appearance setting alongside it.
pub async fn patch_setting(
    State(st): State<ApiState>,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let patch = match body {
        Value::Object(map) => map,
        _ => {
            return Err(ApiError(crate::error::AppError::Invalid(
                "body must be a JSON object of the fields to merge".into(),
            )))
        }
    };
    let value =
        commands::settings::patch_setting(st.app.clone(), app_state(&st), key.clone(), patch)
            .await?;
    Ok(Json(json!({ "key": key, "value": value })).into_response())
}

/// The appearance surface, described (0.11.3).
///
/// `GET /api/settings/theme` already returned the theme — as a JSON *string*,
/// carrying only the fields that happened to have been written, with nothing
/// anywhere saying what the others were or what any of them accept. That is
/// enough to change a value you already know the name of and no help at all in
/// finding one, which is why the palette section may as well not have existed
/// remotely. This serves the resolved theme alongside [`crate::theme::schema`],
/// on the same principle as `/api/routes`: the surface documents itself, so
/// neither the README nor a tool description has to carry a copy that rots.
pub async fn get_theme(State(st): State<ApiState>) -> ApiResult<Response> {
    let stored = commands::settings::get_setting(app_state(&st), "theme".into()).await?;
    Ok(Json(json!({
        "theme": crate::theme::resolve(stored.as_deref()),
        "schema": crate::theme::schema(),
    }))
    .into_response())
}

/// Merge validated fields into the theme.
///
/// The validation is the reason this exists next to `PATCH
/// /api/settings/theme`, which will still write anything at all into the row. A
/// misspelled field or an out-of-range number lands there silently, the window
/// ignores it, and the caller is told the change succeeded — the worst possible
/// answer, and the one a model then reports to the user as done.
pub async fn patch_theme(
    State(st): State<ApiState>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let Value::Object(patch) = body else {
        return Err(ApiError(crate::error::AppError::Invalid(
            "body must be a JSON object of theme fields to change, e.g. {\"mode\":\"dark\"}".into(),
        )));
    };
    crate::theme::validate_patch(&patch)
        .map_err(|why| ApiError(crate::error::AppError::Invalid(why)))?;

    let merged = commands::settings::patch_setting(
        st.app.clone(),
        app_state(&st),
        "theme".into(),
        patch,
    )
    .await?;
    Ok(Json(json!({ "theme": crate::theme::resolve(Some(&merged.to_string())) })).into_response())
}

pub async fn mirror_all(State(st): State<ApiState>) -> ApiResult<Response> {
    let n = commands::mirror::mirror_all_chats(app_state(&st)).await?;
    Ok(Json(json!({ "mirrored": n })).into_response())
}

pub async fn import_markdown(
    State(st): State<ApiState>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let chat =
        commands::mirror::import_chat_from_markdown(app_state(&st), required(&body, "path")?)
            .await?;
    Ok(Json(chat).into_response())
}

pub async fn regenerate_participant(
    State(st): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    commands::messages::regenerate_participant(
        st.app.clone(),
        app_state(&st),
        id,
        s(&body, "zoneId"),
    )
    .await?;
    Ok(NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// `ROUTES` is what `GET /api/routes` serves and what `COVERAGE` points at,
    /// so a duplicate entry would make both ambiguous.
    #[test]
    fn the_route_table_has_no_duplicates() {
        let mut seen = HashSet::new();
        for def in ROUTES {
            assert!(
                seen.insert((def.method, def.path)),
                "duplicate route: {} {}",
                def.method,
                def.path,
            );
        }
    }

    /// Every route named by `COVERAGE` exists. Without this, a command could be
    /// marked covered by a route nobody ever wired up.
    #[test]
    fn every_claimed_route_exists() {
        let known: HashSet<String> =
            ROUTES.iter().map(|d| format!("{} {}", d.method, d.path)).collect();
        for (command, coverage) in COVERAGE {
            if let Route(path) = coverage {
                assert!(
                    known.contains(*path),
                    "{command} claims `{path}`, which is not in ROUTES",
                );
            }
        }
    }

    /// **The drift test.**
    ///
    /// The API fell six releases behind because nothing failed when it did:
    /// every release added Tauri commands, none added routes, and no test had
    /// an opinion. This reads the `generate_handler!` list straight out of
    /// `lib.rs` and insists each entry is either routed or explicitly exempted
    /// with a reason. Adding a command now fails the build until somebody
    /// decides which it is — which is the only thing that keeps a route table
    /// honest over time.
    #[test]
    fn every_tauri_command_is_routed_or_explicitly_gui_only() {
        let lib = include_str!("../lib.rs");
        let handler_list = lib
            .split_once("generate_handler![")
            .and_then(|(_, rest)| rest.split_once("])"))
            .map(|(list, _)| list)
            .expect("lib.rs should contain a generate_handler! list");

        let commands: Vec<String> = handler_list
            .lines()
            .filter_map(|line| {
                let line = line.trim().trim_end_matches(',');
                line.strip_prefix("commands::").map(str::to_string)
            })
            .collect();
        assert!(commands.len() > 50, "parsed too few commands — has lib.rs changed shape?");

        let covered: HashSet<&str> = COVERAGE.iter().map(|(name, _)| *name).collect();
        let missing: Vec<&String> =
            commands.iter().filter(|c| !covered.contains(c.as_str())).collect();
        assert!(
            missing.is_empty(),
            "these commands are neither routed nor marked GUI-only in api::routes::COVERAGE: {missing:?}\n\
             Add a route for each, or a GuiOnly entry saying why a remote caller cannot use it.",
        );

        // And the other direction: an entry for a command that no longer exists
        // is a stale claim, which is how a table starts lying.
        let live: HashSet<&str> = commands.iter().map(|s| s.as_str()).collect();
        let stale: Vec<&str> =
            COVERAGE.iter().map(|(n, _)| *n).filter(|n| !live.contains(n)).collect();
        assert!(stale.is_empty(), "COVERAGE names commands that no longer exist: {stale:?}");
    }

    /// Every exemption gives a reason, and every route a description. Both are
    /// read by a person trying to decide whether the API can do what they need.
    #[test]
    fn descriptions_and_reasons_are_all_written() {
        for def in ROUTES {
            assert!(!def.description.trim().is_empty(), "{} {} has no description", def.method, def.path);
        }
        for (command, coverage) in COVERAGE {
            if let GuiOnly(reason) = coverage {
                assert!(!reason.trim().is_empty(), "{command} is GUI-only with no reason given");
            }
        }
    }
}
