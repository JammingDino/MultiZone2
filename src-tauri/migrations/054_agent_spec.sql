-- One-off sub-agents (0.20.0): a leader can spawn a helper from a tool preset
-- or a tool list instead of naming a zone. The helper's subchat keeps a real
-- zone_id (its caller's, so every foreign key holds) and this spec is laid over
-- that zone whenever the chat's zone is resolved: name, instructions, tools,
-- read-only, model. NULL for every ordinary chat.
ALTER TABLE chats ADD COLUMN agent_spec TEXT;
