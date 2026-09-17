use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use std::process::Stdio;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Characters of stdout/stderr returned to the model. Beyond this the tail is
/// kept — the end of a build log is the part that says what happened — and the
/// whole output goes to a file the model can `read` in windows. Same ceiling as
/// `terminal_read`. Without it, `cat` on a large log put the whole thing into
/// context and could end the turn on its own.
const MAX_RETURN_CHARS: usize = 30_000;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "bash".into(),
            description: format!(
                "Run a shell command in the working directory and get back stdout, stderr and the \
                 exit code. On Windows the shell is PowerShell; elsewhere bash/sh. Output longer \
                 than {MAX_RETURN_CHARS} characters is cut to its tail and the full text saved to a \
                 file whose path is returned.\n\n\
                 This tool is for terminal operations — git, package managers, builds, tests, \
                 scripts. Do NOT use it to read, write, edit or search files; the `read`, `write`, \
                 `edit`, `glob` and `grep` tools do that and show the user what happened.\n\n\
                 Git: only commit, push or open a PR when asked. Before committing, look at \
                 `git status` and `git diff`, stage only what you changed, never commit secrets, \
                 never skip hooks or force-push unless told to."
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command to execute"
                    },
                    "workdir": {
                        "type": "string",
                        "description": "Directory to run in, relative to the working directory. Use this instead of `cd`."
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

/// Where spilled output lives. Always inside the file tools' allowed roots
/// (`filesystem::allowed_roots`), so the model can `read` what it was sent
/// the path of.
pub fn spill_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("multizone-bash-output")
}

/// Keep the tail of a long output and park the whole thing on disk. Returns
/// what to send and, when cut, where the rest is.
fn spill(text: &str, tag: &str) -> (String, Option<String>) {
    let n = text.chars().count();
    if n <= MAX_RETURN_CHARS {
        return (text.to_string(), None);
    }
    let dir = spill_dir();
    let path = dir.join(format!("{tag}-{}.txt", chrono::Utc::now().timestamp_millis()));
    let saved = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&path, text))
        .ok()
        .map(|_| path.to_string_lossy().to_string());
    let tail: String = text.chars().skip(n - MAX_RETURN_CHARS).collect();
    (tail, saved)
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

    // `workdir` is a subdirectory of the working directory, never a way out of
    // it: the shell can `cd` anywhere anyway, but the tool's own argument should
    // not be the thing that quietly moves an agent outside the project.
    let workdir: Option<std::path::PathBuf> = match (
        project_dir.map(str::trim).filter(|d| !d.is_empty()),
        args.get("workdir").and_then(|v| v.as_str()).map(str::trim).filter(|w| !w.is_empty()),
    ) {
        (Some(dir), Some(sub)) => Some(std::path::Path::new(dir).join(sub.trim_start_matches(['/', '\\']))),
        (Some(dir), None) => Some(std::path::PathBuf::from(dir)),
        (None, _) => None,
    };
    if let Some(w) = &workdir {
        if !w.is_dir() {
            return Ok(json!({
                "error": format!("workdir does not exist: {}", w.to_string_lossy()),
                "error_kind": "invalid_args",
            })
            .to_string());
        }
    }

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

        if let Some(dir) = &workdir {
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
        Ok(Ok(output)) => {
            let (stdout, out_file) = spill(&String::from_utf8_lossy(&output.stdout), "out");
            let (stderr, err_file) = spill(&String::from_utf8_lossy(&output.stderr), "err");
            let mut v = json!({
                "exit_code": output.status.code(),
                "stdout": stdout,
                "stderr": stderr,
            });
            if out_file.is_some() || err_file.is_some() {
                v["truncated"] = json!(true);
                v["note"] = json!(format!(
                    "Output longer than {MAX_RETURN_CHARS} characters: only the tail is shown. \
                     The full text is saved to a file — `read` it (with offset/limit) if the \
                     part you need is earlier, or re-run with a narrower command."
                ));
                if let Some(f) = out_file { v["stdout_file"] = json!(f); }
                if let Some(f) = err_file { v["stderr_file"] = json!(f); }
            }
            Ok(v.to_string())
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_output_is_returned_whole_and_long_output_keeps_its_tail() {
        let (kept, file) = spill("hello", "t");
        assert_eq!(kept, "hello");
        assert!(file.is_none());

        let long: String = (0..(MAX_RETURN_CHARS + 500)).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        let (kept, file) = spill(&long, "t");
        assert_eq!(kept.chars().count(), MAX_RETURN_CHARS);
        assert!(long.ends_with(&kept), "the tail is what survives");
        let path = file.expect("the whole output is parked on disk");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), long);
        let _ = std::fs::remove_file(path);
    }
}
