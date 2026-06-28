-- Per-project override for whether new chats start with knowledge enabled
-- (0.4.3 follow-up). NULL = inherit the global default (the `knowledgeDefaultEnabled`
-- app setting); 0/1 = an explicit per-project override. Without this, a chat's
-- `knowledge_enabled` only ever turned on after creation, so the first message
-- could never use the search_knowledge tool.
ALTER TABLE projects ADD COLUMN kb_default_enabled INTEGER;
