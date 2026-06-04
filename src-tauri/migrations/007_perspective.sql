-- Perspective zones for a chat: one row per zone added as a "perspective"
-- (beyond the primary zone stored in chats.zone_id).
CREATE TABLE IF NOT EXISTS chat_zones (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    PRIMARY KEY (chat_id, zone_id)
);

-- Track which zone produced each assistant message so perspective responses
-- can be filtered out of the primary conversation history.
ALTER TABLE messages ADD COLUMN zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL;
