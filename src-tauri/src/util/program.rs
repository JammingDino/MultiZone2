//! Locating executables on PATH the way a shell would.
//!
//! `Command::new("foo")` bottoms out in `CreateProcess` on Windows, which does
//! *not* consult PATHEXT. A bare name therefore only ever matches `foo.exe` —
//! so anything shipped as a `.cmd`/`.bat` shim (npx, npm, pnpm, and most Node
//! CLIs, plus version-manager shims like pyenv-win) fails with "program not
//! found" even though it is installed and on PATH.
//!
//! On non-Windows the OS resolves PATH itself and there is nothing to do.

#[cfg(windows)]
use std::path::{Path, PathBuf};

/// How a resolved program must be launched.
#[cfg(windows)]
pub enum Resolved {
    /// A real executable — spawn it directly.
    Exe(PathBuf),
    /// A batch shim — `CreateProcess` cannot execute these, so it must go
    /// through `cmd.exe /C`.
    Batch(PathBuf),
}

#[cfg(windows)]
fn pathext() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect()
}

#[cfg(windows)]
fn classify(path: PathBuf) -> Resolved {
    let is_batch = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "cmd" || e == "bat"
        })
        .unwrap_or(false);
    if is_batch { Resolved::Batch(path) } else { Resolved::Exe(path) }
}

/// Find `program` on PATH, trying each PATHEXT extension in order.
///
/// Returns `None` when nothing matches, so callers can fall through to spawning
/// the bare name and surface the OS's own error.
#[cfg(windows)]
pub fn resolve(program: &str) -> Option<Resolved> {
    // An explicit path needs no lookup, but may still be a batch file.
    if program.contains('/') || program.contains('\\') {
        let p = Path::new(program);
        return p.is_file().then(|| classify(p.to_path_buf()));
    }

    let path_var = std::env::var_os("PATH")?;

    // An already-extensioned name is taken as-is.
    if Path::new(program).extension().is_some() {
        for dir in std::env::split_paths(&path_var) {
            let cand = dir.join(program);
            if cand.is_file() {
                return Some(classify(cand));
            }
        }
    }

    // PATH order is outer so the first directory wins, matching shell behaviour.
    let exts = pathext();
    for dir in std::env::split_paths(&path_var) {
        for ext in &exts {
            let cand = dir.join(format!("{program}{ext}"));
            if cand.is_file() {
                return Some(classify(cand));
            }
        }
    }
    None
}

/// Build a `tokio::process::Command` for `program`, routing batch shims through
/// `cmd.exe`. Arguments are added by the caller as usual.
pub fn command(program: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        match resolve(program) {
            Some(Resolved::Batch(path)) => {
                let mut c = tokio::process::Command::new("cmd.exe");
                c.arg("/C").arg(path);
                c
            }
            Some(Resolved::Exe(path)) => tokio::process::Command::new(path),
            None => tokio::process::Command::new(program),
        }
    }
    #[cfg(not(windows))]
    {
        tokio::process::Command::new(program)
    }
}
