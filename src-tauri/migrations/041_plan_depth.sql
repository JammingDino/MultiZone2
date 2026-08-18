-- Plans with a document behind them (0.14.6).
--
-- 0.12.0 shipped a plan as an ordered list of one-line steps, and that is what
-- it produced: eight labels a person could read in four seconds and learn
-- nothing from. "Source selection strategy" is a heading, not a plan — the work
-- of planning is the paragraph under it, and there was nowhere to put one.
--
-- Two columns close that:
--
--   `context` — everything true of the plan as a whole before step 1: the scope
--   decision that was made and the ones that were rejected, the assumptions the
--   steps rest on, what the research turned up, and what is still open. It is
--   the part of a good plan that is not a step at all.
--
--   `doc_path` — where the plan was written on disk. A plan is drafted a step at
--   a time into a Markdown file under the app data directory, so a long plan
--   does not have to be held in one tool call, and so the model can read its own
--   plan back days later (`read_plan`) rather than reconstructing it from a
--   transcript that has since been compacted.
--
-- Steps themselves gain `detail` and `acceptance` inside the existing JSON blob,
-- which needs no migration — `PlanStep` defaults them to NULL, so every plan
-- written before this release parses unchanged.

ALTER TABLE plans ADD COLUMN context TEXT;
ALTER TABLE plans ADD COLUMN doc_path TEXT;

-- `drafting` joins the status vocabulary: a plan being written a step at a time
-- that the user has not been shown yet. It becomes `draft` — proposed, waiting
-- on the user — when `exit_plan_mode` files it.
CREATE INDEX IF NOT EXISTS idx_plans_drafting ON plans(chat_id, status, updated_at);
