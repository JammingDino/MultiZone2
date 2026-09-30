-- Zones asking each other (ask_zone). A zone asked a question answers in its
-- own lane beside its ordinary reply, so the same zone can have both running
-- at once. Its messages carry the zone in `zone_id` as usual and the
-- consultation here, `<asking zone id>.<unique>`, which keeps one answer's
-- steps together and says who asked. NULL for everything else.
ALTER TABLE messages ADD COLUMN consult_id TEXT;
