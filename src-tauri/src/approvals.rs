//! Approval policy (0.14.2) — deciding, per call, whether the user is asked.
//!
//! Until now this was one global setting with four notches, the top of which
//! was *Everything*. The README told people to select it before any long run,
//! because a sub-agent cannot show a prompt and a background one has nobody to
//! show it to. So the honest description of the shipped default was: read the
//! warning, turn the safety off, hope.
//!
//! The problem is that "how dangerous is this tool" and "do I want to be asked
//! about this kind of work" are different questions. Reading files all day is
//! not the thing anyone wants to approve twenty times; one `rm -rf` is the thing
//! nobody wants auto-approved, ever. A single slider cannot express that, and a
//! user who wants unattended reads has to buy unattended shell to get them.
//!
//! Three mechanisms, smallest first:
//!
//! 1. **Categories.** Each tool belongs to one — read, edit, shell, web, MCP,
//!    spawn, state — and each category is either auto-approved or asked about.
//!    Unset falls back to the old danger-level setting, so an install that never
//!    opens the panel behaves exactly as it did.
//! 2. **Shell prefix lists.** Allow and deny lists over the command text,
//!    longest match wins, so "allow `git`, deny `git push`" resolves the way it
//!    reads. A deny is a *refusal*, not a prompt: the point of writing one down
//!    is not being asked.
//! 3. **Per-zone overrides.** A scout that only reads, an implementer that may
//!    edit, and neither of them holding unreviewed shell — expressed on the zone
//!    rather than as a global mode someone has to remember to switch.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;

/// What kind of work a tool does, from the user's point of view — which is not
/// the same axis as how dangerous it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    /// Observing local state: files, searches, memory, plans, another agent's
    /// transcript. Nothing changes.
    Read,
    /// Writing to the filesystem.
    Edit,
    /// Running a command or a program: shell, code execution, terminals.
    Shell,
    /// Reaching the network: search, fetch, crawl, raw HTTP.
    Web,
    /// Anything served by an MCP server, whatever it does. The user configured
    /// the server and set a danger level per tool; the category exists so
    /// "everything from outside" can be gated as one decision.
    Mcp,
    /// Starting a sub-agent or handing it work.
    Spawn,
    /// Changing the app itself or its durable state: settings, memories, skills,
    /// zones, tags.
    State,
}

impl Category {
    pub fn from_key(key: &str) -> Option<Self> {
        Some(match key {
            "read" => Category::Read,
            "edit" => Category::Edit,
            "shell" => Category::Shell,
            "web" => Category::Web,
            "mcp" => Category::Mcp,
            "spawn" => Category::Spawn,
            "state" => Category::State,
            _ => return None,
        })
    }

}

/// Which category a tool call belongs to.
///
/// Deliberately exhaustive over the built-ins rather than derived from the
/// danger level: the two disagree on purpose. `delete_file` and `run_command`
/// are both danger 2 and belong in different categories, because someone who
/// lets an agent edit a repo has not thereby agreed to let it run anything.
pub fn category_for(tool: &str) -> Category {
    if crate::mcp::is_mcp_tool(tool) {
        return Category::Mcp;
    }
    match tool {
        // Reads of local state.
        "read_file" | "list_directory" | "find_files" | "search_file_text"
        | "search_local_files" | "search_knowledge" | "read_memory" | "read_subchat"
        | "list_subchats" | "collect_subagents" | "list_zones" | "team_status"
        | "terminal_read" | "terminal_list" | "app_read" | "get_current_datetime"
        | "load_skill" | "present_file" | "plot_function" | "draw_diagram"
        | "ask_user" => Category::Read,

        // Writes to the filesystem.
        "create_file" | "edit_file" | "delete_file" | "move_file" | "copy_file"
        | "create_folder" => Category::Edit,

        // Running things.
        "run_command" | "execute_code" | "terminal_start" | "terminal_write"
        | "terminal_stop" => Category::Shell,

        // The network.
        "web_search" | "smart_search" | "smart_fetch" | "smart_crawl" | "extract_url"
        | "http_request" => Category::Web,

        // Sub-agents.
        "spawn_subagent" | "send_subchat_message" => Category::Spawn,

        // The app's own durable state.
        "app_control" | "save_memory" | "delete_memory" | "tag_chat" | "change_zone"
        | "create_skill" | "update_skill" | "update_plan" | "enter_plan_mode"
        | "exit_plan_mode" | "compact_context" | "claim_files" | "release_files"
        | "post_note" => Category::State,

        // An unknown tool is treated as state rather than read: a tool this
        // build does not recognise is the last thing to wave through.
        _ => Category::State,
    }
}

/// What to do with one call.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Run it without asking.
    Auto,
    /// Show the approval prompt.
    Ask,
    /// Refuse outright, with a reason for the model. Only a shell deny-prefix
    /// produces this: the user wrote down that this must not run, and turning
    /// that into a prompt would ask a question already answered.
    Deny(String),
}

/// The resolved policy for one zone.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    /// The pre-0.14.2 global setting, still the fallback for any category the
    /// user has not decided about.
    level: String,
    categories: HashMap<Category, bool>,
    shell_allow: Vec<String>,
    shell_deny: Vec<String>,
}

/// The JSON shape stored both in `app_settings.approvals` and in a zone's
/// `approvals` column. Every field optional: absent means "inherit".
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalConfig {
    /// Category key → true for auto-approve, false for always ask.
    #[serde(default)]
    categories: HashMap<String, bool>,
    #[serde(default)]
    shell_allow: Vec<String>,
    #[serde(default)]
    shell_deny: Vec<String>,
}

impl Policy {
    /// Read the global settings, then let the zone's own overrides win.
    ///
    /// Merged per key rather than wholesale: a zone that says one thing about
    /// shell should not thereby discard the user's global decision about reads.
    pub async fn load(db: &SqlitePool, zone_approvals: Option<&str>) -> Self {
        let raw: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
                .fetch_optional(db)
                .await
                .ok()
                .flatten()
                .flatten();
        let settings: Value = raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);

        let level = settings
            .get("autoApproveLevel")
            .and_then(Value::as_str)
            .unwrap_or("all")
            .to_string();

        let global: ApprovalConfig = settings
            .get("approvals")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        let zone: ApprovalConfig = zone_approvals
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        let mut categories = HashMap::new();
        for (key, auto) in global.categories.iter().chain(zone.categories.iter()) {
            if let Some(cat) = Category::from_key(key) {
                categories.insert(cat, *auto);
            }
        }

        Self {
            level,
            categories,
            // Prefix lists concatenate rather than replace. A zone adding
            // "deny `git push`" must not silently drop the global deny list —
            // the whole point of a deny list is that it cannot be lost by
            // configuring something else.
            shell_allow: [global.shell_allow, zone.shell_allow].concat(),
            shell_deny: [global.shell_deny, zone.shell_deny].concat(),
        }
    }

    /// Decide one call. `danger` is the tool's danger level (MCP tools carry the
    /// user's own).
    pub fn decide(&self, tool: &str, arguments: &str, danger: u8) -> Decision {
        let category = category_for(tool);

        // The shell lists come first: they are the most specific thing the user
        // has said, and a deny is an answer rather than a question.
        if category == Category::Shell {
            if let Some(cmd) = shell_command(arguments) {
                match shell_verdict(&cmd, &self.shell_allow, &self.shell_deny) {
                    Some(true) => return Decision::Auto,
                    Some(false) => {
                        return Decision::Deny(format!(
                            "Refused: `{cmd}` matches a denied command prefix in this app's \
                             approval settings. This is not a prompt you can retry — pick a \
                             different approach, or tell the user which rule is in your way."
                        ))
                    }
                    None => {}
                }
            }
        }

        match self.categories.get(&category) {
            Some(true) => Decision::Auto,
            Some(false) => Decision::Ask,
            // Undecided: the old global slider, so an install that never opens
            // the new panel behaves exactly as it did before.
            None => {
                if legacy_needs_approval(&self.level, danger) {
                    Decision::Ask
                } else {
                    Decision::Auto
                }
            }
        }
    }
}

/// The pre-0.14.2 rule, kept verbatim as the fallback.
pub fn legacy_needs_approval(auto_level: &str, tool_safety: u8) -> bool {
    match auto_level {
        "all" => false,
        "safe_moderate" => tool_safety > 1,
        "safe" => tool_safety > 0,
        "none" => true,
        _ => false,
    }
}

/// The command text out of a shell-ish call's arguments.
fn shell_command(arguments: &str) -> Option<String> {
    let v: Value = serde_json::from_str(arguments).ok()?;
    let cmd = v
        .get("command")
        .or_else(|| v.get("code"))
        .or_else(|| v.get("input"))
        .and_then(Value::as_str)?
        .trim();
    (!cmd.is_empty()).then(|| cmd.to_string())
}

/// Allow (`Some(true)`), deny (`Some(false)`), or no rule (`None`).
///
/// Longest match wins, so "allow `git`, deny `git push`" resolves the way it
/// reads. A tie goes to deny: two rules of equal length disagreeing is a
/// configuration mistake, and the safe reading of a mistake is the strict one.
fn shell_verdict(command: &str, allow: &[String], deny: &[String]) -> Option<bool> {
    let cmd = normalize(command);
    let best = |list: &[String]| -> Option<usize> {
        list.iter()
            .map(|p| normalize(p))
            .filter(|p| !p.is_empty() && matches_prefix(&cmd, p))
            .map(|p| p.len())
            .max()
    };
    match (best(allow), best(deny)) {
        (None, None) => None,
        (Some(_), None) => Some(true),
        (None, Some(_)) => Some(false),
        (Some(a), Some(d)) => Some(a > d),
    }
}

/// Collapse whitespace so `git   push` and `git push` are the same rule.
fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// A prefix matches on whole words: `git` must not match `github-cli`, or an
/// allow-list entry quietly permits every command that merely starts with those
/// letters.
fn matches_prefix(command: &str, prefix: &str) -> bool {
    command == prefix
        || command
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with(' '))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(categories: &[(&str, bool)], allow: &[&str], deny: &[&str]) -> Policy {
        Policy {
            level: "none".into(),
            categories: categories
                .iter()
                .filter_map(|(k, v)| Category::from_key(k).map(|c| (c, *v)))
                .collect(),
            shell_allow: allow.iter().map(|s| s.to_string()).collect(),
            shell_deny: deny.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn tools_land_in_the_category_a_person_would_put_them_in() {
        assert_eq!(category_for("read_file"), Category::Read);
        assert_eq!(category_for("edit_file"), Category::Edit);
        assert_eq!(category_for("run_command"), Category::Shell);
        assert_eq!(category_for("execute_code"), Category::Shell);
        assert_eq!(category_for("smart_search"), Category::Web);
        assert_eq!(category_for("spawn_subagent"), Category::Spawn);
        assert_eq!(category_for("app_control"), Category::State);
        assert_eq!(category_for("mcp__a1b2c3d4__anything"), Category::Mcp);
    }

    /// The two axes disagree on purpose, and this is the case that shows why:
    /// both are danger 2, and letting an agent edit a repo is not agreeing to
    /// let it run arbitrary commands.
    #[test]
    fn deleting_a_file_and_running_a_command_are_different_decisions() {
        assert_eq!(category_for("delete_file"), Category::Edit);
        assert_eq!(category_for("run_command"), Category::Shell);
    }

    /// A tool this build does not know about is the last thing to wave through.
    #[test]
    fn an_unknown_tool_is_not_treated_as_a_read() {
        assert_eq!(category_for("some_future_tool"), Category::State);
    }

    #[test]
    fn a_decided_category_ignores_the_danger_level_entirely() {
        let p = policy(&[("read", true), ("shell", false)], &[], &[]);
        assert_eq!(p.decide("read_file", "{}", 1), Decision::Auto);
        assert_eq!(p.decide("run_command", "{\"command\":\"ls\"}", 2), Decision::Ask);
    }

    /// An install that never opens the new panel must behave exactly as it did.
    #[test]
    fn an_undecided_category_falls_back_to_the_old_slider() {
        let mut p = policy(&[], &[], &[]);
        p.level = "safe".into();
        assert_eq!(p.decide("read_file", "{}", 0), Decision::Auto, "safe tool");
        assert_eq!(p.decide("edit_file", "{}", 1), Decision::Ask, "moderate tool");

        p.level = "all".into();
        assert_eq!(p.decide("run_command", "{\"command\":\"ls\"}", 2), Decision::Auto);
    }

    #[test]
    fn longest_match_wins_so_allow_git_deny_git_push_reads_correctly() {
        let p = policy(&[("shell", false)], &["git"], &["git push"]);
        assert_eq!(p.decide("run_command", "{\"command\":\"git status\"}", 2), Decision::Auto);
        match p.decide("run_command", "{\"command\":\"git push origin main\"}", 2) {
            Decision::Deny(msg) => assert!(msg.contains("git push origin main"), "{msg}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// A prefix is words, not characters — otherwise allowing `git` also allows
    /// `github-cli-that-does-anything`.
    #[test]
    fn a_prefix_matches_whole_words() {
        let p = policy(&[("shell", false)], &["git"], &[]);
        assert_eq!(p.decide("run_command", "{\"command\":\"gitleaks detect\"}", 2), Decision::Ask);
        assert_eq!(p.decide("run_command", "{\"command\":\"git\"}", 2), Decision::Auto);
    }

    #[test]
    fn spacing_and_case_do_not_defeat_a_rule() {
        let p = policy(&[], &[], &["RM -RF"]);
        assert!(matches!(
            p.decide("run_command", "{\"command\":\"rm   -rf /\"}", 2),
            Decision::Deny(_)
        ));
    }

    /// Two rules of the same length disagreeing is a configuration mistake, and
    /// the safe reading of a mistake is the strict one.
    #[test]
    fn a_tie_goes_to_deny() {
        let p = policy(&[("shell", true)], &["npm run"], &["npm run"]);
        assert!(matches!(
            p.decide("run_command", "{\"command\":\"npm run build\"}", 2),
            Decision::Deny(_)
        ));
    }

    /// The deny list beats an auto-approved category. Someone who wrote down
    /// "never this" and also "shell is fine" meant the exception.
    #[test]
    fn a_deny_overrides_an_auto_approved_category() {
        let p = policy(&[("shell", true)], &[], &["rm"]);
        assert!(matches!(
            p.decide("run_command", "{\"command\":\"rm -rf build\"}", 2),
            Decision::Deny(_)
        ));
        assert_eq!(p.decide("run_command", "{\"command\":\"ls\"}", 2), Decision::Auto);
    }

    /// The lists only speak about shell. A file named `rm` is not a command.
    #[test]
    fn the_prefix_lists_do_not_apply_outside_shell() {
        let p = policy(&[("edit", true)], &[], &["rm"]);
        assert_eq!(p.decide("edit_file", "{\"path\":\"rm\"}", 1), Decision::Auto);
    }

    #[test]
    fn a_command_that_cannot_be_read_falls_through_to_the_category() {
        let p = policy(&[("shell", false)], &["ls"], &[]);
        assert_eq!(p.decide("run_command", "not json", 2), Decision::Ask);
        assert_eq!(p.decide("run_command", "{}", 2), Decision::Ask);
    }
}
