-- Mark assistant (or any) messages whose content was hand-edited by the user.
-- Drives the "edited" marker in the chat UI; branching copies the edited content
-- verbatim, so a branch from an edited message inherits the edited text.
ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;
