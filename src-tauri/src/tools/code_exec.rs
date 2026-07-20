use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::time::{timeout, Duration};

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "execute_code".into(),
            description:
                "Execute a short code snippet in a sandboxed subprocess. Returns stdout, stderr, and the exit code. If the result indicates `error_kind: \"environment\"`, the host machine is missing the runtime — do not retry, instead inform the user."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "enum": ["python", "node", "bash", "powershell"]
                    },
                    "code": { "type": "string" }
                },
                "required": ["language", "code"]
            }),
        },
    }
}

/// Zone config:
/// {
///   "code_exec": {
///     "timeout_secs": 10,
///     "enabled_languages": ["python", "node"]
///   }
/// }
pub async fn run(args: &Value, zone_config: &Value) -> AppResult<String> {
    let language = args.get("language").and_then(|v| v.as_str()).unwrap_or("");
    let code = args.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let cfg = zone_config.get("code_exec").cloned().unwrap_or(Value::Null);
    let timeout_secs = cfg
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(10);

    if let Some(enabled) = cfg.get("enabled_languages").and_then(|v| v.as_array()) {
        let allowed = enabled
            .iter()
            .any(|v| v.as_str().map(|s| s == language).unwrap_or(false));
        if !allowed {
            return Ok(json!({
                "error": format!("language '{language}' not enabled for this zone"),
                "error_kind": "configuration",
                "hint": "This language is disabled in the zone's tool_config.enabled_languages. Tell the user to enable it if they want this to work."
            })
            .to_string());
        }
    }

    // Candidate executables to try, in order. The first one that spawns wins.
    // Handles common Windows variants (py launcher, python3 vs python) and
    // POSIX variants (python3 vs python).
    let (candidates, prog_args): (&[&str], Vec<&str>) = match language {
        "python" => (
            &["python", "python3", "py"][..],
            vec!["-"],
        ),
        "node" => (&["node", "nodejs"][..], vec!["-"]),
        "bash" => (&["bash"][..], vec!["-s"]),
        "powershell" => (
            &["pwsh", "powershell"][..],
            vec!["-NoProfile", "-NonInteractive", "-Command", "-"],
        ),
        _ => {
            return Ok(json!({
                "error": format!("unsupported language: {language}"),
                "error_kind": "unsupported_language",
            })
            .to_string());
        }
    };

    let headless = cfg
        .get("headless")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut child: Option<Child> = None;
    let mut used_program: Option<&str> = None;
    let mut last_error: Option<String> = None;
    for candidate in candidates {
        // Via util::program so .bat/.cmd shims (pyenv-win, nvm4w and similar
        // version managers) resolve the way they would in a shell.
        let mut cmd = crate::util::program::command(candidate);
        cmd.args(&prog_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Kill the child if dropped (e.g. on timeout) so it doesn't orphan.
            .kill_on_drop(true);
        #[cfg(windows)]
        if headless {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        match cmd.spawn() {
            Ok(c) => {
                child = Some(c);
                used_program = Some(candidate);
                break;
            }
            Err(e) => {
                last_error = Some(e.to_string());
            }
        }
    }

    let Some(mut child) = child else {
        let tried: Vec<&&str> = candidates.iter().collect();
        return Ok(json!({
            "error": format!(
                "No {language} runtime is installed on this machine. Tried: {}. Last error: {}",
                tried
                    .iter()
                    .map(|s| **s)
                    .collect::<Vec<_>>()
                    .join(", "),
                last_error.unwrap_or_else(|| "program not found".into())
            ),
            "error_kind": "environment",
            "language": language,
            "tried_executables": candidates,
            "hint": format!(
                "This is a host-environment problem, not a problem with the code or the request. The user needs to install {language} (or add it to PATH) for this tool to work. Do NOT retry the same call; instead tell the user what's missing and offer to walk through the calculation manually."
            ),
        })
        .to_string());
    };

    if let Some(mut stdin) = child.stdin.take() {
        // For PowerShell, force UTF-8 on its piped output so captured bytes
        // decode cleanly instead of arriving in the OEM code page.
        if language == "powershell" {
            let _ = stdin
                .write_all(
                    b"$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n",
                )
                .await;
        }
        let _ = stdin.write_all(code.as_bytes()).await;
        let _ = stdin.shutdown().await;
        drop(stdin);
    }

    let exec = async {
        let output = child.wait_with_output().await?;
        Ok::<_, std::io::Error>(output)
    };

    let result = timeout(Duration::from_secs(timeout_secs), exec).await;

    match result {
        Ok(Ok(output)) => Ok(json!({
            "exit_code": output.status.code(),
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
            "executable": used_program,
        })
        .to_string()),
        Ok(Err(e)) => Ok(json!({
            "error": e.to_string(),
            "error_kind": "runtime",
        })
        .to_string()),
        Err(_) => Ok(json!({
            "error": format!("execution timed out after {timeout_secs}s"),
            "error_kind": "timeout",
            "hint": "The code ran too long. Either the snippet is genuinely slow or it deadlocked. Do not retry blindly; consider simplifying or asking the user before re-running."
        })
        .to_string()),
    }
}
