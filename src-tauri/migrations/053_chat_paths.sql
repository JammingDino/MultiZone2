-- Paths handed to a chat (0.19.3): a folder dropped on it, a path pasted and
-- granted, one picked with "Add folder", or one it was launched on from
-- Explorer. Each is an extra root the chat's file tools may reach, beside the
-- project's directory. Sub-agents and branches inherit their top-level chat's
-- rows rather than copying them, so revoking one revokes it everywhere.
--
-- A table of its own rather than a column on `chats`, so the chat row and its
-- every INSERT stay as they are.
CREATE TABLE IF NOT EXISTS chat_paths (
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- Canonical, without the `\\?\` verbatim prefix.
    path       TEXT NOT NULL,
    is_dir     INTEGER NOT NULL,
    -- 'drop' | 'paste' | 'picker' | 'launch'
    source     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, path)
);
