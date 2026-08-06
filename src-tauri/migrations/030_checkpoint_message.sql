-- Anchor a checkpoint to the turn the user sees (0.10.1).
--
-- A checkpoint is keyed on the turn id the agentic loop mints, which the
-- frontend never sees. "Revert what this turn did" needs the assistant message
-- the turn opened with, so the transcript has somewhere to hang the action.
ALTER TABLE checkpoints ADD COLUMN message_id TEXT;

CREATE INDEX idx_checkpoints_message ON checkpoints(message_id);
