-- Fallback zone (0.14.1).
--
-- A zone whose provider has died — rate limited past its cooldown, host down,
-- key expired — takes the turn down with it. In a panel that means losing a
-- member mid-run; for a leader it means losing the run. A fallback names
-- another zone to answer with instead: usually the same role pointed at a
-- different provider, which is the whole point (a local model behind a hosted
-- one, or two hosted accounts).
--
-- ON DELETE SET NULL rather than a cascade: deleting the zone someone else
-- falls back to must not delete that zone as well.
ALTER TABLE zones ADD COLUMN fallback_zone_id TEXT
  REFERENCES zones(id) ON DELETE SET NULL;
