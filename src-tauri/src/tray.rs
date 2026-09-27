//! Close to tray (0.18).
//!
//! The point of a long agentic run is not to sit watching it, and closing the
//! window used to end the run with it. Now the window's X hides the window and
//! leaves the app in the notification area, where the backend keeps streaming,
//! running tools and firing scheduled runs exactly as it does with the window
//! open — none of that lives in the WebView. Quitting is a tray menu item, or
//! the `closeToTray: false` setting for anyone who wants X to mean quit.
//!
//! The setting is mirrored into a static because `CloseRequested` is handled in
//! a synchronous window callback that cannot await a database read.

use sqlx::SqlitePool;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);
/// Only set once the icon exists. Hiding the window with no tray to bring it
/// back from would leave a running app nobody can reach.
static TRAY_READY: AtomicBool = AtomicBool::new(false);

/// Whether the window's close button should hide rather than quit.
pub fn hide_on_close() -> bool {
    TRAY_READY.load(Ordering::Relaxed) && CLOSE_TO_TRAY.load(Ordering::Relaxed)
}

/// Re-read `closeToTray` from `app_settings`. On unless the user turned it off.
pub async fn sync(db: &SqlitePool) {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    let on = raw
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("closeToTray").and_then(serde_json::Value::as_bool))
        .unwrap_or(true);
    CLOSE_TO_TRAY.store(on, Ordering::Relaxed);
}

/// Bring the main window back from the tray, a minimise, or behind others.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show MultiZone", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit MultiZone", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("MultiZone")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    TRAY_READY.store(true, Ordering::Relaxed);
    Ok(())
}
