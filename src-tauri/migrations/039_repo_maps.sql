-- Repository map cache (0.14.5).
--
-- The map is a ranked index of a project's definitions, injected at session
-- start so seven agents do not each spend their first several steps working out
-- where things are. Building it means reading and parsing every source file in
-- the tree, which is not something to do at the start of every session.
--
-- Keyed by directory, because that is what the map is *of* — every chat and
-- every sub-agent pointed at the same project shares one.
--
-- `signature` is a hash of the walk's own output (paths, sizes, mtimes), so an
-- unchanged tree is recognisable in milliseconds without reading a byte of it.
-- `token_budget` is part of the match rather than a column that gets ignored:
-- the budget decides how much of the ranking is rendered, so a map built for
-- 1,000 tokens is not the map for 4,000, and serving one for the other would
-- quietly hand the user a size they did not ask for.
CREATE TABLE IF NOT EXISTS repo_maps (
    directory    TEXT PRIMARY KEY,
    signature    TEXT NOT NULL,
    token_budget INTEGER NOT NULL,
    content      TEXT NOT NULL,
    files        INTEGER NOT NULL,
    symbols      INTEGER NOT NULL,
    generated_at INTEGER NOT NULL
);
