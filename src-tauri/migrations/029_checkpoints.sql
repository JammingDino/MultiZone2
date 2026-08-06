-- Checkpoints (0.10.0) — a way back from the file tools.
--
-- One checkpoint per turn per participant, holding the state of every path that
-- turn is about to change, captured before the change lands. Restoring one puts
-- those paths back. The snapshot is per-path rather than per-directory: an agent
-- that edits three files should cost three files of storage, not a copy of the
-- working tree.

CREATE TABLE checkpoints (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  -- The turn this checkpoint belongs to. Several mutating tool calls in one
  -- turn extend one checkpoint rather than each opening their own, so "revert
  -- this turn" is one action however many files the turn touched.
  turn_id      TEXT NOT NULL,
  -- The participant that did the mutating: a perspective zone or sub-agent in a
  -- multi-zone turn, NULL for an ordinary single-zone chat.
  zone_id      TEXT,
  created_at   INTEGER NOT NULL,
  -- What opened it, for the transcript: the first mutating tool of the turn.
  label        TEXT,
  -- Set when this checkpoint has been restored from, so the UI can say so.
  restored_at  INTEGER
);

CREATE UNIQUE INDEX idx_checkpoints_turn ON checkpoints(chat_id, turn_id, COALESCE(zone_id, ''));
CREATE INDEX idx_checkpoints_chat ON checkpoints(chat_id, created_at DESC);

-- One row per path a checkpoint covers, holding what was there *before*.
CREATE TABLE checkpoint_files (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  -- Absolute and normalised — the key. `display_path` is what the model wrote.
  path          TEXT NOT NULL,
  display_path  TEXT NOT NULL,
  -- 0 when nothing was there: restoring means deleting whatever is there now.
  existed       INTEGER NOT NULL,
  -- Content address of the prior contents in the blob store. NULL when the file
  -- did not exist, or when `unstorable` says why it could not be captured.
  before_hash   TEXT,
  before_size   INTEGER,
  -- Content address after the turn finished with the path. Restoring compares
  -- it against what is on disk now: a mismatch means the file was edited
  -- outside the app since, which the user is told about rather than clobbered.
  after_hash    TEXT,
  -- Why the prior contents were not captured (too large, a directory, an IO
  -- error). A restore honours it by reporting what it cannot bring back
  -- instead of pretending it succeeded.
  unstorable    TEXT,
  PRIMARY KEY (checkpoint_id, path)
);

CREATE INDEX idx_checkpoint_files_hash ON checkpoint_files(before_hash);
