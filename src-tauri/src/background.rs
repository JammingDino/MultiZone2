//! A window nobody can see costs nothing to draw.
//!
//! Hiding to the tray (0.18) and minimising both hide the *window*, but on
//! Windows nothing tells WebView2: wry skips the resize on a minimise and Tauri's
//! `hide()` is a plain `ShowWindow`. So the page went on believing it was on
//! screen — `document.hidden` false, animation frames at the monitor's refresh
//! rate, CSS animations composited — and an app left in the tray overnight spent
//! the night drawing a background effect for nobody.
//!
//! Here the webview is told directly: invisible while the window is hidden or
//! minimised, which stops rendering and lets Chromium throttle the page's timers,
//! and asked to keep its memory low while it is. Nothing the backend does lives in
//! the page — streams, tools and scheduled runs carry on — and the page itself
//! still runs, just slowly: stream events drain within a second, which nobody is
//! there to see anyway.
//!
//! The failure to avoid is the opposite one: a window on screen with its webview
//! still marked invisible is a blank window. So every way back — the tray, a
//! second launch, the taskbar, any focus — marks it visible again, and a redundant
//! "visible" is free.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};

static HIDDEN: AtomicBool = AtomicBool::new(false);

/// Follow the main window's visibility from its events.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        WindowEvent::Resized(_) => {
            let minimized = window.is_minimized().unwrap_or(false);
            let visible = window.is_visible().unwrap_or(true);
            let hidden = minimized || !visible;
            // A drag of the window's edge is a stream of these; only a change
            // of state is worth a call into the webview.
            if hidden || HIDDEN.load(Ordering::Relaxed) {
                set_hidden(window.app_handle(), hidden);
            }
        }
        WindowEvent::Focused(true) => set_hidden(window.app_handle(), false),
        _ => {}
    }
}

/// Mark the main window's webview hidden or shown. Cheap to repeat.
pub fn set_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    // Showing is always applied, even when we think it already is: the cost of
    // a stale flag the wrong way round is a blank window.
    if HIDDEN.swap(hidden, Ordering::Relaxed) == hidden && hidden {
        return;
    }
    let Some(webview) = app.get_webview_window("main") else { return };
    apply(&webview, hidden);
}

#[cfg(windows)]
fn apply<R: Runtime>(webview: &tauri::WebviewWindow<R>, hidden: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    let _ = webview.with_webview(move |platform| {
        let controller = platform.controller();
        // SAFETY: plain COM calls on the controller wry created, made on the
        // thread `with_webview` runs us on (the one that owns it).
        unsafe {
            if let Err(e) = controller.SetIsVisible(!hidden) {
                tracing::debug!("webview visibility: {e}");
            }
            // The memory hint arrived in a later runtime (ICoreWebView2_19);
            // an older one simply does not get it.
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                    let level = if hidden {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                    };
                    let _ = core19.SetMemoryUsageTargetLevel(level);
                }
            }
        }
    });
}

/// Elsewhere the platform webview already follows its window.
#[cfg(not(windows))]
fn apply<R: Runtime>(_webview: &tauri::WebviewWindow<R>, _hidden: bool) {}
