-- 0.9.2 — self-authored skills. A zone can write a skill with `create_skill`;
-- `authored_by_zone_id` records which zone wrote it (NULL = written by the user),
-- so the Skills settings page can distinguish them and prompt for review.
-- Self-authored skills are inserted with enabled = 0 and stay out of every
-- agent's catalog until the user turns them on.

ALTER TABLE skills ADD COLUMN authored_by_zone_id TEXT;
