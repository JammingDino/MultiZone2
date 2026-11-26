//! Tool presets (0.20.0): a zone's built-in toolset in one pick.
//!
//! The zone editor offers these instead of a column of checkboxes, and
//! `spawn_subagent` takes one by name so a leader can make a helper without a
//! zone being configured for it. A preset only ever decides built-in tools —
//! MCP tools stay a checklist the user ticks, and are never added or removed by
//! picking a preset.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// Built-in tool group ids, as stored in a zone's `tools_enabled`.
    pub tools: Vec<&'static str>,
    /// Set on the zone's `tool_config` as `read_only`: only the functions that
    /// cannot change anything are offered or run (see [`read_only_allows`]).
    pub read_only: bool,
}

const READ: [&str; 13] = [
    "file_system", "file_search", "present_file", "smart_search", "smart_fetch", "smart_crawl",
    "skills", "memory", "plan", "ask_user", "render_graph", "date_time", "context_usage",
];

pub fn presets() -> Vec<ToolPreset> {
    let research: Vec<&str> = READ.iter().copied().chain(["compact"]).collect();
    let code: Vec<&str> = research
        .iter()
        .copied()
        .filter(|t| *t != "smart_crawl")
        .chain(["file_manage", "shell_exec", "terminal", "code_exec"])
        .collect();
    vec![
        ToolPreset {
            id: "read_only",
            label: "Read-only",
            description: "Reads files and the web, searches, plans and asks. Cannot change anything.",
            tools: READ.to_vec(),
            read_only: true,
        },
        ToolPreset {
            id: "research",
            label: "Research",
            description: "Searches and reads the web and your files, and writes up what it finds.",
            tools: research,
            read_only: false,
        },
        ToolPreset {
            id: "code",
            label: "Code",
            description: "Reads, edits and manages files, runs commands, code and terminals.",
            tools: code,
            read_only: false,
        },
        ToolPreset {
            id: "everything",
            label: "Everything",
            description: "Every built-in tool, including delegating, scheduling and changing the app.",
            tools: super::ALL_TOOL_IDS.iter().map(|t| t.as_str()).collect(),
            read_only: false,
        },
    ]
}

pub fn find(id: &str) -> Option<ToolPreset> {
    presets().into_iter().find(|p| p.id.eq_ignore_ascii_case(id))
}

/// Whether a zone's tool config marks it read-only.
pub fn is_read_only(tool_config: &str) -> bool {
    serde_json::from_str::<Value>(tool_config)
        .ok()
        .and_then(|c| c.get("read_only").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// What a read-only zone may call: plan mode's allowlist (nothing that changes
/// anything outside the conversation) plus drawing in the chat, minus the plan
/// mode controls, and every MCP tool — those the user ticked one by one.
pub fn read_only_allows(name: &str) -> bool {
    if crate::mcp::is_mcp_tool(name) {
        return true;
    }
    if matches!(name, "enter_plan_mode" | "exit_plan_mode" | "draft_plan_step") {
        return false;
    }
    crate::plans::allowed_in_plan_mode(name)
        || matches!(name, "plot_function" | "render_chart" | "draw_diagram")
}

pub fn read_only_refusal(name: &str) -> String {
    serde_json::json!({
        "error": format!("`{name}` is unavailable: this agent is read-only."),
        "hint": "Report what should change instead; whoever asked can make the change.",
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_names_real_tools() {
        for p in presets() {
            for t in &p.tools {
                assert!(super::super::ToolId::from_str(t).is_some(), "{} names unknown tool {t}", p.id);
            }
        }
    }

    #[test]
    fn read_only_refuses_every_write() {
        for name in ["write", "edit", "delete_file", "move_file", "bash", "execute_code", "save_memory", "create_skill", "spawn_subagent", "app_control"] {
            assert!(!read_only_allows(name), "{name} must be refused");
        }
        for name in ["read", "grep", "glob", "smart_search", "load_skill", "render_chart", "mcp__abcd1234__query"] {
            assert!(read_only_allows(name), "{name} must be allowed");
        }
    }

    #[test]
    fn read_only_is_read_from_the_tool_config() {
        assert!(is_read_only(r#"{"read_only":true}"#));
        assert!(!is_read_only("{}"));
        assert!(!is_read_only("not json"));
    }
}
