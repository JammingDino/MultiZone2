pub mod api;
pub mod providers;
pub mod zones;
pub mod chats;
pub mod messages;
pub mod attachments;
pub mod settings;
pub mod projects;
pub mod library;
pub mod skills;
pub mod memory;
pub mod mcp;
pub mod knowledge;

pub fn now_ts() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
