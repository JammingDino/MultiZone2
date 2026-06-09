-- Per-chat execution-mode override for perspective zones.
-- NULL  = inherit the global default from app settings (perspectiveMode).
-- 'sequential' = run perspective zones one at a time (gentler on local model VRAM).
-- 'parallel'   = run all perspective zones concurrently.
-- Regardless of mode, every zone answers blind to the current round's sibling
-- responses; they only see each other's answers from previous rounds.
ALTER TABLE chats ADD COLUMN perspective_mode TEXT;
