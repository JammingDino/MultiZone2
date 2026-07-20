//! Prototype: a persistent WSL shell session.
//!
//! Keeps one `wsl.exe -e bash` child alive with piped stdio and drives it with a
//! sentinel protocol, so cwd / env / activated venvs survive across calls --
//! the thing one-shot `wsl.exe -e bash -c "..."` can never do.

use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

struct WslSession {
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    seq: u64,
}

impl WslSession {
    async fn start() -> Result<Self, Box<dyn std::error::Error>> {
        let mut child = tokio::process::Command::new("wsl.exe")
            .args(["-e", "bash"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut s = Self { _child: child, stdin, lines: BufReader::new(stdout).lines(), seq: 0 };
        // Fold stderr into stdout once, so ordering is preserved and one reader suffices.
        s.stdin.write_all(b"exec 2>&1\n").await?;
        s.stdin.flush().await?;
        Ok(s)
    }

    /// Run a command, restarting the shell if the previous command killed it.
    ///
    /// `exit`, a fatal signal, or an `exec` of something that terminates all
    /// destroy the session. Without recovery a single stray `exit` bricks the
    /// terminal for the rest of the conversation, so a dead shell is replaced
    /// transparently -- state is genuinely gone, so the caller is told.
    async fn run_resilient(&mut self, cmd: &str, timeout_s: u64)
        -> Result<(String, i32, bool), Box<dyn std::error::Error>> {
        match self.run(cmd, timeout_s).await {
            Ok((o, rc)) => Ok((o, rc, false)),
            Err(_) => {
                *self = Self::start().await?;
                let (o, rc) = self.run(cmd, timeout_s).await?;
                Ok((o, rc, true))
            }
        }
    }

    /// Run a command, returning (stdout+stderr, exit_code).
    async fn run(&mut self, cmd: &str, timeout_s: u64) -> Result<(String, i32), Box<dyn std::error::Error>> {
        self.seq += 1;
        let token = format!("__MZ_END_{}__", self.seq);
        // Newline before the marker so it can never be glued onto unterminated output.
        let script = format!("{cmd}\n__mz_rc=$?; printf '\n{token}%d\n' \"$__mz_rc\"\n");
        self.stdin.write_all(script.as_bytes()).await?;
        self.stdin.flush().await?;

        let mut out = String::new();
        let deadline = tokio::time::Duration::from_secs(timeout_s);
        loop {
            let line = match tokio::time::timeout(deadline, self.lines.next_line()).await {
                Err(_) => return Err(format!("timed out after {timeout_s}s").into()),
                Ok(r) => r?.ok_or("shell closed unexpectedly")?,
            };
            if let Some(rest) = line.strip_prefix(&token) {
                return Ok((out, rest.trim().parse().unwrap_or(-1)));
            }
            out.push_str(&line);
            out.push('\n');
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let t0 = std::time::Instant::now();
    let mut s = WslSession::start().await?;
    println!("session start: {:?}\n", t0.elapsed());

    let steps = [
        "pwd",
        "cd /etc && pwd",
        "pwd                      # <-- persisted?",
        "export FOO=bar; echo set=$FOO",
        "echo after=$FOO          # <-- persisted?",
        "echo to-stderr >&2       # stderr captured?",
        "exit 7                   # exit code propagated? (subshell-safe)",
        "false",
        "python3 -c 'print(1+1)' 2>/dev/null || echo 'no python3'",
    ];
    for c in steps {
        let t = std::time::Instant::now();
        match s.run_resilient(c, 15).await {
            Ok((out, rc, restarted)) => println!(
                "$ {c}\n{out}rc={rc}{}  ({:?})\n",
                if restarted { "  [session auto-restarted]" } else { "" },
                t.elapsed()
            ),
            Err(e) => println!("$ {c}\n  ERROR: {e}\n"),
        }
    }
    Ok(())
}
