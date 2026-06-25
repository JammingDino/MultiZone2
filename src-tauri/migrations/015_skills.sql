-- Skills: reusable, named markdown instruction blocks that attach to zones and
-- are prepended to a zone's system prompt when that zone is active.

CREATE TABLE IF NOT EXISTS skills (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    content     TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Per-zone assignment, ordered. Skills concatenate in ascending `position`.
CREATE TABLE IF NOT EXISTS zone_skills (
    zone_id   TEXT NOT NULL REFERENCES zones(id)  ON DELETE CASCADE,
    skill_id  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (zone_id, skill_id)
);

-- Per-chat opt-out: a row with enabled = 0 disables one of the active zone's
-- assigned skills for that single conversation. Absence of a row = enabled.
CREATE TABLE IF NOT EXISTS chat_skills (
    chat_id   TEXT NOT NULL REFERENCES chats(id)  ON DELETE CASCADE,
    skill_id  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    enabled   INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (chat_id, skill_id)
);
