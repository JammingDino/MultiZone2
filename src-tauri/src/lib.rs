mod api;
mod audio;
mod checkpoints;
mod db;
mod diffs;
mod knowledge;
mod llm;
mod mcp;
mod ocr;
mod plans;
mod review;
mod pdf_bridge;
mod skillpacks;
mod tools;
mod util;
mod commands;
mod state;
mod theme;
mod error;
mod events;
mod stt_api;
mod tts_api;
mod updater_token;

use state::AppState;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

#[cfg(not(debug_assertions))]
fn install_panic_hook(path: std::path::PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let entry = format!(
            "[{}] {info}\n{backtrace}\n",
            chrono::Local::now().to_rfc3339()
        );
        // Best-effort: the dedicated crash file is easy to point users at, and
        // the same message goes to the rolling log for context.
        let _ = std::fs::write(&path, &entry);
        tracing::error!("panic: {info}");
    }));
}

/// The updater plugin, authenticated against the private repository.
///
/// A missing or malformed token is not fatal — the plugin is still installed so
/// the Settings → Updates UI keeps working, it just reports that no manifest
/// could be reached. That is the same failure the user sees when offline, and
/// it beats the app refusing to start over a credential it only needs for an
/// optional background check.
fn build_updater_plugin<R: tauri::Runtime>(
) -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    let builder = tauri_plugin_updater::Builder::new();

    let builder = match updater_token::updater_token() {
        // `header` consumes the builder, so the error arm starts a fresh one
        // rather than trying to hand back the value it just moved.
        Some(token) => match builder.header("Authorization", format!("Bearer {token}")) {
            Ok(authenticated) => authenticated,
            Err(e) => {
                tracing::error!("updater auth header rejected, updates will fail: {e}");
                tauri_plugin_updater::Builder::new()
            }
        },
        None => {
            tracing::warn!(
                "no updater token compiled in; update checks against the private repo will fail"
            );
            builder
        }
    };

    builder.build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter =
        || EnvFilter::from_default_env().add_directive("multizone=debug".parse().unwrap());

    // Release builds use `windows_subsystem = "windows"` (see main.rs), which
    // detaches the process from any parent console — so running the installed
    // app from a terminal prints nothing and panics are invisible. Route logs
    // and crashes to files in the temp dir instead, so a failed launch on
    // another machine is diagnosable: look for `multizone.log` and
    // `multizone_crash.txt` in %TEMP%.
    #[cfg(not(debug_assertions))]
    let _log_guard = {
        let log_dir = std::env::temp_dir();
        install_panic_hook(log_dir.join("multizone_crash.txt"));
        let appender = tracing_appender::rolling::never(&log_dir, "multizone.log");
        let (writer, guard) = tracing_appender::non_blocking(appender);
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(writer)
            .with_env_filter(filter())
            .init();
        // Held for the lifetime of run() so buffered logs flush on exit.
        guard
    };

    // Debug builds keep console logging for the dev loop.
    #[cfg(debug_assertions)]
    tracing_subscriber::fmt().with_env_filter(filter()).init();

    tracing::info!("MultiZone {} starting", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Auto-update from GitHub Releases (1.0). `process` is what lets the app
        // relaunch itself once an update is installed.
        //
        // The repository is private, so neither the manifest nor the installer
        // is publicly readable — both requests carry a compiled-in read-only
        // token. Only `Authorization` is set here on purpose: the plugin picks
        // the right `Accept` per request (`application/json` for the manifest,
        // `application/octet-stream` for the download, which is what makes
        // GitHub's asset API return bytes rather than metadata) and only fills
        // it in when we have not already, so setting it ourselves would break
        // one of the two requests.
        .plugin(build_updater_plugin())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                // `setup()` runs after the window exists, so panicking here shows
                // the user a window that opens and instantly closes, with the
                // reason buried in %TEMP%. Surface it instead — this is how the
                // cross-machine `VersionMismatch` crash stayed invisible for so
                // long. Reported before the process exits, not swallowed.
                let state = match AppState::init(&handle).await {
                    Ok(state) => state,
                    Err(e) => {
                        tracing::error!("failed to init app state: {e}");
                        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                        handle
                            .dialog()
                            .message(format!(
                                "MultiZone could not start.\n\n{e}\n\n\
                                 Details were written to:\n{}",
                                std::env::temp_dir().join("multizone.log").display()
                            ))
                            .kind(MessageDialogKind::Error)
                            .title("MultiZone — startup failed")
                            .blocking_show();
                        std::process::exit(1);
                    }
                };
                handle.manage(state);
                // Launch the HTTP API server if the user has enabled it.
                commands::api::start_if_enabled(&handle).await;
                // Bring every enabled MCP server up (0.14.0). Returns as soon as
                // the servers are read from the database — each connection runs
                // in its own task, so npx starting three stdio servers is not in
                // front of the first window paint.
                commands::mcp::start_enabled(&handle).await;
                // Start the knowledge directory watcher (live auto re-index).
                {
                    let st = handle.state::<AppState>();
                    knowledge::watcher::init(st.db.clone(), st.http.clone(), handle.clone());
                    // Markdown two-way sync watcher (0.7.2): pulls external `.md`
                    // edits in the mirror folder back into the DB.
                    commands::mirror::init(st.db.clone(), handle.clone());
                    // Bring the checkpoint store back under its retention
                    // limits (0.10.0). Detached: a store with thousands of
                    // blobs is a few hundred milliseconds of file deletion,
                    // which the first window paint should not wait for.
                    let db = st.db.clone();
                    tauri::async_runtime::spawn(async move {
                        match checkpoints::prune_to_settings(&db).await {
                            Ok(out) if out.removed_checkpoints > 0 => tracing::info!(
                                "checkpoint retention: dropped {} checkpoint(s), freed {} bytes",
                                out.removed_checkpoints,
                                out.freed_bytes
                            ),
                            Ok(_) => {}
                            Err(e) => tracing::warn!("checkpoint prune failed: {e}"),
                        }
                    });
                }
                knowledge::watcher::resync().await;
                commands::mirror::resync().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::providers::list_providers,
            commands::providers::upsert_provider,
            commands::providers::delete_provider,
            commands::providers::fetch_models,
            commands::zones::list_zones,
            commands::zones::upsert_zone,
            commands::zones::delete_zone,
            commands::chats::list_chats,
            commands::chats::create_chat,
            commands::chats::rename_chat,
            commands::chats::set_chat_zone,
            commands::chats::set_chat_smart,
            commands::plans::set_chat_plan_mode,
            commands::plans::list_plans,
            commands::plans::pending_plan,
            commands::plans::approve_plan,
            commands::plans::reject_plan,
            commands::plans::update_plan_steps,
            commands::plans::request_plan_stop,
            commands::plans::plan_tree,
            commands::plans::list_session_events,
            commands::chats::set_chat_project,
            commands::chats::set_chat_project_context,
            commands::chats::get_chat_tags,
            commands::chats::get_all_chat_tags,
            commands::chats::add_chat_tag,
            commands::chats::remove_chat_tag,
            commands::chats::set_chat_tag_context,
            commands::chats::get_chat_zones,
            commands::chats::add_perspective_zone,
            commands::chats::remove_perspective_zone,
            commands::chats::set_chat_perspective_mode,
            commands::chats::get_chat_subagents,
            commands::chats::set_chat_subagents,
            commands::chats::get_subchat_tree,
            commands::chats::delete_chat,
            commands::chats::branch_chat,
            commands::chats::delete_messages_from,
            commands::chats::delete_participant_messages,
            commands::chats::get_messages,
            commands::chats::generate_title,
            commands::diagram::fix_diagram,
            commands::projects::list_projects,
            commands::projects::upsert_project,
            commands::projects::delete_project,
            commands::projects::list_tags,
            commands::projects::upsert_tag,
            commands::projects::delete_tag,
            commands::knowledge::set_project_kb_config,
            commands::knowledge::index_project_knowledge,
            commands::knowledge::get_knowledge_status,
            commands::knowledge::list_knowledge_documents,
            commands::knowledge::remove_knowledge_document,
            commands::knowledge::clear_project_knowledge,
            commands::knowledge::set_chat_knowledge,
            commands::knowledge::set_project_kb_default,
            commands::knowledge::get_global_kb,
            commands::knowledge::set_global_kb_config,
            commands::knowledge::index_global_knowledge,
            commands::knowledge::list_global_kb_documents,
            commands::knowledge::clear_global_knowledge,
            commands::skills::list_skills,
            commands::skills::list_skill_packs,
            commands::skills::skill_packs_root,
            commands::skills::upsert_skill,
            commands::skills::set_skill_enabled,
            commands::skills::delete_skill,
            commands::mcp::list_mcp_servers,
            commands::mcp::upsert_mcp_server,
            commands::mcp::delete_mcp_server,
            commands::mcp::connect_mcp_server,
            commands::mcp::disconnect_mcp_server,
            commands::mcp::set_mcp_tool_danger,
            commands::connectors::list_connectors,
            commands::connectors::install_connector,
            commands::connectors::import_connectors,
            commands::connectors::delete_connector,
            commands::connectors::diagnose_mcp_server,
            commands::memory::list_memories,
            commands::memory::upsert_memory,
            commands::memory::delete_memory,
            commands::library::list_library_entries,
            commands::library::upsert_library_entry,
            commands::library::delete_library_entry,
            commands::files::read_output_file,
            commands::files::open_path,
            commands::files::reveal_path,
            commands::messages::list_tool_functions,
            commands::tool_usage::get_tool_usage,
            commands::tool_usage::reset_tool_usage,
            commands::checkpoints::list_checkpoints,
            commands::checkpoints::restore_checkpoint,
            commands::checkpoints::checkpoints_since_message,
            commands::checkpoints::restore_to_message,
            commands::checkpoints::rewind_to_message,
            commands::checkpoints::rewind_forward,
            commands::checkpoints::rewind_status,
            commands::review::list_staged_edits,
            commands::review::apply_staged_edit,
            commands::review::discard_staged_edit,
            commands::review::apply_all_staged_edits,
            commands::review::discard_all_staged_edits,
            commands::checkpoints::checkpoint_usage,
            commands::checkpoints::prune_checkpoints,
            commands::usage::session_context_usage,
            commands::usage::lifetime_token_usage,
            commands::messages::send_message,
            commands::messages::regenerate_response,
            commands::messages::regenerate_participant,
            commands::messages::cancel_stream,
            commands::pending::queue_chat_message,
            commands::pending::cancel_pending_message,
            commands::messages::respond_tool_approval,
            pdf_bridge::resolve_pdf_read,
            commands::messages::update_message,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_db_stats,
            commands::settings::reset_database,
            commands::mirror::mirror_all_chats,
            commands::mirror::import_chat_from_markdown,
            commands::attachments::upload_attachment,
            commands::attachments::save_pdf_attachment,
            commands::attachments::write_export_file,
            commands::attachments::get_attachment_images,
            commands::api::apply_api_settings,
            commands::api::generate_api_token,
            commands::api::api_bind_state,
            commands::voice::list_voice_input_devices,
            commands::voice::start_dictation,
            commands::voice::stop_dictation,
            commands::voice::cancel_dictation,
            commands::voice::dictation_level,
            commands::voice::dictation_partial,
            commands::voice::synthesize_speech,
            commands::voice::summarize_for_speech,
            commands::voice::list_tts_voices,
            commands::voice::list_cloned_voices,
            commands::voice::create_cloned_voice,
            commands::voice::delete_cloned_voice,
            commands::voice::transcribe_audio_file,
            commands::voice::transcribe_audio_upload,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Terminals outlive the turn that started them by design, so nothing
            // else takes them down. On Windows a child is not killed with its
            // parent either, which would leave a dev server holding its port with
            // no window left to stop it from.
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(tools::terminal::shutdown_all());
            }
        });
}
