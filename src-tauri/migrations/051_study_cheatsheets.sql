-- Cheat sheets (study mode) — see study.rs.
--
-- A cheat sheet is a study set whose content is one Markdown document rather
-- than cards or questions: `kind` is 'cheatsheet' and the sheet is `body`.
-- The model writes it, and both the model and the learner can revise it, so
-- `updated_at` says when it last changed. NULL for decks and quizzes.
ALTER TABLE study_sets ADD COLUMN body TEXT;
ALTER TABLE study_sets ADD COLUMN updated_at INTEGER;
