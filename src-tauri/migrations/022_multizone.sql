-- Multizone Mode (0.6.0): Response Leader zone type + per-chat sub-agent roster.
--
-- A "Response Leader" is a zone configured to coordinate sub-agents: it drives
-- side conversations via the subchat tools (spawn_subagent / send_subchat_message)
-- and synthesizes their answers before replying to the user. `is_leader` marks
-- such zones so the library/editor can show a dedicated indicator and the engine
-- can inject the orchestration preamble.
ALTER TABLE zones ADD COLUMN is_leader INTEGER NOT NULL DEFAULT 0;

-- The sub-agent roster for a multizone session: the leader zone is the chat's
-- primary `zone_id`; each row here is a zone the leader may delegate to. Distinct
-- from `chat_zones` (perspective responders that answer every turn) — sub-agents
-- only run when the leader spawns them. Cleared if the chat or zone is deleted.
CREATE TABLE IF NOT EXISTS chat_subagents (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    PRIMARY KEY (chat_id, zone_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_subagents_chat ON chat_subagents(chat_id);
