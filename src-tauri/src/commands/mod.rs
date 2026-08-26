pub mod api;
pub mod providers;
pub mod zones;
pub mod checkpoints;
pub mod review;
pub mod chats;
pub mod diagram;
pub mod messages;
pub mod attachments;
pub mod settings;
pub mod projects;
pub mod library;
pub mod files;
pub mod skills;
pub mod memory;
pub mod mcp;
pub mod connectors;
pub mod knowledge;
pub mod mirror;
pub mod pending;
pub mod plans;
pub mod voice;
pub mod tool_usage;
pub mod usage;
pub mod search;
pub mod runs;
pub mod remote;

pub fn now_ts() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
