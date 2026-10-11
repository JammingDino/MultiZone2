-- Icons a model drew — see project_setup.rs.
--
-- Stored as sanitised SVG and referred to from `projects.icon` / `zones.icon`
-- as `gen:<id>`, so the icon picker can offer them beside the shipped set and
-- any project or zone can wear one.
CREATE TABLE generated_icons (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  svg        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
