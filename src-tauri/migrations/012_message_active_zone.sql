-- Track which zone answered each primary assistant message.
-- Perspective messages already use zone_id; this column is for the primary turn.
ALTER TABLE messages ADD COLUMN active_zone_id TEXT;
