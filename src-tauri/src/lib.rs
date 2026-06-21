mod api;
mod db;
mod llm;
mod tools;
mod commands;
mod state;
mod error;

use state::AppState;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // In release builds windows_subsystem = "windows" silences all console output,
    // making panics invisible. Write them to a file so crashes are diagnosable.
    #[cfg(not(debug_assertions))]
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("{info}");
        let path = std::env::temp_dir().join("multizone_crash.txt");
        let _ = std::fs::write(&path, &msg);
    }));

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("multizone=debug".parse().unwrap()))
        .init();

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
            commands::messages::send_message,
            commands::messages::regenerate_response,
            commands::messages::regenerate_participant,
            commands::messages::cancel_stream,
            commands::messages::respond_tool_approval,
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
