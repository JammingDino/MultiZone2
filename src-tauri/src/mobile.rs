//! The mobile binary (0.17.2): a window, and nothing behind it.
//!
//! This is the shortest file in the app and the one that carries the most
//! design. Everything the desktop crate does — SQLite, the agentic loop, MCP,
//! the knowledge index, the file tools, the API server — is compiled *out* of
//! the mobile build, and the reason is the premise of the product rather than
//! a build-time convenience.
//!
//! - A phone cannot run a 30B local model, so whatever ran here would be a
//!   different, worse app wearing the same icon.
//! - Every tool that matters needs the desktop's filesystem. `read_file`, the
//!   shell, an `npx` MCP server: none of them mean anything against a phone's
//!   sandbox.
//! - Two stores would have to sync, and cloud sync is a stated non-goal. A
//!   remote client has no second copy, so the hard problem is deleted rather
//!   than solved — but only if there is genuinely no second store, which means
//!   not shipping the code that would create one.
//!
//! The last point is why this is `#[cfg]` and not a runtime flag. A mobile
//! build that *contained* the database layer and merely chose not to open it
//! would be one bug away from a second copy of the user's chats living on a
//! phone. It cannot be, because it is not there.
//!
//! Everything the app does on a phone therefore goes through
//! `src/lib/remote/transport.ts` to a paired desktop. The Rust here exists to
//! host a WebView and to let the frontend ask its own version.

/// The plugins a shell needs.
///
/// `notification` earns its place: the moment a run stops and waits for an
/// approval is exactly the moment the phone is in a pocket, and 0.14.3 added
/// notifications on the desktop for the same reason. `dialog` and `fs` are
/// here because the frontend can reach for them and a missing plugin is a
/// runtime error rather than a graceful absence.
///
/// Deliberately absent: the updater (a phone updates through its store or a
/// sideloaded APK, not through GitHub Releases) and `process` (nothing here
/// relaunches itself).
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("multizone=debug".parse().unwrap()),
        )
        .init();

    tracing::info!("MultiZone mobile {} starting", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        // No `invoke_handler`. There is nothing on this device to command: the
        // frontend's transport sends every call to the paired desktop, and a
        // command registered here would be a capability that exists on the
        // phone and nowhere else — which is the shape of the second app this
        // design exists to avoid.
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
