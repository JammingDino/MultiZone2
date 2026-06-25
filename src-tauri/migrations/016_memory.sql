-- Memory: model-managed long-term notes that persist across turns and chats.
-- Scope is 'global' (every chat), 'project' (chats in one project), or 'chat'
-- (a single conversation). scope_id holds the project/chat id, NULL for global.

CREATE TABLE IF NOT EXISTS memories (
    id         TEXT PRIMARY KEY,
    scope      TEXT NOT NULL,
    scope_id   TEXT,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id);
