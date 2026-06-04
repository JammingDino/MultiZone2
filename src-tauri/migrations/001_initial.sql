CREATE TABLE IF NOT EXISTS providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  api_key    TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS zones (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  provider_id     TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model           TEXT NOT NULL,
  system_prompt   TEXT,
  temperature     REAL NOT NULL DEFAULT 0.7,
  max_tokens      INTEGER,
  top_p           REAL,
  tools_enabled   TEXT NOT NULL DEFAULT '[]',
  tool_config     TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New Chat',
  zone_id    TEXT REFERENCES zones(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  tool_calls   TEXT,
  tool_call_id TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
  chat_id      TEXT REFERENCES chats(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  file_type    TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  content      TEXT,
  page_count   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_chat_id ON attachments(chat_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
