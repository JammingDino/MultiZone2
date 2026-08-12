-- Plan mode (0.12.0) — planning as a chat mode, and the plan as an artifact.
--
-- `update_plan` (0.9.3) gave the model a checklist it keeps in its own context.
-- What neither it nor anything else gave the *user* was a say: no point at which
-- the work is described before it happens, and nothing to edit before agreeing
-- to it. Plan mode is that point. While a chat is in plan mode the mutating
-- tools are withheld from the request entirely — read-only tools stay, so the
-- plan is grounded in the real files — and the model's job is to produce one of
-- these rows.
--
-- A plan is a row rather than prose in the transcript because the user edits it
-- (reorder, delete, rewrite a step) before approving, and because the approved
-- steps become the executing turn's task list: the model is held to the plan the
-- user agreed to instead of quietly substituting another.

ALTER TABLE chats ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;

CREATE TABLE plans (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT NOT NULL,
  -- The participant that authored it: a sub-agent or perspective zone, NULL for
  -- the primary conversation. A Multizone leader and its sub-agents each own a
  -- plan, and `parent_plan_id` links them into the one tree the UI renders.
  zone_id         TEXT,
  parent_plan_id  TEXT,
  -- A short name for the plan, and the one-line goal it serves.
  title           TEXT NOT NULL DEFAULT '',
  goal            TEXT,
  -- JSON array of steps: { id, step, intent, files: [..], risk, status, note, error }.
  -- Held as one blob rather than a table of rows because a plan is always read,
  -- rewritten and approved whole — a step has no life of its own.
  steps           TEXT NOT NULL,
  -- draft      — proposed, waiting for the user
  -- approved   — the user agreed to it; it is the next turn's task list
  -- executing  — a turn is working through it
  -- done       — every step finished (or was struck)
  -- rejected   — the user said no; the model stays in plan mode and revises
  -- superseded — a newer draft replaced it before it was ever approved
  status          TEXT NOT NULL DEFAULT 'draft',
  -- Set when the user edited the steps before approving, so the transcript can
  -- say the plan that ran was not verbatim the plan that was proposed.
  edited_by_user  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  approved_at     INTEGER
);

CREATE INDEX idx_plans_chat ON plans(chat_id, created_at);
CREATE INDEX idx_plans_status ON plans(chat_id, status);
