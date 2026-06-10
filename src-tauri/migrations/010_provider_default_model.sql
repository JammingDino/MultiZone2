-- Default model for a provider, used by "simple"/quick chats that aren't bound
-- to a zone. Set alongside the provider during onboarding. NULL until chosen.
ALTER TABLE providers ADD COLUMN default_model TEXT;
