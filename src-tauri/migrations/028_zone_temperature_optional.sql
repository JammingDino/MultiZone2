-- Optional zone temperature (0.9.14).
--
-- A zone may now leave temperature unset, in which case the request omits the
-- field entirely and the provider applies its own default. New zones start
-- unset; every existing zone keeps the value it already had.
--
-- The original `temperature` column is `NOT NULL DEFAULT 0.7`, and SQLite has no
-- way to drop a NOT NULL constraint short of rebuilding the table — which here
-- would mean dropping `zones` while chats, chat_zones and chat_subagents hold
-- foreign keys into it (their ON DELETE actions would fire and silently clear
-- those assignments). So the nullable value lives in a new column instead; the
-- old one is left behind, unread, keeping its default so nothing that still
-- writes it can fail.
ALTER TABLE zones ADD COLUMN temperature_override REAL;
UPDATE zones SET temperature_override = temperature;
