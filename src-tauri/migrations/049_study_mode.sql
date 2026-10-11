-- Study mode — see study.rs.
--
-- A project marked for study answers only from its own sources, and keeps
-- what the learner has been asked: decks of flashcards with a spaced-
-- repetition schedule each, and quizzes with every answer given. That record
-- is the difference between a teacher and a generator of study material, so
-- it lives here rather than in the transcript the tool call happens to sit in.
--
-- Everything is keyed by project: a deck made in one chat is due in all of
-- them. `chat_id` only says where a set came from, and outlives its chat.
ALTER TABLE projects ADD COLUMN study_mode INTEGER NOT NULL DEFAULT 0;

-- One generated deck or quiz. `kind` is 'flashcards' or 'quiz'.
CREATE TABLE study_sets (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chat_id    TEXT REFERENCES chats(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_study_sets_project ON study_sets(project_id, created_at);

-- SM-2 state per card. `due_at` is the only thing the review queue reads; a
-- new card is due the moment it exists. `interval_days` is 0 until the card
-- has been recalled once.
CREATE TABLE study_cards (
  id               TEXT PRIMARY KEY,
  set_id           TEXT NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal          INTEGER NOT NULL,
  front            TEXT NOT NULL,
  back             TEXT NOT NULL,
  source           TEXT,
  ease             REAL NOT NULL DEFAULT 2.5,
  interval_days    REAL NOT NULL DEFAULT 0,
  repetitions      INTEGER NOT NULL DEFAULT 0,
  lapses           INTEGER NOT NULL DEFAULT 0,
  due_at           INTEGER NOT NULL,
  last_reviewed_at INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_study_cards_due ON study_cards(project_id, due_at);
CREATE INDEX idx_study_cards_set ON study_cards(set_id, ordinal);

-- Multiple choice. `options` is a JSON array of strings.
CREATE TABLE study_questions (
  id           TEXT PRIMARY KEY,
  set_id       TEXT NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  question     TEXT NOT NULL,
  options      TEXT NOT NULL,
  answer_index INTEGER NOT NULL,
  explanation  TEXT,
  source       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_study_questions_set ON study_questions(set_id, ordinal);

-- Every answer, not just the latest: where the wrong answers cluster is the
-- thing the progress view and the model both want to know.
CREATE TABLE study_attempts (
  id           TEXT PRIMARY KEY,
  question_id  TEXT NOT NULL REFERENCES study_questions(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chosen_index INTEGER NOT NULL,
  correct      INTEGER NOT NULL,
  answered_at  INTEGER NOT NULL
);
CREATE INDEX idx_study_attempts_question ON study_attempts(question_id, answered_at);
