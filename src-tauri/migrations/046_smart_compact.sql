-- Smart compaction (0.18): messages at or before this cutoff are sent with
-- their tool output trimmed, superseded results dropped, long tool inputs
-- hidden and thinking stripped (see tools/smart_compact.rs). NULL = never.
-- Like context_summary_through, it rewrites only the request, never the rows.
ALTER TABLE chats ADD COLUMN smart_compact_through INTEGER;
