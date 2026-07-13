-- 0.9.3 — tool usage stats. Per-zone, per-tool counters so a user can see which
-- tools a zone actually calls (and which ones keep erroring) and prune a bloated
-- toolset. Aggregate rather than an event log: the question is "does this zone
-- use this tool", not "when exactly", and a counter costs one UPSERT per call
-- instead of a row that grows without bound.

CREATE TABLE IF NOT EXISTS tool_usage (
    zone_id      TEXT NOT NULL,
    tool_name    TEXT NOT NULL,
    calls        INTEGER NOT NULL DEFAULT 0,
    errors       INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL,
    PRIMARY KEY (zone_id, tool_name)
);
