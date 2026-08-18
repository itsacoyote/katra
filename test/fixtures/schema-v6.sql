
-- `PRAGMA foreign_keys` is deliberately absent from this rebuild, same as
-- 0003's and 0005's: inside migrate()'s transaction the pragma is a silent
-- no-op — SQLite only honours it outside a transaction — and no table
-- references `events` (ADR-008) for it to guard regardless.
CREATE TABLE events_new (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('created','claimed','released','status-changed','note-added','closed','cancelled','reopened','deleted','ref-linked','ref-unlinked','ref-status-changed')),
  entity_id   TEXT NOT NULL,
  epic_id     TEXT,
  actor       TEXT NOT NULL,
  from_lane   TEXT,
  to_lane     TEXT,
  ref         TEXT,
  reason      TEXT,
  title       TEXT,
  prior_actor TEXT,
  created_at  TEXT NOT NULL
);

-- The id column is named explicitly on both sides, which is what carries
-- every row's LITERAL id across rather than letting SQLite renumber the copy
-- from its own insertion order. `listEvents` sorts by this id as a total
-- order; a rebuild that silently renumbered it would still run, and would
-- still be wrong. `prior_actor` makes the copy list here for the second
-- rebuild running, exactly as 0005 carried it forward from 0003 — omitting it
-- would silently drop every forced release's prior holder.
INSERT INTO events_new
  (id, type, entity_id, epic_id, actor, from_lane, to_lane, ref, reason, title, prior_actor, created_at)
SELECT id, type, entity_id, epic_id, actor, from_lane, to_lane, ref, reason, title, prior_actor, created_at
FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

-- Dropping `events` drops everything built on it, indexes included — both
-- are recreated here rather than assumed to survive the rename.
CREATE INDEX events_entity ON events(entity_id);
CREATE INDEX events_epic   ON events(epic_id);
