-- Review before apply (0.10.2) — the review queue.
--
-- When review mode is on, a zone's `create_file` / `edit_file` writes land here
-- instead of on disk, and the user applies the batch after reading it. The row
-- holds the whole resulting content rather than a patch: the model may edit the
-- same file several times in a turn, each proposal computed on top of the last,
-- and only the newest is coherent — so a second staged edit to a path replaces
-- the first rather than queueing behind it.

CREATE TABLE staged_edits (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  -- The participant that proposed it: a perspective zone or sub-agent, NULL in
  -- an ordinary single-zone chat.
  zone_id       TEXT,
  -- Absolute and normalised — the key, matching the checkpoint store's.
  path          TEXT NOT NULL,
  -- The path as the model wrote it, which is what the user recognises.
  display_path  TEXT NOT NULL,
  -- Which tool proposed it, for the transcript's benefit.
  tool          TEXT NOT NULL,
  -- Whether the file existed when this was staged.
  existed       INTEGER NOT NULL,
  -- Hash of the file's contents at stage time. Applying compares it against
  -- the disk: a mismatch means somebody edited the file meanwhile, which is
  -- reported as a conflict rather than clobbered.
  disk_hash     TEXT,
  -- The full proposed contents.
  content       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- Set once written to disk. Applied rows are kept rather than deleted so the
  -- queue's history stays readable; every query filters on this being NULL.
  applied_at    INTEGER
);

CREATE INDEX idx_staged_edits_chat ON staged_edits(chat_id, applied_at, created_at);
CREATE INDEX idx_staged_edits_path ON staged_edits(chat_id, path, applied_at);
