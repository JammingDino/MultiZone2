//! Real filesystem paths for things dropped on the window (0.19.3).
//!
//! The window runs with `dragDropEnabled: false` so the webview keeps its own
//! HTML5 drag-and-drop — the composer, the zone library and the settings import
//! all depend on DOM drop events. The cost is that a DOM `File` carries
//! contents and a name but never a path, and a dropped *folder* arrives as a
//! zero-byte `File` that nothing can use. Turning Tauri's native handler on
//! instead is not a fix: on Windows it replaces WebView2's drop handling
//! outright and every HTML5 drag stops working (tauri#15138, expected
//! behaviour per the maintainers).
//!
//! WebView2 has a supported way across: page script hands the dropped DOM
//! objects to the host with `chrome.webview.postMessageWithAdditionalObjects`,
//! and the host reads each one's path off `ICoreWebView2File` or
//! `ICoreWebView2FileSystemHandle` (WebView2 spec *WebMessageObjects*). This is
//! that host half. It only reports paths for objects the user actually
//! dropped — page script cannot mint a `File` with an arbitrary path — and it
//! grants nothing itself: what a path is *for* is decided by the caller
//! (`src/lib/dropPaths.ts`).
//!
//! Wry listens to the same `WebMessageReceived` event and tries to parse every
//! message as a Tauri IPC call, so each drop also logs one harmless "invalid
//! IPC request" warning from wry. Ours are recognised by their `mz-drop:`
//! prefix and that one line is the whole cost of sharing the channel.

use serde::Serialize;

/// Event the frontend waits on, carrying the token it posted.
pub const EVENT: &str = "mz-drop-paths";
/// Prefix of the web message a drop posts; the rest is the drop's token.
const PREFIX: &str = "mz-drop:";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedPath {
    pub path: String,
    /// From the filesystem, not the DOM: the DOM's idea of a directory entry is
    /// exactly the part of a drop that cannot be trusted to carry through.
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DropPaths {
    token: String,
    paths: Vec<DroppedPath>,
}

/// The token a message carries when it is one of ours.
fn token_of(message: &str) -> Option<&str> {
    message.strip_prefix(PREFIX).filter(|t| !t.is_empty() && t.len() <= 64)
}

fn describe(path: String) -> Option<DroppedPath> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return None;
    }
    let is_dir = std::fs::metadata(&path).map(|m| m.is_dir()).ok()?;
    Some(DroppedPath { path, is_dir })
}

/// Register the bridge on the main window. Once, from `setup`.
#[cfg(windows)]
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::{Emitter, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2FileSystemHandle,
        ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::{Interface, PWSTR};

    let Some(window) = app.get_webview_window("main") else { return };
    let emitter = app.clone();
    let _ = window.with_webview(move |platform| {
        let controller = platform.controller();
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            // SAFETY: COM calls on the event args WebView2 handed this callback,
            // on the UI thread it invokes us on. Every failure is swallowed —
            // the frontend times out to an empty list, which is the fallback.
            unsafe {
                let mut raw = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut raw).is_err() {
                    return Ok(());
                }
                let message = take_pwstr(raw);
                let Some(token) = token_of(&message) else { return Ok(()) };

                let mut paths = Vec::new();
                // Runtimes before EventArgs2 have no additional objects: the
                // cast fails and the drop reports nothing.
                if let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                    if let Ok(objects) = args2.AdditionalObjects() {
                        let mut count = 0u32;
                        let _ = objects.Count(&mut count);
                        for i in 0..count.min(256) {
                            let Ok(obj) = objects.GetValueAtIndex(i) else { continue };
                            let mut p = PWSTR::null();
                            // A DOM `File` first; then a `FileSystemHandle`,
                            // which is how a directory can arrive when its
                            // `File` carries no path.
                            let path = if let Ok(f) = obj.cast::<ICoreWebView2File>() {
                                f.Path(&mut p).ok().map(|_| take_pwstr(p))
                            } else if let Ok(h) = obj.cast::<ICoreWebView2FileSystemHandle>() {
                                h.Path(&mut p).ok().map(|_| take_pwstr(p))
                            } else {
                                None
                            };
                            if let Some(d) = path.and_then(describe) {
                                if !paths.iter().any(|x: &DroppedPath| x.path == d.path) {
                                    paths.push(d);
                                }
                            }
                        }
                    }
                }
                let _ = emitter.emit_to(
                    "main",
                    EVENT,
                    DropPaths { token: token.to_string(), paths },
                );
            }
            Ok(())
        }));
        // SAFETY: as in `background::apply` — the controller wry created, on
        // its own thread. The registration token is dropped deliberately: the
        // handler lives as long as the webview does.
        unsafe {
            if let Ok(core) = controller.CoreWebView2() {
                let mut token = 0i64;
                if let Err(e) = core.add_WebMessageReceived(&handler, &mut token) {
                    tracing::warn!("drop bridge not registered, folder drops will fall back: {e}");
                }
            }
        }
    });
}

/// Elsewhere drops report no paths and the frontend falls back to the picker.
#[cfg(not(windows))]
pub fn init<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_messages_are_read() {
        assert_eq!(token_of("mz-drop:abc-123"), Some("abc-123"));
        assert_eq!(token_of("mz-drop:"), None);
        assert_eq!(token_of("{\"cmd\":\"x\"}"), None);
        assert_eq!(token_of(&format!("mz-drop:{}", "x".repeat(65))), None);
    }

    #[test]
    fn a_path_is_described_from_the_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let d = describe(dir.path().to_string_lossy().to_string()).unwrap();
        assert!(d.is_dir);
        let f = describe(file.to_string_lossy().to_string()).unwrap();
        assert!(!f.is_dir);
        assert!(describe(dir.path().join("nope").to_string_lossy().to_string()).is_none());
        assert!(describe("  ".into()).is_none());
    }
}
