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
//! 3. **Edit path lists** (0.14.5). The same shape again, over the paths an edit
//!    would touch, so "this zone may edit inside the project root" is a rule
//!    rather than a boolean bolted onto the category. The category answers
//!    *whether* editing is auto-approved; this answers *where*.
//! 4. **Per-zone overrides.** A scout that only reads, an implementer that may
//!    edit, and neither of them holding unreviewed shell — expressed on the zone
//!    rather than as a global mode someone has to remember to switch.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

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
/// danger level: the two disagree on purpose. `delete_file` and `bash`
/// are both danger 2 and belong in different categories, because someone who
/// lets an agent edit a repo has not thereby agreed to let it run anything.
pub fn category_for(tool: &str) -> Category {
    if crate::mcp::is_mcp_tool(tool) {
        return Category::Mcp;
    }
    match tool {
        // Reads of local state.
        "read" | "glob" | "grep"
        | "search_local_files" | "search_knowledge" | "read_memory" | "read_subchat"
        | "list_subchats" | "collect_subagents" | "list_zones" | "team_status"
        | "terminal_read" | "terminal_list" | "app_read" | "get_current_datetime"
        | "load_skill" | "present_file" | "plot_function" | "draw_diagram"
        | "ask_user" => Category::Read,

        // Writes to the filesystem.
        "write" | "edit" | "delete_file" | "move_file" | "copy_file"
        | "create_folder" => Category::Edit,

        // Running things.
        "bash" | "execute_code" | "terminal_start" | "terminal_write"
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
    /// Refuse outright. Only a deny list produces this — shell or path: the user
    /// wrote down that this must not happen, and turning that into a prompt
    /// would ask a question already answered.
    Deny {
        /// The sentence handed back to the model in place of a result.
        reason: String,
        /// Which list refused it, for the session event. `shellDeny` and
        /// `editDeny` read differently in a transcript and the difference
        /// matters when someone is working out why a call did not run.
        rule: &'static str,
    },
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
    edit_allow: Vec<String>,
    edit_deny: Vec<String>,
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
    /// Directories (or files) an edit may touch without being asked about.
    /// `{project}` stands for the chat's project directory, which is the rule
    /// almost everyone wants and the one nobody should have to retype per
    /// project.
    #[serde(default)]
    edit_allow: Vec<String>,
    #[serde(default)]
    edit_deny: Vec<String>,
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
            edit_allow: [global.edit_allow, zone.edit_allow].concat(),
            edit_deny: [global.edit_deny, zone.edit_deny].concat(),
        }
    }

    /// Decide one call. `danger` is the tool's danger level (MCP tools carry the
    /// user's own); `project_dir` is the chat's working directory, which the
    /// path rules resolve relative entries and `{project}` against.
    pub fn decide(
        &self,
        tool: &str,
        arguments: &str,
        danger: u8,
        project_dir: Option<&str>,
    ) -> Decision {
        let category = category_for(tool);

        // The shell lists come first: they are the most specific thing the user
        // has said, and a deny is an answer rather than a question.
        if category == Category::Shell {
            if let Some(cmd) = shell_command(arguments) {
                match shell_verdict(&cmd, &self.shell_allow, &self.shell_deny) {
                    Some(true) => return Decision::Auto,
                    Some(false) => {
                        return Decision::Deny {
                            reason: format!(
                                "Refused: `{cmd}` matches a denied command prefix in this app's \
                                 approval settings. This is not a prompt you can retry — pick a \
                                 different approach, or tell the user which rule is in your way."
                            ),
                            rule: "shellDeny",
                        }
                    }
                    None => {}
                }
            }
        }

        // The path lists, for the same reason and with one deliberate
        // difference: an allow list here is a *boundary*, not a shortcut. A
        // command that matches no shell rule falls through to the category, but
        // an edit outside every allowed path is the exact case the user drew the
        // boundary for, so it is asked about even where the category says auto.
        if category == Category::Edit {
            match self.path_verdict(arguments, project_dir) {
                PathRule::Allowed => return Decision::Auto,
                PathRule::Denied(path) => {
                    return Decision::Deny {
                        reason: format!(
                            "Refused: `{path}` is inside a path this app's approval settings \
                             forbid editing. This is not a prompt you can retry — work somewhere \
                             else, or tell the user which rule is in your way."
                        ),
                        rule: "editDeny",
                    }
                }
                PathRule::Outside(_) => return Decision::Ask,
                PathRule::Silent => {}
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

    /// Apply the path lists to every path one edit call would touch.
    ///
    /// *Every* path, because `move_file` has two and moving a file out of the
    /// allowed area is exactly as much an escape as writing to it directly. The
    /// strictest answer across them wins.
    fn path_verdict(&self, arguments: &str, project_dir: Option<&str>) -> PathRule {
        let allow = rule_keys(&self.edit_allow, project_dir);
        let deny = rule_keys(&self.edit_deny, project_dir);
        if allow.is_empty() && deny.is_empty() {
            return PathRule::Silent;
        }

        let paths = call_paths(arguments);
        if paths.is_empty() {
            // Under a configured boundary, a call whose paths cannot be read is
            // the one call that must not be waved through — "I could not tell
            // where this writes" is a reason to ask, not a reason to assume.
            return if allow.is_empty() {
                PathRule::Silent
            } else {
                PathRule::Outside("(unreadable path)".into())
            };
        }

        let mut worst = PathRule::Allowed;
        for raw in &paths {
            let key = path_key(&crate::tools::filesystem::resolve_path(raw, project_dir));
            let best = |list: &[String]| -> Option<usize> {
                list.iter()
                    .filter(|r| matches_path(&key, r))
                    .map(String::len)
                    .max()
            };
            // Longest match wins and a tie goes to deny, exactly as the shell
            // lists resolve: `{project}` allowed with `{project}/.git` denied
            // reads the way it looks.
            let (allowed, denied) = (best(&allow), best(&deny));
            let verdict = match (allowed, denied) {
                (a, Some(d)) if a.is_none_or(|a| a <= d) => PathRule::Denied(raw.clone()),
                (Some(_), _) => PathRule::Allowed,
                (None, _) if allow.is_empty() => PathRule::Silent,
                (None, _) => PathRule::Outside(raw.clone()),
            };
            if verdict.severity() > worst.severity() {
                worst = verdict;
            }
        }
        worst
    }
}

/// What the path lists say about one call.
#[derive(Debug, Clone, PartialEq)]
enum PathRule {
    /// No path rules apply — the category decides, as it did before 0.14.5.
    Silent,
    /// Every path is inside something the user allowed.
    Allowed,
    /// A path is inside something the user forbade.
    Denied(String),
    /// Rules exist and this path is outside all of them.
    Outside(String),
}

impl PathRule {
    /// Ordering for "strictest answer wins" across a call's several paths.
    fn severity(&self) -> u8 {
        match self {
            Self::Allowed => 0,
            Self::Silent => 1,
            Self::Outside(_) => 2,
            Self::Denied(_) => 3,
        }
    }
}

/// Every path an edit-category call would touch. `from`/`to` are `move_file`
/// and `copy_file`; `path` is everything else.
fn call_paths(arguments: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(arguments) else {
        return Vec::new();
    };
    ["path", "from", "to"]
        .iter()
        .filter_map(|k| v.get(k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Turn the user's written rules into comparable keys.
///
/// A rule that cannot be anchored is dropped rather than widened: `{project}`
/// in a chat with no project directory, or a bare relative path with nothing to
/// resolve it against, would otherwise become a rule about the filesystem root.
/// Dropping an allow rule costs a prompt; keeping it could cost a repository.
fn rule_keys(rules: &[String], project_dir: Option<&str>) -> Vec<String> {
    let project = project_dir.map(str::trim).filter(|d| !d.is_empty());
    rules
        .iter()
        .map(|r| r.trim())
        .filter(|r| !r.is_empty())
        .filter_map(|r| {
            let expanded = match project {
                Some(dir) => r.replace("{project}", dir),
                // Unexpanded, the token would be matched as a literal directory
                // name, which is worse than not matching at all.
                None if r.contains("{project}") => return None,
                None => r.to_string(),
            };
            let p = PathBuf::from(&expanded);
            if p.is_absolute() {
                Some(path_key(&p))
            } else {
                project.map(|dir| path_key(&PathBuf::from(dir).join(&p)))
            }
        })
        .filter(|k| !k.is_empty())
        .collect()
}

/// One path, reduced to something a prefix comparison can be honest about.
///
/// Canonicalized where the filesystem can answer — which is what resolves
/// symlinks, `8.3` short names and the case a file was really created with —
/// then lexically normalized for the part that does not exist yet, since
/// `write` names a path precisely when it is absent. Separators are
/// unified and Windows is case-folded, because on Windows `C:\Src` and `c:\src`
/// are the same directory and a rule that missed one would be a rule in name
/// only.
fn path_key(path: &Path) -> String {
    let resolved = canonical_lenient(path);
    let mut out: Vec<String> = Vec::new();
    for comp in resolved.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // Never above the root: `C:\..\..\x` is `C:\x`, not an escape.
                if out.len() > 1 {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str().to_string_lossy().replace('\\', "/")),
        }
    }
    let joined = out
        .join("/")
        .replace("//", "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        joined.to_lowercase()
    } else {
        joined
    }
}

/// `std::fs::canonicalize` as far as the path actually exists, with the missing
/// tail rejoined. The verbatim prefix Windows returns (`\\?\C:\...`) is stripped
/// so a canonicalized path and a hand-written rule compare as the same string.
fn canonical_lenient(path: &Path) -> PathBuf {
    let mut ancestor = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(c) = ancestor.canonicalize() {
            let mut out = strip_verbatim(&c);
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (ancestor.file_name(), ancestor.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                ancestor = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => PathBuf::from(format!(r"\\{rest}")),
        None => match s.strip_prefix(r"\\?\") {
            Some(rest) => PathBuf::from(rest),
            None => p.to_path_buf(),
        },
    }
}

/// A path prefix matches on whole path segments. `/srv/app` must not match
/// `/srv/app-backup`, for the same reason `git` must not match `gitleaks`.
fn matches_path(path: &str, rule: &str) -> bool {
    path == rule
        || path
            .strip_prefix(rule)
            .is_some_and(|rest| rest.starts_with('/'))
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
    use serde_json::json;

    fn policy(categories: &[(&str, bool)], allow: &[&str], deny: &[&str]) -> Policy {
        Policy {
            level: "none".into(),
            categories: categories
                .iter()
                .filter_map(|(k, v)| Category::from_key(k).map(|c| (c, *v)))
                .collect(),
            shell_allow: allow.iter().map(|s| s.to_string()).collect(),
            shell_deny: deny.iter().map(|s| s.to_string()).collect(),
            edit_allow: Vec::new(),
            edit_deny: Vec::new(),
        }
    }

    /// The same, with the path lists set instead of the shell ones.
    fn path_policy(categories: &[(&str, bool)], allow: &[&str], deny: &[&str]) -> Policy {
        let mut p = policy(categories, &[], &[]);
        p.edit_allow = allow.iter().map(|s| s.to_string()).collect();
        p.edit_deny = deny.iter().map(|s| s.to_string()).collect();
        p
    }

    /// An absolute path that is the same shape on both platforms, so the tests
    /// exercise the matcher rather than the host's path syntax.
    fn abs(rel: &str) -> String {
        if cfg!(windows) {
            format!("C:\\work\\{rel}")
        } else {
            format!("/work/{rel}")
        }
    }

    fn root() -> String {
        if cfg!(windows) { "C:\\work".into() } else { "/work".into() }
    }

    fn edit(path: &str) -> String {
        json!({ "path": path }).to_string()
    }

    #[test]
    fn tools_land_in_the_category_a_person_would_put_them_in() {
        assert_eq!(category_for("read"), Category::Read);
        assert_eq!(category_for("edit"), Category::Edit);
        assert_eq!(category_for("bash"), Category::Shell);
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
        assert_eq!(category_for("bash"), Category::Shell);
    }

    /// A tool this build does not know about is the last thing to wave through.
    #[test]
    fn an_unknown_tool_is_not_treated_as_a_read() {
        assert_eq!(category_for("some_future_tool"), Category::State);
    }

    #[test]
    fn a_decided_category_ignores_the_danger_level_entirely() {
        let p = policy(&[("read", true), ("shell", false)], &[], &[]);
        assert_eq!(p.decide("read", "{}", 1, None), Decision::Auto);
        assert_eq!(p.decide("bash", "{\"command\":\"ls\"}", 2, None), Decision::Ask);
    }

    /// An install that never opens the new panel must behave exactly as it did.
    #[test]
    fn an_undecided_category_falls_back_to_the_old_slider() {
        let mut p = policy(&[], &[], &[]);
        p.level = "safe".into();
        assert_eq!(p.decide("read", "{}", 0, None), Decision::Auto, "safe tool");
        assert_eq!(p.decide("edit", "{}", 1, None), Decision::Ask, "moderate tool");

        p.level = "all".into();
        assert_eq!(p.decide("bash", "{\"command\":\"ls\"}", 2, None), Decision::Auto);
    }

    #[test]
    fn longest_match_wins_so_allow_git_deny_git_push_reads_correctly() {
        let p = policy(&[("shell", false)], &["git"], &["git push"]);
        assert_eq!(p.decide("bash", "{\"command\":\"git status\"}", 2, None), Decision::Auto);
        match p.decide("bash", "{\"command\":\"git push origin main\"}", 2, None) {
            Decision::Deny { reason, .. } => assert!(reason.contains("git push origin main"), "{reason}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// A prefix is words, not characters — otherwise allowing `git` also allows
    /// `github-cli-that-does-anything`.
    #[test]
    fn a_prefix_matches_whole_words() {
        let p = policy(&[("shell", false)], &["git"], &[]);
        assert_eq!(p.decide("bash", "{\"command\":\"gitleaks detect\"}", 2, None), Decision::Ask);
        assert_eq!(p.decide("bash", "{\"command\":\"git\"}", 2, None), Decision::Auto);
    }

    #[test]
    fn spacing_and_case_do_not_defeat_a_rule() {
        let p = policy(&[], &[], &["RM -RF"]);
        assert!(matches!(
            p.decide("bash", "{\"command\":\"rm   -rf /\"}", 2, None),
            Decision::Deny { .. }
        ));
    }

    /// Two rules of the same length disagreeing is a configuration mistake, and
    /// the safe reading of a mistake is the strict one.
    #[test]
    fn a_tie_goes_to_deny() {
        let p = policy(&[("shell", true)], &["npm run"], &["npm run"]);
        assert!(matches!(
            p.decide("bash", "{\"command\":\"npm run build\"}", 2, None),
            Decision::Deny { .. }
        ));
    }

    /// The deny list beats an auto-approved category. Someone who wrote down
    /// "never this" and also "shell is fine" meant the exception.
    #[test]
    fn a_deny_overrides_an_auto_approved_category() {
        let p = policy(&[("shell", true)], &[], &["rm"]);
        assert!(matches!(
            p.decide("bash", "{\"command\":\"rm -rf build\"}", 2, None),
            Decision::Deny { .. }
        ));
        assert_eq!(p.decide("bash", "{\"command\":\"ls\"}", 2, None), Decision::Auto);
    }

    /// The lists only speak about shell. A file named `rm` is not a command.
    #[test]
    fn the_prefix_lists_do_not_apply_outside_shell() {
        let p = policy(&[("edit", true)], &[], &["rm"]);
        assert_eq!(p.decide("edit", "{\"path\":\"rm\"}", 1, None), Decision::Auto);
    }

    #[test]
    fn a_command_that_cannot_be_read_falls_through_to_the_category() {
        let p = policy(&[("shell", false)], &["ls"], &[]);
        assert_eq!(p.decide("bash", "not json", 2, None), Decision::Ask);
        assert_eq!(p.decide("bash", "{}", 2, None), Decision::Ask);
    }

    // ── Edit path lists (0.14.5) ─────────────────────────────────────────────

    /// The headline case: "this zone may edit inside the project root", written
    /// once and true for whichever project the chat is in.
    #[test]
    fn the_project_token_becomes_the_chats_own_directory() {
        let p = path_policy(&[("edit", false)], &["{project}"], &[]);
        let dir = root();
        assert_eq!(p.decide("edit", &edit("src/a.rs"), 1, Some(&dir)), Decision::Auto);
        assert_eq!(p.decide("edit", &edit(&abs("src/a.rs")), 1, Some(&dir)), Decision::Auto);
    }

    /// The point of the whole item: an allow list is a boundary, so a path
    /// outside it is asked about even though the category says auto. This is
    /// the one place the path lists deliberately differ from the shell lists.
    #[test]
    fn an_allow_list_asks_about_everything_outside_it() {
        let p = path_policy(&[("edit", true)], &["{project}"], &[]);
        let dir = root();
        assert_eq!(p.decide("edit", &edit("src/a.rs"), 1, Some(&dir)), Decision::Auto);
        let outside = if cfg!(windows) { "C:\\elsewhere\\a.rs" } else { "/elsewhere/a.rs" };
        assert_eq!(p.decide("edit", &edit(outside), 1, Some(&dir)), Decision::Ask);
    }

    /// A deny list on its own is an exception list, not a grant: everything it
    /// does not name still falls through to the category, exactly as before.
    #[test]
    fn a_deny_list_alone_does_not_grant_anything() {
        let p = path_policy(&[("edit", false)], &[], &["{project}/.git"]);
        let dir = root();
        assert_eq!(p.decide("edit", &edit("src/a.rs"), 1, Some(&dir)), Decision::Ask);
        assert!(matches!(
            p.decide("edit", &edit(".git/config"), 1, Some(&dir)),
            Decision::Deny { rule: "editDeny", .. }
        ));
    }

    /// Longest match wins, so "the project, except its `.git`" reads correctly —
    /// the same rule the shell lists resolve by.
    #[test]
    fn a_denied_subdirectory_beats_an_allowed_parent() {
        let p = path_policy(&[("edit", true)], &["{project}"], &["{project}/.git"]);
        let dir = root();
        assert_eq!(p.decide("edit", &edit("src/a.rs"), 1, Some(&dir)), Decision::Auto);
        match p.decide("edit", &edit(".git/hooks/pre-commit"), 1, Some(&dir)) {
            Decision::Deny { reason, rule } => {
                assert_eq!(rule, "editDeny");
                assert!(reason.contains(".git/hooks/pre-commit"), "{reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// A prefix is path segments, not characters — otherwise allowing the
    /// project also allows the backup directory sitting next to it.
    #[test]
    fn a_path_prefix_matches_whole_segments() {
        let p = path_policy(&[("edit", true)], &["{project}"], &[]);
        let dir = root();
        let sibling = if cfg!(windows) { "C:\\work-backup\\a.rs" } else { "/work-backup/a.rs" };
        assert_eq!(p.decide("edit", &edit(sibling), 1, Some(&dir)), Decision::Ask);
        assert_eq!(p.decide("edit", &edit(&root()), 1, Some(&dir)), Decision::Auto);
    }

    /// `..` is resolved before the comparison, so climbing out of an allowed
    /// directory does not smuggle a write past the rule.
    #[test]
    fn dot_dot_cannot_walk_out_of_an_allowed_path() {
        let p = path_policy(&[("edit", true)], &["{project}/src"], &[]);
        let dir = root();
        assert_eq!(p.decide("edit", &edit("src/a.rs"), 1, Some(&dir)), Decision::Auto);
        assert_eq!(p.decide("edit", &edit("src/../secrets.env"), 1, Some(&dir)), Decision::Ask);
    }

    /// Both ends of a move are checked. Moving a file out of the allowed area
    /// is exactly as much an escape as writing outside it.
    #[test]
    fn both_ends_of_a_move_have_to_pass() {
        let p = path_policy(&[("edit", true)], &["{project}"], &[]);
        let dir = root();
        let inside = json!({ "from": "src/a.rs", "to": "src/b.rs" }).to_string();
        assert_eq!(p.decide("move_file", &inside, 1, Some(&dir)), Decision::Auto);
        let out = if cfg!(windows) { "C:\\elsewhere\\b.rs" } else { "/elsewhere/b.rs" };
        let leaving = json!({ "from": "src/a.rs", "to": out }).to_string();
        assert_eq!(p.decide("move_file", &leaving, 1, Some(&dir)), Decision::Ask);
    }

    /// Under a boundary, a call whose path cannot be read is the one call that
    /// must not be waved through.
    #[test]
    fn an_unreadable_path_is_asked_about_when_a_boundary_exists() {
        let dir = root();
        let bounded = path_policy(&[("edit", true)], &["{project}"], &[]);
        assert_eq!(bounded.decide("edit", "not json", 1, Some(&dir)), Decision::Ask);
        // With no path rules at all, nothing has changed: the category decides.
        let plain = path_policy(&[("edit", true)], &[], &[]);
        assert_eq!(plain.decide("edit", "not json", 1, Some(&dir)), Decision::Auto);
    }

    /// A rule that cannot be anchored is dropped rather than widened. An
    /// unexpanded `{project}` matching nothing costs a prompt; the same rule
    /// read as a literal directory name, or as the filesystem root, could cost
    /// a repository.
    #[test]
    fn an_unanchorable_rule_is_dropped_not_widened() {
        let p = path_policy(&[("edit", true)], &["{project}"], &[]);
        // No project directory: the allow list is empty, so no boundary exists
        // and the category decides — it does not become a boundary that nothing
        // can satisfy, and it does not become a rule about everything.
        assert_eq!(p.decide("edit", &edit(&abs("a.rs")), 1, None), Decision::Auto);
        assert!(rule_keys(&["{project}/src".to_string()], None).is_empty());
        assert!(rule_keys(&["src".to_string()], None).is_empty());
    }

    /// The path lists only speak about edits. A shell command that happens to
    /// contain a forbidden path is the shell lists' business.
    #[test]
    fn the_path_lists_do_not_apply_outside_edits() {
        let p = path_policy(&[("edit", false), ("read", true)], &[], &[&abs("secrets")]);
        let dir = root();
        assert_eq!(
            p.decide("read", &edit(&abs("secrets/key.pem")), 0, Some(&dir)),
            Decision::Auto
        );
    }

    #[test]
    fn separators_do_not_defeat_a_rule() {
        let p = path_policy(&[("edit", true)], &[], &["{project}/.git"]);
        let dir = root();
        assert!(matches!(
            p.decide("edit", &edit(".git\\config"), 1, Some(&dir)),
            Decision::Deny { .. }
        ));
        assert!(matches!(
            p.decide("edit", &edit(".git/config"), 1, Some(&dir)),
            Decision::Deny { .. }
        ));
    }

    /// On Windows `C:\Work` and `c:\work` are one directory, so a rule that
    /// matched only one spelling would be a rule in name only.
    #[test]
    #[cfg(windows)]
    fn windows_paths_compare_without_case() {
        let p = path_policy(&[("edit", true)], &[], &["C:\\Work\\Secrets"]);
        assert!(matches!(
            p.decide("edit", &edit("c:\\work\\secrets\\key.pem"), 1, None),
            Decision::Deny { .. }
        ));
    }

    /// …and on a case-sensitive filesystem they are two directories, so the
    /// rule must not quietly cover both.
    #[test]
    #[cfg(not(windows))]
    fn unix_paths_keep_their_case() {
        let p = path_policy(&[("edit", true)], &[], &["/work/Secrets"]);
        assert_eq!(p.decide("edit", &edit("/work/secrets/key.pem"), 1, None), Decision::Auto);
        assert!(matches!(
            p.decide("edit", &edit("/work/Secrets/key.pem"), 1, None),
            Decision::Deny { .. }
        ));
    }

    /// A symlink pointing out of the allowed area is followed before the
    /// comparison, so it cannot be used as a door.
    #[test]
    fn a_symlink_out_of_the_allowed_area_is_followed_first() {
        let tmp = std::env::temp_dir().join(format!("mz-approvals-{}", std::process::id()));
        let inside = tmp.join("project");
        let outside = tmp.join("elsewhere");
        let _ = std::fs::create_dir_all(inside.join("src"));
        let _ = std::fs::create_dir_all(&outside);
        let link = inside.join("escape");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, &link).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
        if !made {
            // Creating a symlink needs a privilege the test host may not have
            // (Windows without developer mode). Skipping is honest; failing
            // here would report a missing privilege as a policy bug.
            let _ = std::fs::remove_dir_all(&tmp);
            return;
        }

        let dir = inside.to_string_lossy().to_string();
        let p = path_policy(&[("edit", true)], &["{project}"], &[]);
        assert_eq!(p.decide("edit", &edit("src/a.rs"), 1, Some(&dir)), Decision::Auto);
        assert_eq!(p.decide("edit", &edit("escape/a.rs"), 1, Some(&dir)), Decision::Ask);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
