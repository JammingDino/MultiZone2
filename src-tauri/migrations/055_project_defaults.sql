-- Project-level defaults an agent (or the user) can set once for every chat in
-- the project (0.20.0), so "set this project up for me" covers permissions too.
--
-- `approvals`: the same JSON shape as `zones.approvals` (categories, shell and
-- edit allow/deny lists), plus an optional `planEntry`. Layered between the
-- global policy and the zone's: global, then project, then zone. NULL = inherit.
ALTER TABLE projects ADD COLUMN approvals TEXT;
-- Session token ceiling for chats in this project that have none of their own.
-- NULL = the global default; 0 = unmetered (as on `chats.spend_limit`).
ALTER TABLE projects ADD COLUMN spend_limit INTEGER;
