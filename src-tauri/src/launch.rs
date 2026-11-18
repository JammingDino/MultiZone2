//! Opening the app on a path (0.19.3): `multizone.exe D:\work\site`, the
//! Explorer "Open in MultiZone" verbs, and `multizone .` from a terminal.
//!
//! Two ways a path arrives, one way out. A cold start reads its own command
//! line; a second launch is handed to the running instance by the
//! single-instance plugin, with that launch's arguments and working directory.
//! Both park the path here and nudge the window with `open-path`, and the
//! window *pulls* it with `take_pending_launch` — an emit fired before the
//! webview has attached its listener is otherwise simply lost, and a cold
//! start is exactly when that happens.
//!
//! A bare launch never opens anything, however interesting its working
//! directory looks: the Start menu, the taskbar and a tray relaunch all start
//! with *some* cwd, and guessing from it would open a stray chat on every
//! ordinary launch. Only an explicit path, or the `--open-cwd` flag, counts.
//!
//! Opening a chat on a path sends nothing. It grants a chat access (or opens one
//! in the path's project) and waits for the user to type, which puts a program
//! that launches `multizone.exe C:\somewhere` at the same trust level as the
//! user dropping that folder — so there is no confirmation step.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Event that tells the window a path is waiting.
pub const EVENT: &str = "open-path";

static PENDING: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The path a launch asks to open, if it asks for one.
///
/// `args` is the whole command line, program name first. Arguments that do not
/// resolve to something that exists are ignored — which is also what keeps any
/// flags the runtime adds for itself from being taken for a path.
pub fn parse_launch(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let rest = args.iter().skip(1);
    let mut open_cwd = false;
    for a in rest {
        let a = a.trim().trim_matches('"');
        if a.is_empty() {
            continue;
        }
        if a == "--open-cwd" {
            open_cwd = true;
            continue;
        }
        if a.starts_with("--") {
            continue;
        }
        let p = Path::new(a);
        let p = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
        match p.canonicalize() {
            Ok(c) => return Some(crate::grants::strip_verbatim(&c)),
            Err(_) => tracing::info!("launch argument {a:?} is not a path that exists; ignored"),
        }
    }
    if open_cwd {
        return cwd.canonicalize().ok().map(|c| crate::grants::strip_verbatim(&c));
    }
    None
}

pub fn set_pending(path: PathBuf) {
    if let Ok(mut g) = PENDING.lock() {
        *g = Some(path);
    }
}

/// Read once at startup from this process's own command line.
pub fn capture_cold_start() {
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    if let Some(p) = parse_launch(&args, &cwd) {
        tracing::info!("launched on {}", p.display());
        set_pending(p);
    }
}

/// A second launch, as the single-instance plugin hands it over.
pub fn on_second_instance<R: tauri::Runtime>(app: &tauri::AppHandle<R>, args: &[String], cwd: &str) {
    use tauri::Emitter;
    if let Some(p) = parse_launch(args, Path::new(cwd)) {
        tracing::info!("second launch on {}", p.display());
        set_pending(p);
        let _ = app.emit(EVENT, serde_json::json!({}));
    }
}

/// Hand the waiting path to the window, once.
#[tauri::command]
pub fn take_pending_launch() -> Option<String> {
    PENDING
        .lock()
        .ok()
        .and_then(|mut g| g.take())
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        std::iter::once("multizone.exe").chain(v.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn a_relative_path_resolves_against_the_launch_directory() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("src")).unwrap();
        let got = parse_launch(&args(&["src"]), d.path()).unwrap();
        assert!(got.ends_with("src"), "{got:?}");
        let dot = parse_launch(&args(&["."]), d.path()).unwrap();
        assert!(crate::grants::path_contains(&dot, &got));
        assert!(!dot.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn a_path_that_does_not_exist_is_ignored() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(parse_launch(&args(&["nope-not-here"]), d.path()), None);
    }

    #[test]
    fn a_bare_launch_opens_nothing() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(parse_launch(&args(&[]), d.path()), None);
        // Runtime flags are not paths either.
        assert_eq!(parse_launch(&args(&["--some-webview-flag=1"]), d.path()), None);
    }

    #[test]
    fn open_cwd_opens_the_launch_directory() {
        let d = tempfile::tempdir().unwrap();
        let got = parse_launch(&args(&["--open-cwd"]), d.path()).unwrap();
        let want = crate::grants::strip_verbatim(&d.path().canonicalize().unwrap());
        assert_eq!(got, want);
    }

    #[test]
    fn an_explicit_path_beats_open_cwd_and_quotes_are_stripped() {
        let d = tempfile::tempdir().unwrap();
        let sub = d.path().join("a b");
        std::fs::create_dir(&sub).unwrap();
        let quoted = format!("\"{}\"", sub.display());
        let got = parse_launch(&args(&["--open-cwd", &quoted]), d.path()).unwrap();
        assert!(got.ends_with("a b"));
    }

    #[test]
    fn the_pending_path_is_taken_once() {
        set_pending(PathBuf::from(r"C:\x"));
        assert_eq!(take_pending_launch().as_deref(), Some(r"C:\x"));
        assert_eq!(take_pending_launch(), None);
    }
}
