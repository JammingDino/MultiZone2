-- 0.9.10 — shared workspace coordination for multi-agent sessions.
--
-- Sub-agents already had read/write/execute tools and inherited the parent's
-- project directory, which means several of them edit one working tree at the
-- same time with no idea the others exist. Two agents editing the same file is
-- a lost edit; two agents editing different files with no shared record of the
-- decisions between them is a merge nobody made.
--
-- Claims are advisory locks with an owner and an expiry, so a dead agent cannot
-- block a file forever. Notes are the session's shared log — the place a change
-- of contract ("foo() now accepts None") is written down where every other agent
-- reads it. Both are scoped to the session (the root chat of the sub-agent
-- family), not to a chat, because that is the boundary the collaboration has.

CREATE TABLE IF NOT EXISTS work_claims (
    session_id    TEXT NOT NULL,
    -- Normalized absolute path (lowercased on Windows) so the same file claimed
    -- as `src/a.ts` and `C:\proj\src\a.ts` collides as it should.
    path          TEXT NOT NULL,
    owner_chat_id TEXT NOT NULL,
    owner_zone_id TEXT,
    owner_name    TEXT NOT NULL,
    intent        TEXT,
    -- 1 when the claim was taken implicitly by a write rather than asked for, so
    -- the board can say which is which.
    implicit      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    PRIMARY KEY (session_id, path)
);

CREATE INDEX IF NOT EXISTS idx_work_claims_owner ON work_claims(owner_chat_id);

CREATE TABLE IF NOT EXISTS work_notes (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    author_chat_id TEXT NOT NULL,
    author_name    TEXT NOT NULL,
    -- note | decision | blocked | done | claim | release
    kind           TEXT NOT NULL DEFAULT 'note',
    text           TEXT NOT NULL,
    created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_notes_session ON work_notes(session_id, created_at);
