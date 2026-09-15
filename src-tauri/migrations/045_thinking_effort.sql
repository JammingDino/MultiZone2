-- Thinking, per model (0.17.9).
--
-- `thinking_enabled` was a switch that always sent `reasoning_effort:
-- "medium"`, to every model alike. The level is now the zone's to choose, and
-- how it is expressed — `reasoning_effort`, a chat-template toggle, nothing at
-- all — is decided per model by `llm::thinking::profile`. Existing zones keep
-- the medium they were already getting.
ALTER TABLE zones ADD COLUMN thinking_effort TEXT NOT NULL DEFAULT 'medium';
