//! What is already set up for Claude Code on this machine (0.20.0), read so it
//! can be brought over rather than set up twice: its sub-agents
//! (`~/.claude/agents/*.md`) as zones, and its MCP servers (`~/.claude.json`,
//! user scope and every project's) as MCP entries.
//!
//! Only reads. The Settings dialog shows what was found and the user picks what
//! to import; the writes go through the ordinary zone and MCP commands.

use crate::error::AppResult;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportAgent {
    pub name: String,
    pub description: String,
    pub prompt: String,
    /// MultiZone tool ids the agent's Claude Code tools map to.
    pub tools: Vec<String>,
    /// Only reading tools were listed — import as a read-only zone.
    pub read_only: bool,
    /// Claude Code's model alias or id (`sonnet`, `opus`, `inherit`, …), or "".
    pub model: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportMcp {
    pub name: String,
    /// `stdio`, `http` or `sse`.
    pub transport: String,
    /// The command line, quoted where a part has spaces, as `shell_split` reads it.
    pub command: Option<String>,
    pub url: Option<String>,
    /// JSON objects, or null. May hold credentials — the dialog shows only keys.
    pub env: Option<String>,
    pub headers: Option<String>,
    /// "user", or the project directory it is configured for.
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeSetup {
    pub agents: Vec<ImportAgent>,
    pub mcp_servers: Vec<ImportMcp>,
}

#[tauri::command]
pub async fn scan_claude_code() -> AppResult<ClaudeCodeSetup> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    Ok(tokio::task::spawn_blocking(move || match home {
        Some(h) => scan(Path::new(&h)),
        None => ClaudeCodeSetup { agents: vec![], mcp_servers: vec![] },
    })
    .await
    .unwrap_or(ClaudeCodeSetup { agents: vec![], mcp_servers: vec![] }))
}

pub fn scan(home: &Path) -> ClaudeCodeSetup {
    let mut agents = Vec::new();
    if let Ok(entries) = std::fs::read_dir(home.join(".claude").join("agents")) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&p) {
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("agent");
                agents.push(parse_agent(&text, stem, &p.to_string_lossy()));
            }
        }
    }
    agents.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let mut mcp_servers = Vec::new();
    if let Some(cfg) = std::fs::read_to_string(home.join(".claude.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        collect_mcp(cfg.get("mcpServers"), "user", &mut mcp_servers);
        if let Some(projects) = cfg.get("projects").and_then(Value::as_object) {
            for (dir, p) in projects {
                collect_mcp(p.get("mcpServers"), dir, &mut mcp_servers);
            }
        }
    }
    ClaudeCodeSetup { agents, mcp_servers }
}

fn parse_agent(text: &str, fallback: &str, path: &str) -> ImportAgent {
    let (name, description, body) = crate::skillpacks::parse_frontmatter(text, fallback);
    let field = |key: &str| -> Option<String> {
        let fm = text.strip_prefix('\u{feff}').unwrap_or(text).strip_prefix("---")?;
        let fm = &fm[..fm.find("\n---").unwrap_or(fm.len())];
        fm.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim().eq_ignore_ascii_case(key)).then(|| v.trim().trim_matches(['"', '\'']).to_string())
        })
    };
    let listed: Option<Vec<String>> = field("tools").filter(|t| !t.is_empty()).map(|t| {
        t.trim_matches(['[', ']'])
            .split(',')
            .map(|s| s.trim().trim_matches(['"', '\'']).to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });
    let (tools, read_only) = map_tools(listed.as_deref());
    ImportAgent {
        name,
        description,
        prompt: body.trim().to_string(),
        tools,
        read_only,
        model: field("model").unwrap_or_default(),
        path: path.to_string(),
    }
}

/// Claude Code tool names → MultiZone tool ids. No list means Claude Code's
/// default, every tool, which maps to the Code preset.
fn map_tools(listed: Option<&[String]>) -> (Vec<String>, bool) {
    let Some(listed) = listed else {
        let code = crate::tools::presets::find("code").map(|p| p.tools).unwrap_or_default();
        return (code.into_iter().map(String::from).collect(), false);
    };
    let mut out: Vec<String> = Vec::new();
    let mut writes = false;
    for t in listed {
        // `mcp__server__tool` and `Bash(git:*)`-style patterns: the bare name decides.
        let bare = t.split('(').next().unwrap_or(t).trim();
        let ids: &[&str] = match bare {
            "Read" | "LS" => &["file_system"],
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
                writes = true;
                &["file_system", "file_manage"]
            }
            "Grep" | "Glob" => &["file_search"],
            "Bash" | "PowerShell" => {
                writes = true;
                &["shell_exec"]
            }
            "WebSearch" => &["smart_search"],
            "WebFetch" => &["smart_fetch"],
            "Task" | "Agent" => {
                writes = true;
                &["subchat"]
            }
            "TodoWrite" => &["plan"],
            _ => &[],
        };
        for id in ids {
            if !out.iter().any(|o| o == id) {
                out.push(id.to_string());
            }
        }
    }
    // Reading without writing is a read-only agent: keep it that way here.
    let read_only = !writes && !out.is_empty();
    (out, read_only)
}

fn collect_mcp(servers: Option<&Value>, scope: &str, out: &mut Vec<ImportMcp>) {
    let Some(map) = servers.and_then(Value::as_object) else {
        return;
    };
    for (name, s) in map {
        let url = s.get("url").and_then(Value::as_str).map(String::from);
        let transport = match s.get("type").and_then(Value::as_str) {
            Some("sse") => "sse",
            Some("http") | Some("streamable-http") => "http",
            _ if url.is_some() => "http",
            _ => "stdio",
        }
        .to_string();
        let command = s.get("command").and_then(Value::as_str).map(|c| {
            let args = s.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
            std::iter::once(c.to_string())
                .chain(args.iter().filter_map(|a| a.as_str().map(String::from)))
                .map(|p| quote(&p))
                .collect::<Vec<_>>()
                .join(" ")
        });
        let obj = |k: &str| s.get(k).filter(|v| v.as_object().is_some_and(|o| !o.is_empty())).map(Value::to_string);
        let entry = ImportMcp { name: name.clone(), transport, command, url, env: obj("env"), headers: obj("headers"), scope: scope.to_string() };
        // The same server configured in several projects is offered once.
        if !out.iter().any(|o| o.name == entry.name && o.command == entry.command && o.url == entry.url) {
            out.push(entry);
        }
    }
}

/// Quote one argument the way `mcp::shell_split` reads it back.
fn quote(part: &str) -> String {
    if part.is_empty() {
        "\"\"".into()
    } else if !part.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'') {
        part.into()
    } else if part.contains('"') {
        format!("'{part}'")
    } else {
        format!("\"{part}\"")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_file_becomes_a_role() {
        let a = parse_agent(
            "---\nname: code-reviewer\ndescription: Reviews diffs.\ntools: Read, Grep, Glob\nmodel: sonnet\n---\n\nYou review code.\n",
            "fallback",
            "x.md",
        );
        assert_eq!(a.name, "code-reviewer");
        assert_eq!(a.description, "Reviews diffs.");
        assert_eq!(a.prompt, "You review code.");
        assert_eq!(a.tools, ["file_system", "file_search"]);
        assert!(a.read_only, "reading tools only is a read-only agent");
        assert_eq!(a.model, "sonnet");
    }

    #[test]
    fn writing_tools_are_not_read_only_and_no_list_means_code() {
        let (tools, ro) = map_tools(Some(&["Read".into(), "Edit".into(), "Bash(git:*)".into()]));
        assert_eq!(tools, ["file_system", "file_manage", "shell_exec"]);
        assert!(!ro);
        let (tools, ro) = map_tools(None);
        assert!(tools.contains(&"shell_exec".to_string()) && !ro);
    }

    #[test]
    fn a_command_with_spaces_survives_the_round_trip() {
        let mut out = Vec::new();
        let cfg = serde_json::json!({
            "cad": { "type": "stdio", "command": "C:\\Program Files\\Cad\\cli.exe", "args": ["--mcp", "a b"], "env": { "TOKEN": "x" } },
            "web": { "type": "http", "url": "https://example.com/mcp" },
        });
        collect_mcp(Some(&cfg), "user", &mut out);
        let cad = out.iter().find(|s| s.name == "cad").unwrap();
        assert_eq!(
            crate::mcp::shell_split(cad.command.as_deref().unwrap()),
            ["C:\\Program Files\\Cad\\cli.exe", "--mcp", "a b"]
        );
        assert_eq!(cad.env.as_deref(), Some(r#"{"TOKEN":"x"}"#));
        let web = out.iter().find(|s| s.name == "web").unwrap();
        assert_eq!((web.transport.as_str(), web.command.is_none()), ("http", true));
    }

    #[test]
    fn scans_a_home_folder_and_offers_a_shared_server_once() {
        let dir = std::env::temp_dir().join(format!("mz-cc-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude/agents")).unwrap();
        std::fs::write(dir.join(".claude/agents/explorer.md"), "---\nname: explorer\n---\nLook around.").unwrap();
        std::fs::write(dir.join(".claude/agents/notes.txt"), "not an agent").unwrap();
        let server = serde_json::json!({ "command": "uvx", "args": ["thing"] });
        std::fs::write(
            dir.join(".claude.json"),
            serde_json::json!({ "mcpServers": { "thing": server }, "projects": { "D:/p": { "mcpServers": { "thing": server, "other": { "command": "npx" } } } } }).to_string(),
        )
        .unwrap();
        let found = scan(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(found.agents.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["explorer"]);
        assert_eq!(found.mcp_servers.iter().map(|s| (s.name.as_str(), s.scope.as_str())).collect::<Vec<_>>(), [("thing", "user"), ("other", "D:/p")]);
    }
}
