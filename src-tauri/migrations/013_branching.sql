-- Conversation branching: a branched chat is a copy of another chat's history
-- up to and including a pivot message. Link it back to its parent so the
-- sidebar can nest branches under the chat they forked from.
ALTER TABLE chats ADD COLUMN parent_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL;
ALTER TABLE chats ADD COLUMN branched_from_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chats_parent ON chats(parent_chat_id);
