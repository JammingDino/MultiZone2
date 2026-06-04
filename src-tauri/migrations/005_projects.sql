CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    icon            TEXT,
    accent_color    TEXT,
    default_zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
    context_snippet TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    color            TEXT,
    context_snippet  TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_tags (
    chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    tag_id          TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    context_enabled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, tag_id)
);

ALTER TABLE chats ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE chats ADD COLUMN project_context_enabled INTEGER NOT NULL DEFAULT 0;
