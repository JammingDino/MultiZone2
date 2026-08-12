-- The session event log (0.12.2).
--
-- Everything an agent does is already in SQLite somewhere: the messages table
-- has the tool calls, the checkpoints have the file mutations, tool_usage has
-- the counters. None of it is a *timeline*, so the only way to see what an agent
-- did was to re-read the transcript and reconstruct the order by eye — and the
-- things that never appear in a transcript at all (an approval denied, a zone
-- switched mid-turn, plan mode entered, a turn that ended in an error) were
-- simply gone once the toast faded.
--
-- One ordered, queryable record per chat. Deliberately append-only and
-- deliberately denormalised: `label` is the line a human reads, so replaying a
-- session six months later doesn't depend on the zone, the plan or the file
-- still existing. `detail` is the structured version for anything that wants to
-- go deeper.

CREATE TABLE session_events (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  -- Groups every event of one turn, matching the turn id the checkpoints use,
  -- so a replay can collapse a turn and an "undo this turn" can be lined up
  -- against what the turn actually did.
  turn_id     TEXT,
  -- The participant: a perspective zone or sub-agent, NULL for the primary.
  zone_id     TEXT,
  -- turn_start · turn_end · tool_call · tool_error · approval · denial ·
  -- zone_switch · file_change · plan_mode · plan_filed · plan_approved ·
  -- plan_rejected · plan_stop · error · cancelled
  kind        TEXT NOT NULL,
  -- One line, already written for a person.
  label       TEXT NOT NULL,
  -- JSON: whatever the kind wants to carry (tool arguments, the path, the
  -- plan id, the error text).
  detail      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_session_events_chat ON session_events(chat_id, created_at);
CREATE INDEX idx_session_events_turn ON session_events(chat_id, turn_id);
