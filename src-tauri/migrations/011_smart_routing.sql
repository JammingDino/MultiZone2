-- "Smart chat" mode: when set, each turn a router model picks the most suitable
-- zone to answer, instead of the chat being bound to one zone. zone_id stays
-- NULL while smart_routing is on.
ALTER TABLE chats ADD COLUMN smart_routing INTEGER NOT NULL DEFAULT 0;
