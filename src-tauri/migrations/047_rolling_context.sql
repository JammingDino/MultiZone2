-- Rolling context (0.18) — see tools/rolling.rs.
--
-- rolling_context_tokens: this chat's conversation limit. NULL inherits the
-- `rollingContextTokens` app setting; 0 is a real value meaning off.
-- rolling_through: messages at or before it are forgotten from the request
-- (never from the database), except the latest user message.
ALTER TABLE chats ADD COLUMN rolling_context_tokens INTEGER;
ALTER TABLE chats ADD COLUMN rolling_through INTEGER;

-- What the model marked important, shown to it whatever has been forgotten.
-- message_id optionally pins a tool result's text; deliberately not a foreign
-- key, so deleting messages keeps the note.
CREATE TABLE context_pins (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  note       TEXT NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_context_pins_chat ON context_pins(chat_id);
