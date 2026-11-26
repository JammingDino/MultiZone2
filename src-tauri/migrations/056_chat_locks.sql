-- Chat locks (0.20.0). A lock, not encryption: messages stay as they are; the
-- app refuses to hand a locked chat's contents out (see `chat_lock.rs`).
--
-- `lock_kind`: NULL = unlocked, 'chat' = its own password (hash in
-- `lock_hash`), 'app' = the app password below. `lock_hash` is never selected
-- into the `Chat` row the window and API receive.
ALTER TABLE chats ADD COLUMN lock_kind TEXT;
ALTER TABLE chats ADD COLUMN lock_hash TEXT;

-- The one app password, as a PBKDF2 hash. Its own table rather than a row in
-- `settings`, because `/api/settings/:key` reads and writes any settings key —
-- which would hand an agent the hash, or the power to replace it.
CREATE TABLE app_lock (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    hash TEXT NOT NULL
);
