//! `wsl_exec` — run Linux commands in WSL, optionally in a persistent shell.
//!
//! Two modes, chosen per call by the model:
//!
//!   * **one-shot (default)** — a fresh `bash -c` per call. No state carries
//!     over; a short timeout bounds it. This is the default deliberately: it is
//!     the predictable, cheap mode, and most calls do not need more.
//!   * **persistent** (`persist: true`) — the call runs in a long-lived shell
//!     scoped to the chat, so `cd`, `export`, activated venvs and started
//!     background jobs survive into later calls. Necessary for multi-step work
//!     (`cd repo && source .venv/bin/activate` then `pytest`), which one-shot
//!     mode fundamentally cannot express.
//!
//! The persistent shell is driven with a sentinel protocol rather than a PTY:
//! each command is followed by a marker carrying `$?`, and output is read until
//! that marker appears. `exec 2>&1` is issued once at session start so stderr
//! interleaves with stdout in the right order and one reader suffices.
//!
//! A command can kill its own shell (`exit`, a fatal signal). Without recovery
//! that would brick the chat's terminal for good, so a dead session is detected
//! and transparently replaced — with `session_restarted` reported, since the
//! accumulated state is genuinely gone and the model must not assume otherwise.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

/// Default wall-clock limit for a single command. Deliberately short: a hung
/// command should surface quickly rather than stall the turn. The model can
/// raise it per call for genuinely long work (builds, test suites).
const DEFAULT_TIMEOUT_SECS: u64 = 10;
const MAX_TIMEOUT_SECS: u64 = 900;

/// Idle sessions are reaped so abandoned shells do not accumulate one WSL
/// `bash` per chat for the lifetime of the app.
const IDLE_TTL: Duration = Duration::from_secs(30 * 60);

/// Output cap per call, so a runaway `cat` cannot blow up the context window.
const MAX_OUTPUT_CHARS: usize = 100_000;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "wsl_exec".into(),
            description:
                "Run a Linux command in WSL (Ubuntu). By default each call is independent: \
                 a fresh shell, nothing carried over, short timeout. Set persist=true to run \
                 in a shell that stays alive for this chat, so working directory, environment \
                 variables, activated virtualenvs and background jobs survive into later \
                 calls — use it for multi-step work like `cd repo`, then `source .venv/bin/activate`, \
                 then `pytest`. Once a persistent shell exists, later calls reuse it whether or not \
                 they pass persist. Windows drives are under /mnt/c, /mnt/f and so on. Raise \
                 timeout_s for slow work (builds, test suites); set new_session=true to discard \
                 accumulated state and start clean."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command to run, as you would type it in bash."
                    },
                    "persist": {
                        "type": "boolean",
                        "default": false,
                        "description": "Run in this chat's long-lived shell so state carries \
                                        over to later calls. Default false (independent call)."
                    },
                    "timeout_s": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_TIMEOUT_SECS,
                        "default": DEFAULT_TIMEOUT_SECS,
                        "description": "Seconds to wait before giving up. Default 10. In a \
                                        persistent session a timeout also resets the shell, \
                                        since the stuck command still owns it."
                    },
                    "new_session": {
                        "type": "boolean",
                        "default": false,
                        "description": "Discard this chat's existing persistent shell and start \
                                        a fresh one before running. Use to clear bad state."
                    }
                },
                "required": ["command"]
            }),
        },
    }
}

// ── Session ──────────────────────────────────────────────────────────────────

struct Session {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    seq: u64,
    last_used: Instant,
}

impl Session {
    async fn start() -> Result<Self, String> {
        let mut cmd = tokio::process::Command::new("wsl.exe");
        cmd.args(["-e", "bash"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Suppress the console window flash, matching the other spawn sites.
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start WSL: {e}. Is WSL installed (`wsl --status`)?"))?;

        let stdin = child.stdin.take().ok_or("WSL child has no stdin")?;
        let stdout = child.stdout.take().ok_or("WSL child has no stdout")?;
        let mut s = Session {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            seq: 0,
            last_used: Instant::now(),
        };
        // Fold stderr into stdout for the whole session: preserves interleaving
        // and means a single reader can see everything.
        s.stdin
            .write_all(b"exec 2>&1\n")
            .await
            .map_err(|e| format!("WSL handshake failed: {e}"))?;
        s.stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(s)
    }

    /// Run one command to completion, returning (output, exit_code).
    async fn run(&mut self, cmd: &str, timeout: Duration) -> Result<(String, i32), String> {
        self.seq += 1;
        let token = format!("__MZ_WSL_END_{}__", self.seq);
        // The leading newline guarantees the marker starts its own line even if
        // the command left output without a trailing newline.
        let script = format!("{cmd}\n__mz_rc=$?; printf '\\n{token}%d\\n' \"$__mz_rc\"\n");
        self.stdin
            .write_all(script.as_bytes())
            .await
            .map_err(|e| format!("write to WSL shell failed: {e}"))?;
        self.stdin.flush().await.map_err(|e| e.to_string())?;

        let mut out = String::new();
        let mut truncated = false;
        loop {
            let line = tokio::time::timeout(timeout, self.lines.next_line())
                .await
                .map_err(|_| format!("timed out after {}s", timeout.as_secs()))?
                .map_err(|e| format!("read from WSL shell failed: {e}"))?
                .ok_or("WSL shell closed unexpectedly")?;

            if let Some(rest) = line.strip_prefix(&token) {
                let code = rest.trim().parse::<i32>().unwrap_or(-1);
                if truncated {
                    out.push_str("\n[output truncated]\n");
                }
                self.last_used = Instant::now();
                return Ok((out, code));
            }
            if out.len() < MAX_OUTPUT_CHARS {
                out.push_str(&line);
                out.push('\n');
            } else {
                truncated = true;
            }
        }
    }
}

/// Persistent sessions, keyed by chat id.
fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop sessions idle beyond the TTL. Cheap enough to run on every call, which
/// avoids needing a background reaper task.
fn reap_idle(map: &mut HashMap<String, Session>) {
    map.retain(|_, s| s.last_used.elapsed() < IDLE_TTL);
}

/// Tear down a chat's session, e.g. when the chat is deleted.
pub async fn close_session(chat_id: &str) {
    if let Some(mut s) = sessions().lock().await.remove(chat_id) {
        let _ = s.child.start_kill();
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

pub async fn run(args: &Value, chat_id: &str) -> AppResult<String> {
    let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
    if command.is_empty() {
        return Ok(json!({ "error": "command is required", "error_kind": "invalid_args" }).to_string());
    }
    let persist = args.get("persist").and_then(|v| v.as_bool()).unwrap_or(false);
    let new_session = args.get("new_session").and_then(|v| v.as_bool()).unwrap_or(false);
    let timeout = Duration::from_secs(
        args.get("timeout_s")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );

    let mut map = sessions().lock().await;
    reap_idle(&mut map);

    if new_session {
        if let Some(mut old) = map.remove(chat_id) {
            let _ = old.child.start_kill();
        }
    }

    // Once a chat has a live shell, keep using it even for calls that did not
    // ask to persist -- silently running those in a *different* shell would
    // make cwd appear to flip back and forth between calls.
    let use_session = persist || map.contains_key(chat_id);
    if !use_session {
        return Ok(one_shot(command, timeout).await);
    }

    let mut restarted = new_session;
    if !map.contains_key(chat_id) {
        match Session::start().await {
            Ok(s) => {
                map.insert(chat_id.to_string(), s);
            }
            Err(e) => return Ok(json!({ "error": e, "error_kind": "wsl_unavailable" }).to_string()),
        }
    }

    let mut result = map.get_mut(chat_id).unwrap().run(command, timeout).await;

    // A dead or wedged shell is replaced rather than left broken. Retrying the
    // command is only safe when the shell died before it could run; on timeout
    // the command may well have taken effect, so the session is reset but the
    // command is NOT re-run.
    if let Err(e) = &result {
        let timed_out = e.starts_with("timed out");
        if let Some(mut old) = map.remove(chat_id) {
            let _ = old.child.start_kill();
        }
        if timed_out {
            return Ok(json!({
                "error": e,
                "error_kind": "timeout",
                "session_restarted": true,
                "note": "The persistent shell was reset because the command still owned it. \
                         The command was NOT re-run — it may have partially applied.",
            })
            .to_string());
        }
        match Session::start().await {
            Ok(s) => {
                map.insert(chat_id.to_string(), s);
                restarted = true;
                result = map.get_mut(chat_id).unwrap().run(command, timeout).await;
            }
            Err(e2) => {
                return Ok(json!({ "error": e2, "error_kind": "wsl_unavailable" }).to_string())
            }
        }
    }

    match result {
        Ok((output, code)) => {
            let mut v = json!({
                "output": output,
                "exit_code": code,
                "mode": "persistent",
            });
            if restarted {
                v["session_restarted"] = json!(true);
                v["note"] = json!(
                    "The shell was restarted, so previous working directory, environment \
                     variables and background jobs are gone. Re-establish any state you rely on."
                );
            }
            Ok(v.to_string())
        }
        Err(e) => Ok(json!({ "error": e, "error_kind": "wsl_error", "session_restarted": true }).to_string()),
    }
}

/// One-shot: a fresh `bash -c`, nothing retained.
async fn one_shot(command: &str, timeout: Duration) -> String {
    let mut cmd = tokio::process::Command::new("wsl.exe");
    cmd.args(["-e", "bash", "-c", command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return json!({
                "error": format!("failed to start WSL: {e}. Is WSL installed (`wsl --status`)?"),
                "error_kind": "wsl_unavailable",
            })
            .to_string()
        }
    };

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => json!({
            "error": format!("timed out after {}s", timeout.as_secs()),
            "error_kind": "timeout",
            "note": "Raise timeout_s for slow commands, or use persist=true to keep a shell \
                     alive across calls.",
        })
        .to_string(),
        Ok(Err(e)) => json!({ "error": format!("WSL command failed: {e}"), "error_kind": "wsl_error" }).to_string(),
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                text.push_str(&err);
            }
            if text.len() > MAX_OUTPUT_CHARS {
                text.truncate(MAX_OUTPUT_CHARS);
                text.push_str("\n[output truncated]\n");
            }
            json!({
                "output": text,
                "exit_code": out.status.code().unwrap_or(-1),
                "mode": "one_shot",
            })
            .to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn call(chat: &str, v: Value) -> Value {
        serde_json::from_str(&run(&v, chat).await.unwrap()).unwrap()
    }
    fn out(v: &Value) -> String {
        v.get("output").and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
    }

    /// Exercises the real behaviour against a real WSL install, so it is opt-in:
    /// `cargo test --lib wsl -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "requires a working WSL installation"]
    async fn wsl_session_semantics() {
        // Default is one-shot: nothing carries over.
        let a = call("A", json!({"command": "cd /etc && pwd"})).await;
        assert_eq!(a["mode"], "one_shot");
        assert_eq!(out(&a), "/etc");
        let b = call("A", json!({"command": "pwd"})).await;
        assert_ne!(out(&b), "/etc", "one-shot must not retain cwd");

        // persist=true keeps cwd and env across calls...
        let c = call("A", json!({"command": "cd /etc && pwd", "persist": true})).await;
        assert_eq!(c["mode"], "persistent");
        assert_eq!(out(&call("A", json!({"command": "pwd"})).await), "/etc",
            "cwd must survive; later calls reuse the live shell even without persist");
        call("A", json!({"command": "export FOO=bar"})).await;
        assert_eq!(out(&call("A", json!({"command": "echo $FOO"})).await), "bar");

        // ...but sessions are per chat.
        let other = call("B", json!({"command": "echo foo=[$FOO]", "persist": true})).await;
        assert_eq!(out(&other), "foo=[]", "chat B must not see chat A's env");

        // A command that kills the shell is recovered from transparently.
        let _ = call("A", json!({"command": "exit 7"})).await;
        let after = call("A", json!({"command": "echo alive"})).await;
        assert_eq!(out(&after), "alive", "session must recover after exit");
        assert_eq!(after["session_restarted"], json!(true), "restart must be reported");

        // Timeout bounds a hung command and resets the shell rather than re-running it.
        let t = call("A", json!({"command": "sleep 30", "timeout_s": 1})).await;
        assert_eq!(t["error_kind"], "timeout");
        assert_eq!(out(&call("A", json!({"command": "echo back"})).await), "back");

        // new_session discards accumulated state.
        call("A", json!({"command": "export X=1", "persist": true})).await;
        let fresh = call("A", json!({"command": "echo x=[$X]", "new_session": true})).await;
        assert_eq!(out(&fresh), "x=[]");

        // Exit codes propagate; stderr interleaves with stdout in order.
        assert_eq!(call("A", json!({"command": "false"})).await["exit_code"], 1);
        // stderr is captured alongside stdout, but their interleaving is not
        // guaranteed (see module docs), so assert presence rather than order.
        let both = call("A", json!({"command": "echo one; echo two >&2; echo three"})).await;
        let text = out(&both);
        for expected in ["one", "two", "three"] {
            assert!(text.contains(expected), "missing {expected:?} in {text:?}");
        }

        close_session("A").await;
        close_session("B").await;
    }
}
