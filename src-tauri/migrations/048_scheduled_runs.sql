-- Scheduled runs (0.18) — see schedule.rs.
--
-- A prompt sent on a clock: into a new chat each time (an inbox sweep at
-- noon) or appended to one chat (a reminder to itself). `watch_chat_id` hands
-- the run the tail of another chat's transcript, which is what a progress
-- report on a long-running agent needs.
--
-- `repeat` is 'once', 'interval' (every `interval_minutes`), 'daily' or
-- 'weekly' (at `time_of_day`, local 'HH:MM', on `weekdays`, a JSON array of
-- 0 = Sunday … 6 = Saturday). `next_run_at` is the only thing the scheduler
-- reads; it is recomputed before each firing, so a crash mid-run does not
-- fire the same run twice. NULL means nothing is due (a finished 'once').
CREATE TABLE scheduled_runs (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  target             TEXT NOT NULL DEFAULT 'new_chat',
  chat_id            TEXT REFERENCES chats(id) ON DELETE CASCADE,
  zone_id            TEXT REFERENCES zones(id) ON DELETE SET NULL,
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  watch_chat_id      TEXT REFERENCES chats(id) ON DELETE SET NULL,
  repeat             TEXT NOT NULL DEFAULT 'once',
  interval_minutes   INTEGER,
  time_of_day        TEXT,
  weekdays           TEXT,
  next_run_at        INTEGER,
  enabled            INTEGER NOT NULL DEFAULT 1,
  last_run_at        INTEGER,
  last_chat_id       TEXT,
  last_error         TEXT,
  created_by_chat_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_scheduled_runs_due ON scheduled_runs(enabled, next_run_at);
