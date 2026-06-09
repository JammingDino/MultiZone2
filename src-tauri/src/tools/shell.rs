use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "run_command".into(),
            description: "Run a shell/terminal command in the chat's working directory. Returns stdout, stderr, and the exit code. Use for running scripts, listing files, installing packages, building projects, or any terminal operation. On Windows the default shell is cmd; on other platforms it is bash/sh.".into(),
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
                        "description": "Shell to use. 'auto' picks cmd on Windows and bash/sh on Unix."
                    }
                },
                "required": ["command"]
            }),
        },
    }
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

    for (prog, prog_args) in &candidates {
        let mut cmd = Command::new(prog);
        cmd.args(prog_args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(dir) = project_dir {
            cmd.current_dir(dir);
        }

        // Always suppress console windows for background shell commands on Windows.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        match cmd.spawn() {
            Ok(c) => { spawned = Some(c); break; }
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

/// Returns a list of (program, args) candidates to try in order.
fn build_candidates(command: &str, shell: &str) -> Vec<(String, Vec<String>)> {
    let c = command.to_string();

    #[cfg(windows)]
    {
        match shell {
            "bash" => vec![
                ("bash".into(), vec!["-c".into(), c]),
            ],
            "powershell" => vec![
                ("pwsh".into(),        vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), c.clone()]),
                ("powershell".into(),  vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), c]),
            ],
            _ => vec![
                ("cmd".into(), vec!["/C".into(), c]),
            ],
        }
    }

    #[cfg(not(windows))]
    {
        match shell {
            "powershell" => vec![
                ("pwsh".into(), vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), c]),
            ],
            "cmd" => vec![
                ("bash".into(), vec!["-c".into(), c.clone()]),
                ("sh".into(),   vec!["-c".into(), c]),
            ],
            _ => vec![
                ("bash".into(), vec!["-c".into(), c.clone()]),
                ("sh".into(),   vec!["-c".into(), c]),
            ],
        }
    }
}
