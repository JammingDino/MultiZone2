//! What the user is offered when the app cannot start (0.21).
//!
//! The one failure with an obvious fix is a database written by a newer build,
//! and the fix is installing a newer build — so the dialog does that itself
//! instead of sending the user to find an installer. Any other failure gets a
//! "Check for updates" too: it is the same few lines, and a fixed release is a
//! plausible way out of a startup bug.
//!
//! Runs on its own thread after `setup()` returns, so the event loop is alive:
//! the dialogs and the updater's network calls then behave as they do anywhere
//! else, instead of nesting inside a blocked `setup()`.

use crate::error::AppError;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

const RELEASES_URL: &str = "https://github.com/JammingDino/MultiZone2/releases";

pub fn handle(app: &AppHandle, err: AppError) {
    tracing::error!("failed to init app state: {err}");
    // The main window's frontend has no state to talk to; keep it out of sight
    // while the dialogs decide what happens next.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let newer_data = matches!(err, AppError::DatabaseFromNewerBuild { .. });
    let text = format!(
        "MultiZone could not start.\n\n{err}\n\nDetails were written to:\n{}",
        std::env::temp_dir().join("multizone.log").display()
    );
    let app = app.clone();
    std::thread::spawn(move || run(&app, newer_data, text));
}

fn run(app: &AppHandle, newer_data: bool, text: String) -> ! {
    let unavailable = cannot_update(
        cfg!(debug_assertions),
        crate::updater_token::updater_token().is_some(),
    );

    let offer = match (unavailable, newer_data) {
        (Some(why), true) => {
            say(app, MessageDialogKind::Error, &format!("{text}\n\n{why}"));
            std::process::exit(1);
        }
        (Some(_), false) => {
            say(app, MessageDialogKind::Error, &text);
            std::process::exit(1);
        }
        (None, true) => "Update now",
        (None, false) => "Check for updates",
    };
    let go = app
        .dialog()
        .message(&text)
        .kind(MessageDialogKind::Error)
        .title("MultiZone — startup failed")
        .buttons(MessageDialogButtons::OkCancelCustom(offer.into(), "Quit".into()))
        .blocking_show();
    if !go {
        std::process::exit(1);
    }

    let running = env!("CARGO_PKG_VERSION");
    let checked = tauri::async_runtime::block_on(async {
        app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())
    });
    let update = match checked {
        Ok(Some(update)) => update,
        Ok(None) if newer_data => {
            // The plugin only offers strictly newer versions, so "none" means no
            // release yet knows this data — a dev build wrote it.
            let open = app
                .dialog()
                .message(format!(
                    "No published release is newer than {running}, so the data on this \
                     machine was most likely written by a development build that is ahead \
                     of every release.\n\nRun that build again, or wait for the next \
                     release. Your data has not been changed."
                ))
                .kind(MessageDialogKind::Warning)
                .title("MultiZone — no newer release")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Open releases page".into(),
                    "Quit".into(),
                ))
                .blocking_show();
            if open {
                let _ = opener::open_browser(RELEASES_URL);
            }
            std::process::exit(1);
        }
        Ok(None) => {
            say(
                app,
                MessageDialogKind::Info,
                &format!("{running} is the latest release, so updating will not fix this."),
            );
            std::process::exit(1);
        }
        Err(e) => {
            tracing::error!("startup update check failed: {e}");
            say(app, MessageDialogKind::Error, &format!("Could not check for updates.\n\n{}", explain(&e)));
            std::process::exit(1);
        }
    };

    // Native dialogs cannot show progress, so this one only says the download
    // has started; it is non-blocking and the process exits under it once the
    // installer (which shows its own progress) takes over.
    app.dialog()
        .message(format!(
            "Downloading MultiZone {}…\n\nThe installer opens when the download \
             finishes, and MultiZone restarts after it. You can close this message.",
            update.version
        ))
        .title("MultiZone — updating")
        .show(|_| {});
    let installed = tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {}));
    match installed {
        // Windows never gets here: the plugin runs the installer and exits.
        Ok(()) => app.restart(),
        Err(e) => {
            tracing::error!("startup update failed: {e}");
            say(
                app,
                MessageDialogKind::Error,
                &format!(
                    "The update could not be installed.\n\n{}\n\nYour data has not been changed.",
                    explain(&e.to_string())
                ),
            );
            std::process::exit(1);
        }
    }
}

fn say(app: &AppHandle, kind: MessageDialogKind, text: &str) {
    app.dialog()
        .message(text)
        .kind(kind)
        .title("MultiZone — startup failed")
        .blocking_show();
}

/// Why this build cannot update itself, or `None` when it can.
///
/// A dev build has no token to reach the private repo, and if it did, the
/// updater would replace the installed app rather than the dev binary.
fn cannot_update(debug: bool, has_token: bool) -> Option<&'static str> {
    if debug {
        Some("Updating from here is only available in installed builds.")
    } else if !has_token {
        Some("This build was made without update access, so it cannot update itself.")
    } else {
        None
    }
}

/// The updater's error in words that name a cause — the subset of
/// `useUpdater.ts`'s `explain` that applies before any UI exists.
fn explain(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    if has(&["401", "403", "unauthorized", "forbidden", "bad credentials"]) {
        "MultiZone isn't authorised to fetch updates. Its access token has most likely \
         expired or been revoked — a new build with a fresh token is needed."
            .into()
    } else if has(&["valid release json", "404", "not found"]) {
        "No update manifest or installer was found on GitHub.".into()
    } else if has(&["signature", "verif"]) {
        "The update failed signature verification and was not installed.".into()
    } else if has(&["dns", "connect", "timed out", "timeout", "unreachable", "network"]) {
        "Couldn't reach GitHub. Check your connection and try again.".into()
    } else {
        raw.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_installed_builds_with_a_token_can_update() {
        assert!(cannot_update(true, true).unwrap().contains("installed builds"));
        assert!(cannot_update(false, false).unwrap().contains("without update access"));
        assert_eq!(cannot_update(false, true), None);
    }

    #[test]
    fn updater_errors_name_a_cause() {
        assert!(explain("status 401 Bad credentials").contains("authorised"));
        assert!(explain("Could not fetch a valid release JSON from the remote").contains("manifest"));
        assert!(explain("signature verification failed").contains("signature"));
        assert!(explain("error sending request: dns error").contains("reach GitHub"));
        assert_eq!(explain("disk full"), "disk full");
    }
}
