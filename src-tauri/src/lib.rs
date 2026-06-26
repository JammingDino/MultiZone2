mod api;
mod db;
mod knowledge;
mod llm;
mod mcp;
mod ocr;
mod tools;
mod commands;
mod state;
mod error;

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
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let state = AppState::init(&handle).await.expect("failed to init app state");
                handle.manage(state);
                // Launch the HTTP API server if the user has enabled it.
                commands::api::start_if_enabled(&handle).await;
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
            commands::chats::delete_chat,
            commands::chats::branch_chat,
            commands::chats::delete_messages_from,
            commands::chats::delete_participant_messages,
            commands::chats::get_messages,
            commands::chats::generate_title,
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
            commands::skills::list_skills,
            commands::skills::upsert_skill,
            commands::skills::set_skill_enabled,
            commands::skills::delete_skill,
            commands::mcp::list_mcp_servers,
            commands::mcp::upsert_mcp_server,
            commands::mcp::delete_mcp_server,
            commands::mcp::connect_mcp_server,
            commands::mcp::disconnect_mcp_server,
            commands::mcp::set_mcp_tool_danger,
            commands::memory::list_memories,
            commands::memory::upsert_memory,
            commands::memory::delete_memory,
            commands::library::list_library_entries,
            commands::library::upsert_library_entry,
            commands::library::delete_library_entry,
            commands::messages::send_message,
            commands::messages::regenerate_response,
            commands::messages::regenerate_participant,
            commands::messages::cancel_stream,
            commands::messages::respond_tool_approval,
            commands::messages::update_message,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_db_stats,
            commands::settings::reset_database,
            commands::attachments::upload_attachment,
            commands::attachments::save_pdf_attachment,
            commands::attachments::get_attachment_images,
            commands::api::apply_api_settings,
            commands::api::generate_api_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
