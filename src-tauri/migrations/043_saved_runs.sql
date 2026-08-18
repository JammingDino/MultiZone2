-- Saved parameterised runs (0.15.4).
--
-- Zones and teams encode *who* does the work and are the app's main unit of
-- configuration. Nothing encodes the *task*. A job done every week — "summarise
-- this week's changes in <repo> for <audience>" — is retyped from memory every
-- week, slightly differently each time, and the version that worked is
-- whichever chat it happened in.
--
-- A run is a prompt template plus the parameters it takes plus the zone that
-- should answer it. One row, and one file when it is shared: the point of
-- parameters rather than a saved prompt is that the useful part is the shape,
-- and the shape is what survives being handed to somebody else.

CREATE TABLE IF NOT EXISTS saved_runs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  -- The prompt, with `{{param}}` placeholders. Rendering is deliberately dumb
  -- text substitution: a template language here would be a second thing to
  -- learn and a second thing to get wrong, and the model is downstream of it.
  template    TEXT NOT NULL,
  -- JSON array of `{ name, label?, description?, default?, required? }`.
  -- Not a table: parameters have no identity outside the run that declares
  -- them, are always read and written whole, and are what gets exported.
  params      TEXT NOT NULL DEFAULT '[]',
  -- The zone that should answer. Nullable, and SET NULL on delete, so a run
  -- outlives the zone it was written against and falls back to asking.
  zone_id     TEXT REFERENCES zones(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_runs_name ON saved_runs(name);
