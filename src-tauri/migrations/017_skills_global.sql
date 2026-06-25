-- Skills become global, on-demand resources (Anthropic Agent Skills model):
-- a catalog of name + description is shown to any agent that has the skills
-- tool, and the agent loads a skill's full content on demand. `enabled` controls
-- whether a skill appears in that catalog. The zone_skills / chat_skills tables
-- from migration 015 are no longer used for injection (left in place, harmless).

ALTER TABLE skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
