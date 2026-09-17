use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use std::process::Stdio;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "bash".into(),
            description: "Run a shell/terminal command in the chat's working directory. Returns stdout, stderr, and the exit code. Use for running scripts, listing files, installing packages, building projects, or any terminal operation. On Windows the default shell is PowerShell; on other platforms it is bash/sh.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command string to execute"
                    },
                    "shell": {
                        "type": "string",
                        "enum": ["auto", "cmd", "powershell", "bash"],
                        "description": "Shell to use. 'auto' picks PowerShell on Windows and bash/sh on Unix."
                    }
                },
                "required": ["command"]
            }),
        },
    }
}

/// One way to launch the command. `stdin` carries the script when the shell
/// reads its command from standard input (the robust path for PowerShell on
/// Windows, which side-steps argument-quoting bugs); otherwise the command is
/// already baked into `args` and stdin is left empty.
struct Candidate {
    prog: String,
    args: Vec<String>,
    stdin: Option<String>,
}

pub async fn run(args: &Value, zone_config: &Value, project_dir: Option<&str>) -> AppResult<String> {
    let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
    if command.is_empty() {
        return Ok(json!({ "error": "command is required", "error_kind": "invalid_args" }).to_string());
    }

    let shell = args.get("shell").and_then(|v| v.as_str()).unwrap_or("auto");
    let cfg = zone_config.get("shell_exec").cloned().unwrap_or(Value::Null);
    let timeout_secs = cfg.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(30);

    let candidates = build_candidates(command, shell);

    let mut spawned = None;
    let mut last_err = String::new();

    for cand in &candidates {
        let mut cmd = Command::new(&cand.prog);
        cmd.args(&cand.args)
            .stdin(if cand.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Kill the child if we drop it (e.g. on timeout) so it doesn't orphan.
            .kill_on_drop(true);

        if let Some(dir) = project_dir {
            cmd.current_dir(dir);
        }

        // Suppress the transient console window on Windows.
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        match cmd.spawn() {
            Ok(mut child) => {
                // Feed the command via stdin when the shell expects it.
                if let Some(script) = &cand.stdin {
                    if let Some(mut stdin) = child.stdin.take() {
                        let _ = stdin.write_all(script.as_bytes()).await;
                        let _ = stdin.shutdown().await;
                        drop(stdin);
                    }
                }
                spawned = Some(child);
                break;
            }
            Err(e) => { last_err = e.to_string(); }
        }
    }

    let Some(child) = spawned else {
        return Ok(json!({
            "error": format!("Failed to start shell. Last error: {last_err}"),
            "error_kind": "environment",
            "hint": "Ensure the required shell is installed and in PATH.",
        }).to_string());
    };

    let result = timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await;

    match result {
        Ok(Ok(output)) => Ok(json!({
            "exit_code": output.status.code(),
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
        }).to_string()),
        Ok(Err(e)) => Ok(json!({ "error": e.to_string(), "error_kind": "runtime" }).to_string()),
        Err(_) => Ok(json!({
            "error": format!("Command timed out after {timeout_secs}s"),
            "error_kind": "timeout",
            "hint": "The command ran too long. Increase shell_exec.timeout_secs in tool config if needed.",
        }).to_string()),
    }
}

/// Prefix that forces PowerShell to emit UTF-8 on its piped stdout/stderr so the
/// captured bytes decode cleanly instead of arriving in the OEM code page.
const PS_UTF8_PREFIX: &str =
    "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n";

/// PowerShell candidate: read the command from stdin (`-Command -`) rather than
/// passing it as an argument. This avoids Windows argument-quoting corruption
/// for commands containing quotes, `$`, or newlines.
fn powershell_candidate(prog: &str, command: &str) -> Candidate {
    Candidate {
        prog: prog.into(),
        args: vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            "-".into(),
        ],
        stdin: Some(format!("{PS_UTF8_PREFIX}{command}")),
    }
}

/// Returns the launch candidates to try in order.
fn build_candidates(command: &str, shell: &str) -> Vec<Candidate> {
    let arg = |prog: &str, args: Vec<String>| Candidate { prog: prog.into(), args, stdin: None };
    let c = command.to_string();

    #[cfg(windows)]
    {
        match shell {
            "bash" => vec![arg("bash", vec!["-c".into(), c])],
            "cmd" => vec![arg("cmd", vec!["/C".into(), c])],
            "powershell" => vec![
                powershell_candidate("pwsh", command),
                powershell_candidate("powershell", command),
            ],
            // auto → PowerShell first (pwsh, then Windows PowerShell), cmd as a
            // last-resort fallback if no PowerShell is present.
            _ => vec![
                powershell_candidate("pwsh", command),
                powershell_candidate("powershell", command),
                arg("cmd", vec!["/C".into(), c]),
            ],
        }
    }

    #[cfg(not(windows))]
    {
        match shell {
            "powershell" => vec![powershell_candidate("pwsh", command)],
            "cmd" => vec![
                arg("bash", vec!["-c".into(), c.clone()]),
                arg("sh", vec!["-c".into(), c]),
            ],
            _ => vec![
                arg("bash", vec!["-c".into(), c.clone()]),
                arg("sh", vec!["-c".into(), c]),
            ],
        }
    }
}
