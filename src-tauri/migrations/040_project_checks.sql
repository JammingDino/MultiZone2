-- Per-project lint and test commands (0.14.5).
--
-- An agent that has just edited four files reports success in prose, which is
-- the thing it is best at and therefore the thing that tells you least. These
-- run once a turn's edits have landed and the output goes back to the model, so
-- "the implementer thinks it is done" becomes evidence — and so a compete-mode
-- leader picking between two diffs has something to pick on besides the quality
-- of the write-up.
--
-- NULL and empty both mean "not configured", and nothing is inferred: guessing
-- `npm test` in a repository whose dependencies have never been installed
-- produces a confident failure about the wrong thing, which is worse than no
-- check at all.
--
-- Per project rather than per zone: the command belongs to the codebase, not to
-- whoever is working in it, and every member of a panel must run the same one
-- or the evidence is not comparable.
ALTER TABLE projects ADD COLUMN lint_command TEXT;
ALTER TABLE projects ADD COLUMN test_command TEXT;
