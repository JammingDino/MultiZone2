-- Cross-chat message search (0.15.0).
--
-- Sub-agents, perspectives and branches multiply the number of conversations
-- by the size of the panel: a run that spawns six sub-agents is seven chats,
-- and the sidebar lists them all by title. There was no way to find the chat
-- where something was actually said, only to remember which one it was.
--
-- The index lives in the database rather than in Rust because a message is
-- written from a dozen places — the turn loop, an edit, a branch, a rewind, a
-- checkpoint restore, the HTTP API — and an index maintained by triggers
-- cannot be bypassed by a path that forgot to call it.
--
-- `content` is a JSON array of content parts, so the trigger extracts the
-- `text` ones and joins them. Deliberately not `hidden_text`: that is context
-- injected behind the user's back (attachment bodies, project rules), and a
-- hit the user cannot see in the transcript is a result they cannot act on.

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

-- Backfill. `rowid` is aligned with `messages.rowid` throughout, so the index
-- joins back to the row it came from and a stale entry can never outlive its
-- message: the search joins `messages`, and a row that is gone drops the hit.
INSERT INTO messages_fts(rowid, body)
SELECT m.rowid,
       (SELECT group_concat(json_extract(p.value, '$.text'), char(10))
          FROM json_each(m.content) p
         WHERE json_extract(p.value, '$.type') = 'text')
  FROM messages m
 WHERE m.role IN ('user', 'assistant')
   AND json_valid(m.content)
   AND (SELECT group_concat(json_extract(p.value, '$.text'), char(10))
          FROM json_each(m.content) p
         WHERE json_extract(p.value, '$.type') = 'text') <> '';

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
WHEN new.role IN ('user', 'assistant') AND json_valid(new.content)
BEGIN
  INSERT INTO messages_fts(rowid, body)
  SELECT new.rowid,
         (SELECT group_concat(json_extract(p.value, '$.text'), char(10))
            FROM json_each(new.content) p
           WHERE json_extract(p.value, '$.type') = 'text')
   WHERE (SELECT group_concat(json_extract(p.value, '$.text'), char(10))
            FROM json_each(new.content) p
           WHERE json_extract(p.value, '$.type') = 'text') <> '';
END;

-- An edited message re-indexes (0.11.x gave the user an edit button); the
-- delete half runs unconditionally, because the old row may be indexed even
-- when the new one will not be.
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages
BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, body)
  SELECT new.rowid,
         (SELECT group_concat(json_extract(p.value, '$.text'), char(10))
            FROM json_each(new.content) p
           WHERE json_extract(p.value, '$.type') = 'text')
   WHERE new.role IN ('user', 'assistant')
     AND json_valid(new.content)
     AND (SELECT group_concat(json_extract(p.value, '$.text'), char(10))
            FROM json_each(new.content) p
           WHERE json_extract(p.value, '$.type') = 'text') <> '';
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;
