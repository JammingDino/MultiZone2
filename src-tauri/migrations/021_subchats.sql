-- Subchats: a chat spawned and driven by a zone (vs. a user). Reuses the
-- parent_chat_id link from branching (migration 013); initiated_by_zone_id marks
-- the chat as a subchat and identifies the zone that owns/drives it. A child
-- chat with initiated_by_zone_id set is a subchat; one with only
-- branched_from_message_id set is a branch.
ALTER TABLE chats ADD COLUMN initiated_by_zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_chats_initiated_by ON chats(initiated_by_zone_id);
