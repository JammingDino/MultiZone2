-- 0.9.3 — context compaction. When a chat grows long, the model can summarize
-- its own older turns with `compact_context` rather than letting the oldest
-- messages silently fall out of the context window.
--
-- Nothing is deleted: the messages stay in the DB and stay on screen. Only the
-- history *sent to the model* is rewritten — turns at or before
-- `context_summary_through` are replaced by `context_summary`.

ALTER TABLE chats ADD COLUMN context_summary TEXT;
ALTER TABLE chats ADD COLUMN context_summary_through INTEGER;
