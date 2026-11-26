//! The main column's layout over the API (0.21.0), so a zone can see what is
//! open and rearrange it through `app_read` / `app_control`.
//!
//! The layout belongs to the window — it lives in the frontend's store and is
//! drawn by Trellis — so the backend only keeps the copy the window last
//! reported, and a change is a request the window carries out (and validates)
//! rather than a write here.

use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

// ponytail: one copy for the one window; per-window copies if there are ever several.
static LAST: Mutex<Option<Value>> = Mutex::new(None);

/// What a tab id names, for whoever reads the layout without the source.
const TABS: &str = "A tab is `chat:<chat id>`, `@home` (the new-chat screen), `study:set:<set id>`, \
                    `study:review:<project id>`, or a file's absolute path. `root` is a tree of \
                    groups (a tab strip: `tabs`, `active`) and splits (`dir` row|col, `sizes` \
                    summing to 1); `floating` holds windows over it, `rect` in fractions of the \
                    column. `focused` is a group id.";

/// The window reports its layout after each change.
#[tauri::command]
pub async fn report_layout(layout: Value) -> AppResult<()> {
    *LAST.lock().unwrap() = Some(layout);
    Ok(())
}

#[tauri::command]
pub async fn get_layout() -> AppResult<Value> {
    Ok(json!({ "layout": LAST.lock().unwrap().clone(), "tabs": TABS }))
}

/// Replace the whole layout. The window checks its shape and ignores one it
/// cannot trust, as it does a stored layout at launch.
#[tauri::command]
pub async fn set_layout(app: AppHandle, layout: Value) -> AppResult<()> {
    if !layout.is_object() {
        return Err(AppError::Invalid("layout must be an object, as GET /api/layout returns it".into()));
    }
    let _ = app.emit("layout-set", json!({ "layout": layout }));
    Ok(())
}

/// Open, float or close one tab: `tab` (beside what is open), `beside` (a
/// pane of its own), `window` (floating over everything) or `close`.
#[tauri::command]
pub async fn show_tab(app: AppHandle, tab: String, show: Option<String>) -> AppResult<()> {
    let show = show.unwrap_or_else(|| "tab".into());
    if !matches!(show.as_str(), "tab" | "beside" | "window" | "close") {
        return Err(AppError::Invalid(format!("show must be tab, beside, window or close, not {show}")));
    }
    if tab.trim().is_empty() {
        return Err(AppError::Invalid(format!("tab is required. {TABS}")));
    }
    let _ = app.emit("show-tab", json!({ "tab": tab, "show": show }));
    Ok(())
}
