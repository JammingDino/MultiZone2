//! `terminal` — long-lived terminals an agent can start, watch, and type into.
//!
//! `bash` and `wsl_exec` both answer the same shape of question: run this,
//! tell me what it printed. Neither can express *starting something and leaving it
//! running* — a dev server, a REPL, a docker log follow, a program that asks a
//! question part-way through. `bash` blocks until the process exits, so a
//! server either times out or hangs the turn; `wsl_exec`'s persistent shell reads
//! until a sentinel marker, so a command that never finishes never returns.
//!
//! A terminal here is a process the app keeps for as long as it is running, with a
//! reader draining its output into a bounded window the whole time. Nothing blocks
//! on the process finishing: [`start`] returns as soon as the terminal exists,
//! [`read`] returns whatever has arrived, and [`write`] types into its stdin.
//! Several terminals run at once and are addressed by id (`t1`, `t2`, …).
//!
//! ## Timing
//!
//! Driving an interactive program is a timing problem: the password prompt has to
//! be on screen before the password is typed. Three controls, on every call that
//! can wait:
//!
//!   * `delay_ms` — wait this long *before* typing. The blunt instrument, and the
//!     one that always works: start a server, then send the sudo password five
//!     seconds later.
//!   * `wait_for` — a regex to wait for in the new output, up to `timeout_ms`.
//!     Better than a delay when the program says something recognisable, because
//!     it returns the moment the prompt appears instead of always paying the
//!     worst case. Reported back as `matched`, so a false is visible rather than
//!     silently proceeding.
//!   * `wait_ms` — after typing, collect output for this long before returning.
//!
//! ## Pipes, not a PTY
//!
//! stdin/stdout/stderr are pipes, as everywhere else in this codebase. That covers
//! servers, build tools, REPLs and anything that reads stdin — but not programs
//! that insist on a real terminal:
//!
//!   * `sudo` reads the password from `/dev/tty` unless given `-S`.
//!   * `ssh` password prompts and full-screen TUIs (`top`, `vim`) do not work.
//!   * Ctrl-C cannot be sent: 0x03 on a pipe is a byte, not a signal. Stop the
//!     process with [`stop`].
//!
//! Children also block-buffer their output when stdout is a pipe, so a chatty
//! program can look silent. `PYTHONUNBUFFERED` is set for the child to cover the
//! most common case; the tool description names the flag for the rest.
//!
//! ## Lifetime and scope
//!
//! Terminals are deliberately not reaped on idle — "still running an hour later"
//! is the entire point — so they live until stopped, until their process exits, or
//! until the app closes (see [`shutdown_all`], wired to the Tauri exit event).
//!
//! Visibility is scoped to the *session*: the root chat plus every sub-agent
//! beneath it, the same scope [`crate::tools::teamwork`] coordinates over. A leader
//! can start a dev server and have five sub-agents query it; an unrelated chat
//! cannot see it at all.

use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, Notify};

/// Terminals one session may hold at once. A runaway agent that starts a terminal
/// per step would otherwise leave processes running for the life of the app.
const MAX_TERMINALS_PER_SESSION: usize = 8;

/// Output window per terminal. A server left running for an hour prints more than
/// anyone will read; the oldest output falls off the front, and a read whose
/// cursor fell off is told so rather than quietly skipping ahead.
const BUFFER_CHARS: usize = 200_000;
/// Slack before trimming, so a chatty process doesn't memmove the window on every
/// chunk it prints.
const BUFFER_SLACK: usize = 32_000;

/// Cap on what one call returns, so a terminal that printed a megabyte can't take
/// the context window with it.
const MAX_RETURN_CHARS: usize = 30_000;

const DEFAULT_START_WAIT_MS: u64 = 700;
const DEFAULT_WRITE_WAIT_MS: u64 = 400;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// A wait that names a finishing condition is waiting on *work*, not on a prompt
/// appearing, so it gets a working-length default instead of the fifteen seconds
/// that suits "is it asking for the password yet".
const DEFAULT_UNTIL_TIMEOUT_MS: u64 = 300_000;
/// How long without output counts as quiet, for `until: "idle"`.
const DEFAULT_IDLE_MS: u64 = 2_000;

const MAX_DELAY_MS: u64 = 120_000;
const MAX_WAIT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

// ── Tool definitions ─────────────────────────────────────────────────────────

pub fn definitions() -> Vec<Tool> {
    vec![
        start_definition(),
        write_definition(),
        read_definition(),
        list_definition(),
        stop_definition(),
    ]
}

fn tool(name: &str, description: &str, parameters: Value) -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: name.into(),
            description: description.into(),
            parameters,
        },
    }
}

/// Shared by every function that can wait, so the timing vocabulary is identical
/// wherever it appears.
///
/// `until` is the one that stops a read loop. Without it the only questions this
/// tool could answer were "has this text appeared yet" and "what has it printed
/// in the last N milliseconds" — both of which a caller waiting on a build has to
/// ask over and over, paying for the transcript on every turn and still learning
/// late that it finished. `until` names the condition instead, so the call
/// returns once, at the moment it holds.
fn wait_props() -> Value {
    json!({
        "until": {
            "type": "string",
            "enum": ["exit", "idle", "output"],
            "description": "End the call when the process exits, when its output has gone quiet for `idle_ms` (a server that has booted), or at the next output. One call with a generous `timeout_ms`, not a read loop."
        },
        "idle_ms": { "type": "integer", "description": "What counts as quiet for until=idle. Default 2000." },
        "wait_for": {
            "type": "string",
            "description": "Regex to wait for in the new output, e.g. \"[Pp]assword:\". Returns the moment it matches; `matched` says whether it did."
        },
        "timeout_ms": { "type": "integer", "description": "Cap on the wait. Default 15000; 300000 with `until`." },
        "wait_ms": { "type": "integer", "description": "With no wait_for, collect output for this long." }
    })
}

fn start_definition() -> Tool {
    tool(
        "terminal_start",
        "Start a process that keeps running after this call returns — a server, a REPL, a log to follow, anything you must type into later. For a command that finishes on its own use `bash`, or start it here with `until: \"exit\"` if it outlives that timeout. Pipes, not a TTY: pass `sudo -S`, and unbuffer output (`python -u`).",
        {
            let mut props = json!({
                "command": {
                    "type": "string",
                    "description": "Program to run, as you would type it. Omit for a bare shell to type into."
                },
                "name": { "type": "string", "description": "Short label, e.g. \"api-server\"." },
                "shell": {
                    "type": "string",
                    "enum": ["auto", "powershell", "cmd", "bash", "wsl"],
                    "description": "Default auto: PowerShell on Windows, bash elsewhere."
                },
                "cwd": { "type": "string", "description": "Defaults to the chat's project directory." }
            });
            merge(&mut props, wait_props());
            json!({ "type": "object", "properties": props })
        },
    )
}

fn write_definition() -> Tool {
    tool(
        "terminal_write",
        "Type into a running terminal — a command, or an answer to a prompt it is waiting on. Returns only the output that followed. Use `delay_ms` or `wait_for` to let the program reach its prompt first.",
        {
            let mut props = json!({
                "terminal_id": { "type": "string", "description": "From terminal_start or terminal_list." },
                "input": { "type": "string", "description": "Text to type. A newline is appended unless submit is false." },
                "submit": { "type": "boolean", "description": "False sends no trailing newline." },
                "delay_ms": {
                    "type": "integer",
                    "description": "Wait this long BEFORE typing — lets a prompt appear first."
                }
            });
            merge(&mut props, wait_props());
            json!({ "type": "object", "properties": props, "required": ["terminal_id", "input"] })
        },
    )
}

fn read_definition() -> Tool {
    tool(
        "terminal_read",
        "Read what a terminal has printed, and whether it is still running. Pass a previous call's `cursor` for only what is new; otherwise the tail. Never poll: one call with `cursor` and `until: \"exit\"` returns the moment a long job finishes.",
        {
            let mut props = json!({
                "terminal_id": { "type": "string" },
                "cursor": {
                    "type": "integer",
                    "description": "From any terminal call; reads only what arrived since."
                },
                "tail_lines": {
                    "type": "integer",
                    "description": "With no cursor, trailing lines to return. Default 200."
                }
            });
            merge(&mut props, wait_props());
            json!({ "type": "object", "properties": props, "required": ["terminal_id"] })
        },
    )
}

fn list_definition() -> Tool {
    tool(
        "terminal_list",
        "This conversation's terminals — id, label, whether each is running, output waiting. Sub-agents see the leader's.",
        json!({ "type": "object", "properties": {} }),
    )
}

fn stop_definition() -> Tool {
    tool(
        "terminal_stop",
        "Stop a terminal and return its final output. They otherwise run until the app closes, so stop what you finish with.",
        json!({
            "type": "object",
            "properties": {
                "terminal_id": { "type": "string", "description": "Omit with all=true." },
                "all": { "type": "boolean", "description": "Stop all of this conversation's terminals." }
            }
        }),
    )
}

/// Fold `extra`'s keys into `target`, both JSON objects.
fn merge(target: &mut Value, extra: Value) {
    if let (Some(t), Some(e)) = (target.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            t.insert(k.clone(), v.clone());
        }
    }
}

// ── Output window ────────────────────────────────────────────────────────────

/// A terminal's output as a bounded sliding window, plus enough bookkeeping for a
/// cursor to stay meaningful after the front has been dropped.
struct Buffer {
    text: String,
    len_chars: usize,
    /// Characters that have fallen off the front.
    dropped: u64,
    /// Wall-clock ms of the last append.
    last_at: u64,
}

impl Buffer {
    fn new() -> Self {
        Buffer { text: String::new(), len_chars: 0, dropped: 0, last_at: now_ms() }
    }

    /// Total characters ever printed — the value handed back as `cursor`.
    fn total(&self) -> u64 {
        self.dropped + self.len_chars as u64
    }

    fn push(&mut self, s: &str) {
        self.text.push_str(s);
        self.len_chars += s.chars().count();
        self.last_at = now_ms();
        if self.len_chars > BUFFER_CHARS + BUFFER_SLACK {
            let excess = self.len_chars - BUFFER_CHARS;
            let byte = self
                .text
                .char_indices()
                .nth(excess)
                .map(|(i, _)| i)
                .unwrap_or(self.text.len());
            self.text.drain(..byte);
            self.dropped += excess as u64;
            self.len_chars -= excess;
        }
    }

    /// Everything after `cursor`. The flag reports that the cursor pointed at
    /// output already dropped, so the caller knows it has a hole rather than a
    /// complete record.
    fn since(&self, cursor: u64) -> (String, bool) {
        let lost = cursor < self.dropped;
        let skip = cursor.max(self.dropped) - self.dropped;
        let text = self.text.chars().skip(skip as usize).collect();
        (text, lost)
    }

    fn tail(&self, lines: usize) -> String {
        let mut start = self.text.len();
        let mut seen = 0;
        for (i, c) in self.text.char_indices().rev() {
            if c == '\n' {
                seen += 1;
                if seen > lines {
                    start = i + 1;
                    break;
                }
            }
            start = i;
        }
        self.text[start..].to_string()
    }
}

// ── Terminal ─────────────────────────────────────────────────────────────────

/// What a wait is waiting *for* — the `until` argument, once parsed.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Goal {
    /// The process finishes. The one that turns a poll into a single call.
    Exit,
    /// Output stops for this long — a server that has finished booting, or a
    /// build that is between phases.
    Idle(Duration),
    /// Anything at all is printed.
    Output,
}

struct Terminal {
    id: String,
    name: String,
    shell: String,
    command: Option<String>,
    cwd: Option<String>,
    /// Root chat of the session that owns this terminal (see module docs).
    session: String,
    created_at: u64,
    pid: Option<u32>,
    /// Held separately from the output window so a write to one terminal never
    /// waits on a read of another.
    stdin: Mutex<Option<ChildStdin>>,
    /// Shared with the reader tasks, which fill it for as long as the process
    /// lives — including between tool calls, so nothing printed is missed.
    out: Arc<Mutex<Buffer>>,
    /// Rung on every chunk of output and on exit, so a waiter wakes the moment
    /// there is something to see instead of polling.
    bell: Arc<Notify>,
    /// Written by the supervisor task once the process is reaped.
    exit: Arc<Mutex<Option<i32>>>,
    /// Consumed once, by [`Terminal::kill`].
    kill: Mutex<Option<oneshot::Sender<()>>>,
}

impl Terminal {
    async fn exit_code(&self) -> Option<i32> {
        *self.exit.lock().await
    }

    async fn running(&self) -> bool {
        self.exit.lock().await.is_none()
    }

    /// Stop the process *and everything it started*.
    ///
    /// A shell's children are not its own to lose: `terminal_start` with a
    /// command runs it under a shell, so the thing the user cares about — the
    /// server — is a grandchild. Killing only the direct child leaves it holding
    /// its port with nothing left to stop it from.
    ///
    /// Order matters, and getting it wrong is silent. Both mechanisms below find
    /// the descendants by walking links that only exist while the parent is
    /// alive, so the tree has to come down *before* the supervisor reaps the
    /// shell. Kill the shell first and the server is simply re-parented, out of
    /// reach, still serving.
    async fn kill(&self) {
        if let Some(pid) = self.pid {
            kill_tree(pid).await;
        }
        // Then let the supervisor reap, so `exit` is recorded either way — and so
        // a terminal with no pid still stops.
        if let Some(tx) = self.kill.lock().await.take() {
            let _ = tx.send(());
        }
    }

    /// Wait until `pattern` matches the output after `from`, the timeout expires,
    /// or the process exits. Returns (new output, matched).
    ///
    /// The pattern case of [`wait_until`](Self::wait_until), kept under its own
    /// name because "wait for the prompt" is what most callers are doing.
    async fn wait_for_pattern(
        &self,
        from: u64,
        pattern: &regex::Regex,
        timeout: Duration,
    ) -> (String, bool) {
        let (text, reason) = self.wait_until(from, Some(pattern), Goal::Exit, timeout).await;
        (text, reason == "match")
    }

    /// Wait for a named finishing condition, and say which one ended the wait.
    ///
    /// This is what makes one call enough. A caller that wants to know when a
    /// build finishes says so once and is told once, at the moment it happens,
    /// instead of reading the buffer on a timer — which pays for the transcript
    /// every turn and still learns late.
    ///
    /// `pattern` is an *additional* early exit rather than the goal, so
    /// `wait_for` and `until` compose: whichever holds first returns.
    ///
    /// `Notify` keeps no permit for a notification nobody was waiting on, so the
    /// waiter is armed with `enable()` *before* the buffer is read. Registering
    /// after the read would drop any output that landed in between, and the wait
    /// would then run to its full timeout with the answer already on screen.
    async fn wait_until(
        &self,
        from: u64,
        pattern: Option<&regex::Regex>,
        goal: Goal,
        timeout: Duration,
    ) -> (String, &'static str) {
        let deadline = tokio::time::Instant::now() + timeout;
        // Quiet is measured from the start of the wait as well as from the last
        // chunk: a process that went silent before the call is idle *now*, and
        // should not have to print something first to be allowed to say so.
        let opened = now_ms();

        loop {
            let waiter = self.bell.notified();
            tokio::pin!(waiter);
            waiter.as_mut().enable();

            let (text, last_at, total) = {
                let buf = self.out.lock().await;
                (buf.since(from).0, buf.last_at, buf.total())
            };
            if let Some(re) = pattern {
                if re.is_match(&text) {
                    return (text, "match");
                }
            }
            // A dead process prints nothing more, so waiting on one is waiting out
            // a timeout that can only fail — and its exit satisfies every goal
            // below, which is the whole point of `until: "exit"`.
            if !self.running().await {
                return (text, "exit");
            }
            if goal == Goal::Output && total > from {
                return (text, "output");
            }

            // How long to sleep before looking again. Only `idle` has a deadline
            // of its own; the rest wake on the bell or on the timeout.
            let wake = match goal {
                Goal::Idle(quiet) => {
                    let quiet_ms = quiet.as_millis() as u64;
                    let silent_for = now_ms().saturating_sub(last_at.max(opened));
                    if silent_for >= quiet_ms {
                        return (text, "idle");
                    }
                    (tokio::time::Instant::now() + Duration::from_millis(quiet_ms - silent_for))
                        .min(deadline)
                }
                _ => deadline,
            };

            if tokio::time::timeout_at(wake, waiter).await.is_err() {
                if tokio::time::Instant::now() >= deadline {
                    let (text, _) = self.out.lock().await.since(from);
                    return (text, "timeout");
                }
                // An idle window elapsed with the bell silent: round again, and
                // the check at the top of the loop is what returns.
            }
        }
    }

    /// Collect output for a fixed span, returning early only if the process exits.
    async fn wait_span(&self, from: u64, span: Duration) -> String {
        let deadline = tokio::time::Instant::now() + span;
        loop {
            let waiter = self.bell.notified();
            tokio::pin!(waiter);
            waiter.as_mut().enable();

            if !self.running().await {
                break;
            }
            if tokio::time::timeout_at(deadline, waiter).await.is_err() {
                break;
            }
        }
        self.out.lock().await.since(from).0
    }
}

// ── Registry ─────────────────────────────────────────────────────────────────

fn registry() -> &'static Mutex<HashMap<String, Arc<Terminal>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<Terminal>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!("t{}", N.fetch_add(1, Ordering::Relaxed) + 1)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Every terminal in a session, oldest first. Cloned out so the registry lock is
/// never held across a wait.
async fn session_terminals(session: &str) -> Vec<Arc<Terminal>> {
    let mut v: Vec<Arc<Terminal>> = registry()
        .lock()
        .await
        .values()
        .filter(|t| t.session == session)
        .cloned()
        .collect();
    v.sort_by_key(|t| t.created_at);
    v
}

/// Resolve a terminal id within the caller's session. Refuses ids owned by
/// another conversation rather than reaching across, so one chat's dev server is
/// not something an unrelated chat can type into.
async fn lookup(id: &str, session: &str) -> Result<Arc<Terminal>, Value> {
    let found = registry().lock().await.get(id).cloned();
    match found {
        Some(t) if t.session == session => Ok(t),
        Some(_) => Err(json!({
            "error": format!("terminal {id} belongs to another conversation"),
            "error_kind": "not_found",
        })),
        None => {
            let open = session_terminals(session).await;
            Err(json!({
                "error": format!("no terminal {id}"),
                "error_kind": "not_found",
                "open_terminals": open.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
                "hint": "Call terminal_list, or terminal_start to open one. Terminals do not survive an app restart.",
            }))
        }
    }
}

/// Kill every terminal, for app shutdown. Without this, a server started through
/// the tool outlives the window that started it — on Windows a child is not taken
/// down with its parent.
pub async fn shutdown_all() {
    let all: Vec<Arc<Terminal>> = registry().lock().await.drain().map(|(_, t)| t).collect();
    for t in all {
        t.kill().await;
    }
}

/// Drop the terminals owned by a deleted chat's session.
pub async fn close_session(chat_id: &str) {
    let doomed: Vec<Arc<Terminal>> = {
        let mut map = registry().lock().await;
        let ids: Vec<String> = map
            .values()
            .filter(|t| t.session == chat_id)
            .map(|t| t.id.clone())
            .collect();
        ids.iter().filter_map(|id| map.remove(id)).collect()
    };
    for t in doomed {
        t.kill().await;
    }
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/// How to launch a terminal: the program, its arguments, and the label reported
/// back as `shell`.
struct Launch {
    prog: String,
    args: Vec<String>,
    label: String,
}

/// Kill a process and its descendants, best effort.
///
/// Windows has no process groups, but `taskkill /T` walks the live parent-pid
/// links and takes the tree with it. On Unix the children are in the process
/// group the terminal was spawned into (see `process_group` in
/// [`spawn_terminal`]), and a negative pid signals the whole group — done via
/// `kill(1)` rather than adding a libc dependency for one call.
async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status().await;
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("kill");
        cmd.args(["-KILL", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = cmd.status().await;
    }
}

/// PowerShell's `-EncodedCommand` payload: UTF-16LE, base64.
fn encode_command(command: &str) -> String {
    use base64::Engine;
    let utf16: Vec<u8> = command
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Candidates in preference order — the first that spawns wins, so a machine with
/// no `pwsh` falls back to Windows PowerShell without the caller knowing.
fn launches(shell: &str, command: Option<&str>) -> Vec<Launch> {
    let l = |prog: &str, args: Vec<&str>, label: &str| Launch {
        prog: prog.into(),
        args: args.into_iter().map(String::from).collect(),
        label: label.into(),
    };
    // With no command, PowerShell reads and executes piped stdin line by line, so
    // `-Command -` gives a session that can be typed into later.
    //
    // With a command, it has to *be* the process on the other end of the pipe, or
    // an answer typed later would go to the shell instead of the program waiting
    // for it. `-EncodedCommand` rather than `-Command <cmd>` because the command
    // is arbitrary user text: Windows argument escaping and PowerShell's own
    // re-parsing between them mangle anything containing quotes, `$` or newlines
    // (the same trap `shell.rs` sidesteps by piping the script in).
    let ps = |prog: &str| match command {
        Some(c) => Launch {
            prog: prog.into(),
            args: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-EncodedCommand".into(),
                encode_command(c),
            ],
            label: "powershell".into(),
        },
        None => Launch {
            prog: prog.into(),
            args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"]
                .into_iter()
                .map(String::from)
                .collect(),
            label: "powershell".into(),
        },
    };
    let sh = |prog: &str| match command {
        Some(c) => Launch {
            prog: prog.into(),
            args: vec!["-c".into(), c.into()],
            label: prog.into(),
        },
        None => l(prog, vec![], prog),
    };

    match shell {
        "cmd" => vec![match command {
            Some(c) => Launch { prog: "cmd".into(), args: vec!["/C".into(), c.into()], label: "cmd".into() },
            None => l("cmd", vec![], "cmd"),
        }],
        "bash" => vec![sh("bash"), sh("sh")],
        "wsl" => vec![match command {
            Some(c) => Launch {
                prog: "wsl.exe".into(),
                args: vec!["-e".into(), "bash".into(), "-c".into(), c.into()],
                label: "wsl".into(),
            },
            None => l("wsl.exe", vec!["-e", "bash"], "wsl"),
        }],
        "powershell" => vec![ps("pwsh"), ps("powershell")],
        _ => {
            #[cfg(windows)]
            {
                vec![ps("pwsh"), ps("powershell")]
            }
            #[cfg(not(windows))]
            {
                vec![sh("bash"), sh("sh")]
            }
        }
    }
}

/// Drain one pipe into the shared window until EOF.
///
/// Read as bytes rather than lines: an interactive program's prompt ("Password: ")
/// has no trailing newline, and a line reader would hold it back until the answer
/// it is waiting for had already been sent.
fn pump<R>(mut reader: R, out: Arc<Mutex<Buffer>>, bell: Arc<Notify>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut raw = [0u8; 4096];
        // A multi-byte character split across two reads would decode as garbage,
        // so the incomplete tail is carried into the next chunk.
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut raw).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&raw[..n]);
                    let text = match std::str::from_utf8(&carry) {
                        Ok(s) => {
                            let s = s.to_string();
                            carry.clear();
                            s
                        }
                        Err(e) => {
                            let good = e.valid_up_to();
                            let s = String::from_utf8_lossy(&carry[..good]).into_owned();
                            carry.drain(..good);
                            // A genuinely invalid sequence would never complete;
                            // don't let it wedge the carry buffer forever.
                            if carry.len() > 8 {
                                carry.clear();
                            }
                            s
                        }
                    };
                    if text.is_empty() {
                        continue;
                    }
                    out.lock().await.push(&text);
                    bell.notify_waiters();
                }
            }
        }
    });
}

async fn spawn_terminal(
    name: String,
    command: Option<String>,
    shell: &str,
    cwd: Option<String>,
    session: String,
) -> Result<Arc<Terminal>, Value> {
    let mut last_err = String::new();
    for launch in launches(shell, command.as_deref()) {
        let mut cmd = Command::new(&launch.prog);
        cmd.args(&launch.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            // Colour codes and progress spinners are noise to a model reading the
            // output, and block buffering makes a live process look dead.
            .env("TERM", "dumb")
            .env("NO_COLOR", "1")
            .env("PYTHONUNBUFFERED", "1");
        if let Some(dir) = &cwd {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // Its own process group, so stopping the terminal can signal everything
        // it started rather than just the shell. See `kill_tree`.
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                last_err = format!("{}: {e}", launch.prog);
                continue;
            }
        };

        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let out = Arc::new(Mutex::new(Buffer::new()));
        let bell = Arc::new(Notify::new());
        if let Some(o) = stdout {
            pump(o, out.clone(), bell.clone());
        }
        // stderr is folded into the same window: a program's error output belongs
        // in the transcript next to what it was doing, not in a separate stream.
        if let Some(e) = stderr {
            pump(e, out.clone(), bell.clone());
        }

        let exit: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));
        let (kill_tx, kill_rx) = oneshot::channel::<()>();

        // One task owns the child for its whole life: it either waits it out or is
        // told to kill it. Nothing else needs `&mut Child`, so nothing else has to
        // contend for it.
        {
            let exit = exit.clone();
            let bell = bell.clone();
            tokio::spawn(async move {
                let status = tokio::select! {
                    s = child.wait() => s,
                    _ = kill_rx => {
                        let _ = child.start_kill();
                        child.wait().await
                    }
                };
                *exit.lock().await = Some(status.ok().and_then(|s| s.code()).unwrap_or(-1));
                bell.notify_waiters();
            });
        }

        return Ok(Arc::new(Terminal {
            id: next_id(),
            name,
            shell: launch.label.clone(),
            command: command.clone(),
            cwd: cwd.clone(),
            session,
            created_at: now_ms(),
            pid,
            stdin: Mutex::new(stdin),
            out,
            bell,
            exit,
            kill: Mutex::new(Some(kill_tx)),
        }));
    }

    Err(json!({
        "error": format!("could not start a terminal. Last error: {last_err}"),
        "error_kind": "environment",
    }))
}

// ── Entry points ─────────────────────────────────────────────────────────────

/// Clamp a millisecond argument, so a model that asks to wait a day doesn't.
fn ms(args: &Value, key: &str, max: u64) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64()).map(|v| v.min(max))
}

fn s(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from)
}

/// Reduce raw terminal output to the text a reader would see.
///
/// Two things a real terminal does that a pipe does not. ANSI escapes survive
/// `TERM=dumb` in programs that colour unconditionally, and are pure noise in a
/// transcript. A carriage return means "redraw this line", which is how every
/// progress bar and spinner works — kept verbatim, a download would arrive as a
/// hundred copies of itself, so only what follows the last `\r` on a line is
/// kept, leaving the final state the user would have watched settle on.
fn clean_output(s: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // CSI (colour, cursor moves) and OSC (window title) — the two families
        // that actually show up on a pipe.
        regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
            .expect("static ANSI pattern")
    });
    let stripped = re.replace_all(s, "");
    if !stripped.contains('\r') {
        return stripped.into_owned();
    }

    let mut out = String::with_capacity(stripped.len());
    for (i, line) in stripped.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        // Searching back for the last non-empty segment also handles a CRLF pair,
        // whose trailing `\r` would otherwise read as "erase everything".
        if let Some(seg) = line.rsplit('\r').find(|seg| !seg.is_empty()) {
            out.push_str(seg);
        }
    }
    out
}

/// Trim from the front: the end of a long log is the part that says what happened.
fn clip(text: &str) -> (String, bool) {
    let n = text.chars().count();
    if n <= MAX_RETURN_CHARS {
        return (text.to_string(), false);
    }
    let tail: String = text.chars().skip(n - MAX_RETURN_CHARS).collect();
    (tail, true)
}

/// The status fields every call reports, so the model never has to guess whether
/// the thing it is talking to is still alive.
async fn envelope(t: &Terminal, output: &str, clipped: bool, lost: bool) -> Value {
    let mut v = json!({
        "terminal_id": t.id,
        "output": output,
        "cursor": t.out.lock().await.total(),
        "running": t.running().await,
    });
    if let Some(code) = t.exit_code().await {
        v["exit_code"] = json!(code);
    }
    if clipped {
        v["truncated"] = json!("only the last part of the output is shown; read again with a cursor to follow along");
    }
    if lost {
        v["gap"] = json!("output before this point has scrolled out of the buffer");
    }
    v
}

/// What a wait produced: the new output, whether `wait_for` matched, and — when
/// the call named a finishing condition — which one ended it.
struct Waited {
    text: String,
    matched: Option<bool>,
    /// `"exit"`, `"match"`, `"idle"`, `"output"` or `"timeout"`; `None` when the
    /// call only asked to collect output for a fixed span.
    reason: Option<&'static str>,
}

/// Apply whichever wait the call asked for, from cursor `from`.
async fn apply_wait(t: &Terminal, args: &Value, from: u64, default_ms: u64) -> Waited {
    let asked = s(args, "wait_for");
    let re = asked.as_deref().and_then(|p| regex::Regex::new(p).ok());
    // An unparseable pattern is the model's mistake, not a reason to return
    // nothing: it falls through as "no pattern" and is reported via `matched`.
    let bad_pattern = asked.is_some() && re.is_none();

    let goal = match s(args, "until").as_deref() {
        Some("exit") => Some(Goal::Exit),
        Some("idle") => Some(Goal::Idle(Duration::from_millis(
            ms(args, "idle_ms", MAX_WAIT_MS).unwrap_or(DEFAULT_IDLE_MS),
        ))),
        Some("output") => Some(Goal::Output),
        // An unrecognised value is not a licence to block for five minutes.
        _ => None,
    };

    // Nothing to wait *for*: collect output for a span, as before.
    if goal.is_none() && re.is_none() {
        let span = if bad_pattern {
            DEFAULT_TIMEOUT_MS.min(2_000)
        } else {
            ms(args, "wait_ms", MAX_WAIT_MS).unwrap_or(default_ms)
        };
        let text = t.wait_span(from, Duration::from_millis(span)).await;
        return Waited { text, matched: bad_pattern.then_some(false), reason: None };
    }

    // A named condition is worth minutes; a prompt that has not appeared in
    // fifteen seconds usually is not coming.
    let default_timeout = if goal.is_some() { DEFAULT_UNTIL_TIMEOUT_MS } else { DEFAULT_TIMEOUT_MS };
    let timeout =
        Duration::from_millis(ms(args, "timeout_ms", MAX_TIMEOUT_MS).unwrap_or(default_timeout));
    // With only a pattern, exit is still an early out — waiting for text from a
    // process that has stopped printing can only run the clock out.
    let (text, reason) = t
        .wait_until(from, re.as_ref(), goal.unwrap_or(Goal::Exit), timeout)
        .await;

    let matched = if bad_pattern {
        Some(false)
    } else {
        re.as_ref().map(|r| r.is_match(&text))
    };
    Waited { text, matched, reason: Some(reason) }
}

/// Report how the wait ended, and — when the clock ran out on something still
/// running — the single call that resumes it.
///
/// The hint is the point. Told only "still running", a caller reads again, and
/// again, paying for the output every turn; told the one call that returns at
/// the moment it finishes, it makes that call instead.
fn note_wait(v: &mut Value, w: &Waited) {
    if let Some(m) = w.matched {
        v["matched"] = json!(m);
    }
    let Some(reason) = w.reason else { return };
    v["waited_until"] = json!(reason);
    if reason == "timeout" && v["running"] == json!(true) {
        v["hint"] = json!(format!(
            "still running. Do not read again in a loop: make one call to terminal_read with cursor={} and until=\"exit\" (and a timeout_ms you are willing to wait), which returns at the moment it finishes.",
            v["cursor"]
        ));
    }
}

pub async fn start(
    args: &Value,
    db: &SqlitePool,
    chat_id: &str,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;

    let open = session_terminals(&session).await;
    let live = {
        let mut n = 0;
        for t in &open {
            if t.running().await {
                n += 1;
            }
        }
        n
    };
    if live >= MAX_TERMINALS_PER_SESSION {
        return Ok(json!({
            "error": format!("this conversation already has {live} terminals open (the limit)"),
            "error_kind": "limit",
            "hint": "Stop one with terminal_stop, or reuse an existing terminal from terminal_list.",
        })
        .to_string());
    }

    let command = s(args, "command");
    let shell = s(args, "shell").unwrap_or_else(|| "auto".into());
    let cwd = s(args, "cwd").or_else(|| project_dir.map(String::from));
    let name = s(args, "name")
        .or_else(|| command.as_ref().map(|c| c.chars().take(40).collect()))
        .unwrap_or_else(|| "shell".into());

    let term = match spawn_terminal(name, command, &shell, cwd, session).await {
        Ok(t) => t,
        Err(e) => return Ok(e.to_string()),
    };
    registry().lock().await.insert(term.id.clone(), term.clone());

    if let Some(delay) = ms(args, "delay_ms", MAX_DELAY_MS) {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let waited = apply_wait(&term, args, 0, DEFAULT_START_WAIT_MS).await;
    let (output, clipped) = clip(&clean_output(&waited.text));

    let mut v = envelope(&term, &output, clipped, false).await;
    v["name"] = json!(term.name);
    v["shell"] = json!(term.shell);
    if let Some(dir) = &term.cwd {
        v["cwd"] = json!(dir);
    }
    note_wait(&mut v, &waited);
    Ok(v.to_string())
}

pub async fn write(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;
    let Some(id) = s(args, "terminal_id") else {
        return Ok(json!({ "error": "terminal_id is required", "error_kind": "invalid_args" }).to_string());
    };
    let term = match lookup(&id, &session).await {
        Ok(t) => t,
        Err(e) => return Ok(e.to_string()),
    };
    let input = args.get("input").and_then(|v| v.as_str()).unwrap_or("");

    // The delay is the whole point of the parameter: it lets the program reach the
    // prompt before the answer arrives. Taken before the cursor is read, so the
    // returned output is what followed the input rather than what preceded it.
    if let Some(delay) = ms(args, "delay_ms", MAX_DELAY_MS) {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }

    if !term.running().await {
        let (text, _) = term.out.lock().await.since(0);
        let (output, clipped) = clip(&clean_output(&text));
        let mut v = envelope(&term, &output, clipped, false).await;
        v["error"] = json!("the process has exited; nothing is reading its input");
        v["error_kind"] = json!("not_running");
        return Ok(v.to_string());
    }

    let from = term.out.lock().await.total();
    let submit = args.get("submit").and_then(|v| v.as_bool()).unwrap_or(true);
    let payload = if submit { format!("{input}\n") } else { input.to_string() };

    {
        let mut guard = term.stdin.lock().await;
        let Some(pipe) = guard.as_mut() else {
            return Ok(json!({
                "error": "this terminal's input has been closed",
                "error_kind": "not_running",
            })
            .to_string());
        };
        if let Err(e) = pipe.write_all(payload.as_bytes()).await {
            return Ok(json!({ "error": format!("write failed: {e}"), "error_kind": "io" }).to_string());
        }
        if let Err(e) = pipe.flush().await {
            return Ok(json!({ "error": format!("flush failed: {e}"), "error_kind": "io" }).to_string());
        }
    }

    let waited = apply_wait(&term, args, from, DEFAULT_WRITE_WAIT_MS).await;
    let (output, clipped) = clip(&clean_output(&waited.text));
    let mut v = envelope(&term, &output, clipped, false).await;
    note_wait(&mut v, &waited);
    Ok(v.to_string())
}

pub async fn read(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;
    let Some(id) = s(args, "terminal_id") else {
        return Ok(json!({ "error": "terminal_id is required", "error_kind": "invalid_args" }).to_string());
    };
    let term = match lookup(&id, &session).await {
        Ok(t) => t,
        Err(e) => return Ok(e.to_string()),
    };

    let cursor = args.get("cursor").and_then(|v| v.as_u64());
    let mut lost = false;
    let mut waited: Option<Waited> = None;
    let text = match cursor {
        Some(from) => {
            let mut w = apply_wait(&term, args, from, 0).await;
            // A cursor read reports its own gap; the wait helper only sees text.
            lost = term.out.lock().await.since(from).1;
            let text = std::mem::take(&mut w.text);
            waited = Some(w);
            text
        }
        None => {
            // No cursor: wait first if asked, then hand back the tail, so a
            // `wait_for` or an `until` on a fresh read still behaves.
            if args.get("wait_for").is_some()
                || args.get("wait_ms").is_some()
                || args.get("until").is_some()
            {
                let from = term.out.lock().await.total();
                waited = Some(apply_wait(&term, args, from, 0).await);
            }
            let lines = args
                .get("tail_lines")
                .and_then(|v| v.as_u64())
                .unwrap_or(200)
                .clamp(1, 5_000) as usize;
            term.out.lock().await.tail(lines)
        }
    };

    let (output, clipped) = clip(&clean_output(&text));
    let mut v = envelope(&term, &output, clipped, lost).await;
    if let Some(w) = &waited {
        note_wait(&mut v, w);
    }
    Ok(v.to_string())
}

pub async fn list(db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;
    let terms = session_terminals(&session).await;
    let mut rows = Vec::new();
    for t in &terms {
        let (cursor, idle_ms) = {
            let buf = t.out.lock().await;
            (buf.total(), now_ms().saturating_sub(buf.last_at))
        };
        let code = t.exit_code().await;
        let mut row = json!({
            "terminal_id": t.id,
            "name": t.name,
            "shell": t.shell,
            "running": code.is_none(),
            "cursor": cursor,
            "idle_ms": idle_ms,
        });
        if let Some(c) = &t.command {
            row["command"] = json!(c);
        }
        if let Some(dir) = &t.cwd {
            row["cwd"] = json!(dir);
        }
        if let Some(code) = code {
            row["exit_code"] = json!(code);
        }
        rows.push(row);
    }
    Ok(json!({ "terminals": rows, "count": rows.len() }).to_string())
}

pub async fn stop(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;

    if args.get("all").and_then(|v| v.as_bool()).unwrap_or(false) {
        let terms = session_terminals(&session).await;
        let mut map = registry().lock().await;
        for t in &terms {
            map.remove(&t.id);
        }
        drop(map);
        for t in &terms {
            t.kill().await;
        }
        return Ok(json!({ "stopped": terms.iter().map(|t| t.id.clone()).collect::<Vec<_>>() }).to_string());
    }

    let Some(id) = s(args, "terminal_id") else {
        return Ok(json!({
            "error": "terminal_id is required (or pass all=true)",
            "error_kind": "invalid_args",
        })
        .to_string());
    };
    let term = match lookup(&id, &session).await {
        Ok(t) => t,
        Err(e) => return Ok(e.to_string()),
    };
    registry().lock().await.remove(&id);
    term.kill().await;

    let tail = term.out.lock().await.tail(60);
    let (output, clipped) = clip(&clean_output(&tail));
    let mut v = envelope(&term, &output, clipped, false).await;
    v["stopped"] = json!(true);
    Ok(v.to_string())
}

// ── The user's view ──────────────────────────────────────────────────────────
//
// Everything above is the model's interface: JSON strings shaped for a tool
// result. The app's terminal panel wants the same terminals as typed values,
// without the clip-to-30k and wait vocabulary a transcript needs — and it wants
// to *follow* output rather than ask for it, which [`ui_read`] does by holding
// the call until something arrives. Scoping is identical: a chat sees its
// session's terminals, so the panel shows exactly what the agent in that chat
// can see, and a terminal the user opens here is one the agent can list.

/// One terminal as the panel lists it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub name: String,
    pub shell: String,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub cursor: u64,
    pub idle_ms: u64,
    pub created_at: u64,
}

/// What a follow-read hands back.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRead {
    /// New output since the cursor asked for (ANSI stripped; `\r` left in so
    /// the viewer can resolve redraws over the whole transcript, not per chunk).
    pub output: String,
    pub cursor: u64,
    pub running: bool,
    pub exit_code: Option<i32>,
    /// The cursor pointed at output that has since scrolled out of the window.
    pub gap: bool,
}

async fn info(t: &Terminal) -> TerminalInfo {
    let (cursor, idle_ms) = {
        let buf = t.out.lock().await;
        (buf.total(), now_ms().saturating_sub(buf.last_at))
    };
    let exit_code = t.exit_code().await;
    TerminalInfo {
        id: t.id.clone(),
        name: t.name.clone(),
        shell: t.shell.clone(),
        command: t.command.clone(),
        cwd: t.cwd.clone(),
        running: exit_code.is_none(),
        exit_code,
        cursor,
        idle_ms,
        created_at: t.created_at,
    }
}

/// Strip escapes but keep carriage returns: the panel resolves those itself.
fn strip_ansi(s: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
            .expect("static ANSI pattern")
    });
    re.replace_all(s, "").into_owned()
}

fn ui_err(v: Value) -> crate::error::AppError {
    let msg = v
        .get("error")
        .and_then(|e| e.as_str())
        .unwrap_or("terminal error")
        .to_string();
    crate::error::AppError::Other(msg)
}

pub async fn ui_list(db: &SqlitePool, chat_id: &str) -> AppResult<Vec<TerminalInfo>> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;
    let mut rows = Vec::new();
    for t in session_terminals(&session).await {
        rows.push(info(&t).await);
    }
    Ok(rows)
}

/// Read a terminal for display. With no cursor, the whole retained window is
/// returned at once. With one, the call waits — up to `timeout_ms` — for output
/// past it, so a viewer that calls again with each returned cursor follows the
/// process live without polling on a timer. It returns early when the process
/// exits, so the viewer learns of that promptly too.
pub async fn ui_read(
    db: &SqlitePool,
    chat_id: &str,
    terminal_id: &str,
    cursor: Option<u64>,
    timeout_ms: Option<u64>,
) -> AppResult<TerminalRead> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;
    let term = lookup(terminal_id, &session).await.map_err(ui_err)?;

    let (raw, gap) = match cursor {
        None => term.out.lock().await.since(0),
        Some(from) => {
            let timeout = Duration::from_millis(timeout_ms.unwrap_or(20_000).min(MAX_TIMEOUT_MS));
            let (text, _) = term.wait_until(from, None, Goal::Output, timeout).await;
            let gap = term.out.lock().await.since(from).1;
            (text, gap)
        }
    };
    let exit_code = term.exit_code().await;
    let cursor = term.out.lock().await.total();
    Ok(TerminalRead {
        output: strip_ansi(&raw),
        cursor,
        running: exit_code.is_none(),
        exit_code,
        gap,
    })
}

/// Type into a terminal from the panel. Nothing is waited for: the follow-read
/// the panel already has open will show whatever the program says back.
pub async fn ui_write(
    db: &SqlitePool,
    chat_id: &str,
    terminal_id: &str,
    input: &str,
    submit: bool,
) -> AppResult<()> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;
    let term = lookup(terminal_id, &session).await.map_err(ui_err)?;
    if !term.running().await {
        return Err(crate::error::AppError::Other(
            "the process has exited; nothing is reading its input".into(),
        ));
    }
    let payload = if submit { format!("{input}\n") } else { input.to_string() };
    let mut guard = term.stdin.lock().await;
    let Some(pipe) = guard.as_mut() else {
        return Err(crate::error::AppError::Other("this terminal's input has been closed".into()));
    };
    pipe.write_all(payload.as_bytes())
        .await
        .map_err(|e| crate::error::AppError::Other(format!("write failed: {e}")))?;
    pipe.flush()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("flush failed: {e}")))?;
    Ok(())
}

pub async fn ui_stop(db: &SqlitePool, chat_id: &str, terminal_id: &str) -> AppResult<()> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;
    let term = lookup(terminal_id, &session).await.map_err(ui_err)?;
    registry().lock().await.remove(terminal_id);
    term.kill().await;
    Ok(())
}

/// Open a terminal from the panel, in the chat's session, so the agent can see
/// and use it too. Same limit as the tool: a person can also leave eight
/// servers running by accident.
pub async fn ui_start(
    db: &SqlitePool,
    chat_id: &str,
    command: Option<String>,
    shell: Option<String>,
    cwd: Option<String>,
    name: Option<String>,
) -> AppResult<TerminalInfo> {
    let session = crate::tools::teamwork::session_root(db, chat_id).await?;
    let mut live = 0;
    for t in session_terminals(&session).await {
        if t.running().await {
            live += 1;
        }
    }
    if live >= MAX_TERMINALS_PER_SESSION {
        return Err(crate::error::AppError::Other(format!(
            "this conversation already has {live} terminals open (the limit); stop one first"
        )));
    }
    let command = command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    let shell = shell.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "auto".into());
    let cwd = cwd.filter(|c| !c.trim().is_empty());
    let name = name
        .filter(|n| !n.trim().is_empty())
        .or_else(|| command.as_ref().map(|c| c.chars().take(40).collect()))
        .unwrap_or_else(|| "shell".into());
    let term = spawn_terminal(name, command, &shell, cwd, session)
        .await
        .map_err(ui_err)?;
    registry().lock().await.insert(term.id.clone(), term.clone());
    Ok(info(&term).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_window_slides_and_reports_the_gap() {
        let mut b = Buffer::new();
        // Fill past the window plus its slack, so a trim actually happens.
        let chunk = "x".repeat(10_000);
        for _ in 0..30 {
            b.push(&chunk);
        }
        assert_eq!(b.total(), 300_000, "cursor counts everything ever printed");
        assert!(b.dropped > 0, "the front should have been trimmed");
        assert!(b.len_chars <= BUFFER_CHARS + BUFFER_SLACK);

        // A cursor into dropped output is a gap, not a silent skip.
        let (_, lost) = b.since(0);
        assert!(lost);
        let (text, lost) = b.since(b.total());
        assert!(!lost);
        assert_eq!(text, "", "reading from the head returns nothing new");
    }

    #[test]
    fn tail_returns_the_last_lines() {
        let mut b = Buffer::new();
        b.push("one\ntwo\nthree\nfour\n");
        assert_eq!(b.tail(2), "three\nfour\n");
        assert_eq!(b.tail(99), "one\ntwo\nthree\nfour\n");
    }

    #[test]
    fn output_is_cleaned_the_way_a_terminal_would_show_it() {
        assert_eq!(clean_output("\x1b[32mok\x1b[0m"), "ok");
        assert_eq!(clean_output("\x1b]0;a title\x07done"), "done");
        // A progress bar redraws one line over and over; only where it landed is
        // worth carrying into a transcript.
        assert_eq!(clean_output("10%\r50%\r100%"), "100%");
        // ...but a CRLF pair is a line ending, not a redraw of nothing.
        assert_eq!(clean_output("one\r\ntwo"), "one\ntwo");
        assert_eq!(clean_output("plain\ntext"), "plain\ntext");
        // Redraws on separate lines each resolve on their own.
        assert_eq!(clean_output("a\rb\nc\rd"), "b\nd");
    }

    async fn type_into(t: &Terminal, s: &str) {
        let mut g = t.stdin.lock().await;
        let p = g.as_mut().expect("stdin");
        p.write_all(s.as_bytes()).await.unwrap();
        p.flush().await.unwrap();
    }

    fn re(p: &str) -> regex::Regex {
        regex::Regex::new(p).unwrap()
    }

    /// Exercises real processes, so it is opt-in:
    /// `cargo test --lib terminal -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "spawns real shell processes"]
    async fn terminal_lifecycle() {
        let session = "session-a".to_string();
        let term = spawn_terminal("test".into(), None, "auto", None, session.clone())
            .await
            .expect("spawn");
        registry().lock().await.insert(term.id.clone(), term.clone());

        // The point of the whole module: output arrives, and the process is still
        // there afterwards to be asked for more.
        let from = term.out.lock().await.total();
        type_into(&term, "echo hello-terminal\n").await;
        let (text, matched) = term
            .wait_for_pattern(from, &re("hello-terminal"), Duration::from_secs(20))
            .await;
        assert!(matched, "expected the echo back, got {text:?}");
        assert!(term.running().await, "the shell must outlive the command");

        // A cursor advances, so a follow-up read sees only what is new.
        let after_first = term.out.lock().await.total();
        assert!(after_first > from);
        type_into(&term, "echo second-line\n").await;
        let (only_new, matched) = term
            .wait_for_pattern(after_first, &re("second-line"), Duration::from_secs(20))
            .await;
        assert!(matched);
        assert!(
            !only_new.contains("hello-terminal"),
            "a cursor read must not repeat what was already reported: {only_new:?}"
        );

        // Output printed with no trailing newline still reaches the buffer — this
        // is what makes an interactive prompt ("Password: ") visible in time to
        // answer it, and what a line-buffered reader would swallow.
        let before_prompt = term.out.lock().await.total();
        type_into(&term, "Write-Host -NoNewline 'Password: '\n").await;
        let (prompt, matched) = term
            .wait_for_pattern(before_prompt, &re("Password: $"), Duration::from_secs(20))
            .await;
        assert!(matched, "unterminated prompt never surfaced: {prompt:?}");

        // Another session cannot reach it.
        assert!(lookup(&term.id, "session-b").await.is_err());
        assert!(lookup(&term.id, &session).await.is_ok());

        term.kill().await;
        registry().lock().await.remove(&term.id);
    }

    /// The scenario the module exists for: start something that asks a question,
    /// let it get to the prompt, then answer it. What makes this worth a test is
    /// that the answer has to reach *the program*, not the shell that launched it
    /// — the bug that hid behind `-Command -` ignoring its command entirely.
    #[tokio::test]
    #[ignore = "spawns real shell processes"]
    async fn a_command_receives_input_typed_after_it_started() {
        let script = "Write-Host -NoNewline 'Secret: '; \
                      $answer = [Console]::In.ReadLine(); \
                      Write-Host \"accepted:$answer\"";
        let term = spawn_terminal(
            "prompter".into(),
            Some(script.into()),
            "auto",
            None,
            "session-y".into(),
        )
        .await
        .expect("spawn");

        // Wait for the prompt rather than guessing at a delay — then answer it.
        let (_, prompted) = term
            .wait_for_pattern(0, &re("Secret: "), Duration::from_secs(20))
            .await;
        assert!(prompted, "the program never reached its prompt");

        let from = term.out.lock().await.total();
        type_into(&term, "hunter2\n").await;
        let (out, matched) = term
            .wait_for_pattern(from, &re("accepted:hunter2"), Duration::from_secs(20))
            .await;
        assert!(matched, "input did not reach the running program: {out:?}");

        term.kill().await;
    }

    /// Stopping a terminal must stop what it *started*, not just the shell.
    ///
    /// The bug this pins down shipped and was caught by hand: a server started
    /// through the tool kept serving after `terminal_stop` reported
    /// `stopped: true, running: false`. The shell was killed first, which
    /// re-parented the server out of reach before the tree-kill ran, so the call
    /// truthfully reported the shell dead while the thing holding the port lived
    /// on. Black-box on purpose — the grandchild writes a second marker only if
    /// it survives, so the test cannot pass by inspecting the mechanism that was
    /// wrong in the first place.
    #[tokio::test]
    #[ignore = "spawns real shell processes"]
    async fn stopping_a_terminal_kills_what_it_started() {
        let dir = std::env::temp_dir().join(format!("mz-term-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let started = dir.join("started.txt");
        let survived = dir.join("survived.txt");
        let _ = std::fs::remove_file(&started);
        let _ = std::fs::remove_file(&survived);

        // A grandchild: our shell launches *another* shell, which is what a
        // `python -m http.server` or an `npm run dev` really looks like here.
        #[cfg(windows)]
        let script = format!(
            "powershell -NoProfile -Command \"'x' > '{}'; Start-Sleep -Seconds 6; 'x' > '{}'\"",
            started.display(),
            survived.display(),
        );
        #[cfg(not(windows))]
        let script = format!(
            "sh -c \"echo x > '{}'; sleep 6; echo x > '{}'\"",
            started.display(),
            survived.display(),
        );

        let term = spawn_terminal("tree".into(), Some(script), "auto", None, "session-z".into())
            .await
            .expect("spawn");

        // Wait for the grandchild to actually be running before killing it.
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !started.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(started.exists(), "grandchild never started");

        term.kill().await;

        // Past when it would have written the second marker had it survived.
        tokio::time::sleep(Duration::from_secs(8)).await;
        assert!(
            !survived.exists(),
            "the process the terminal started outlived terminal_stop",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One call, one answer — the reason this module grew an `until`.
    ///
    /// A caller waiting on a slow command used to have only `wait_for`, so it
    /// asked "has the text appeared yet" on a fifteen-second timer and paid for
    /// the transcript on every round. `until: "exit"` states the condition once:
    /// the call sits there for as long as the work takes and returns *at* the
    /// exit, which is what this pins down — the wait must outlast a run longer
    /// than the old default and still come back promptly when it ends.
    #[tokio::test]
    #[ignore = "spawns real shell processes"]
    async fn one_wait_spans_a_whole_run_and_returns_when_it_exits() {
        #[cfg(windows)]
        let script = "Start-Sleep -Seconds 3; Write-Host done; exit 7";
        #[cfg(not(windows))]
        let script = "sleep 3; echo done; exit 7";

        let term = spawn_terminal("slow".into(), Some(script.into()), "auto", None, "session-w".into())
            .await
            .expect("spawn");

        let started = std::time::Instant::now();
        let (text, reason) = term
            .wait_until(0, None, Goal::Exit, Duration::from_secs(60))
            .await;
        let elapsed = started.elapsed();

        assert_eq!(reason, "exit", "the wait must end because it finished: {text:?}");
        assert!(text.contains("done"), "output printed before the exit is missing: {text:?}");
        assert_eq!(term.exit_code().await, Some(7));
        // Long enough that a fifteen-second wait_for would have returned empty
        // first, short enough that the call did not sit out its own timeout.
        assert!(elapsed >= Duration::from_secs(2), "returned before the work did: {elapsed:?}");
        assert!(elapsed < Duration::from_secs(30), "kept waiting after the exit: {elapsed:?}");

        term.kill().await;
    }

    /// `idle` is the answer for something that never exits. A server prints its
    /// banner and goes quiet, and "quiet" is the only signal that it is up —
    /// there is no exit to wait for and the banner text is not known in advance.
    #[tokio::test]
    #[ignore = "spawns real shell processes"]
    async fn idle_returns_once_the_output_settles() {
        #[cfg(windows)]
        let script = "Write-Host booting; Start-Sleep -Seconds 1; Write-Host ready; Start-Sleep -Seconds 30";
        #[cfg(not(windows))]
        let script = "echo booting; sleep 1; echo ready; sleep 30";

        let term = spawn_terminal("server".into(), Some(script.into()), "auto", None, "session-v".into())
            .await
            .expect("spawn");

        let started = std::time::Instant::now();
        let (text, reason) = term
            .wait_until(0, None, Goal::Idle(Duration::from_millis(1_500)), Duration::from_secs(25))
            .await;

        assert_eq!(reason, "idle", "expected the settle, got {reason} with {text:?}");
        assert!(text.contains("ready"), "returned before the boot finished: {text:?}");
        assert!(
            term.running().await,
            "idle must not wait for the process to end — that is what `exit` is for"
        );
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "sat out the timeout instead of noticing the quiet"
        );

        term.kill().await;
    }

    /// A process that ends on its own is reaped, its exit code recorded, and a
    /// wait against it returns instead of sitting out the timeout.
    #[tokio::test]
    #[ignore = "spawns real shell processes"]
    async fn exit_is_observed_without_a_reader_polling() {
        let term = spawn_terminal(
            "exiter".into(),
            Some("exit 3".into()),
            "auto",
            None,
            "session-x".into(),
        )
        .await
        .expect("spawn");

        // Ten seconds of headroom for a shell to start, but a wait on a dead
        // process must return as soon as it dies, not run the clock out.
        let started = std::time::Instant::now();
        let (_, matched) = term
            .wait_for_pattern(0, &re("never-printed"), Duration::from_secs(10))
            .await;
        assert!(!matched);
        assert!(
            started.elapsed() < Duration::from_secs(9),
            "waiting on an exited process should not burn the full timeout"
        );
        assert!(!term.running().await);
        assert_eq!(term.exit_code().await, Some(3));
    }
}
