
-- Requirement 1: at most one claim per task. `task_id` doubles as the
-- primary key and the foreign key, which is what makes "at most one" a
-- schema guarantee rather than an application-level check a race could still
-- slip past.
CREATE TABLE claims (
  task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  -- The absolute worktree path (ADR-007): identity that survives a branch
  -- rename, unlike the actor string below. No GLOB check here, unlike
  -- `tasks.id` and `notes.id` — a path is not a generated id, and its shape
  -- is the filesystem's to define, not this schema's. `deps` and `links`
  -- set the precedent: neither constrains the ids it references beyond the
  -- foreign key itself.
  holder     TEXT NOT NULL,
  -- The actor string frozen *at claim time*. A worktree renamed after
  -- claiming keeps showing the name it claimed under — accepted and
  -- documented, and why this is a stamped column rather than something
  -- joined live off `presence`.
  actor      TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

-- Requirement 2: one row per worktree, UPSERTed on every command (ADR-011).
-- `branch` is the only column that can go stale between writes — staleness
-- itself is judged from `last_seen` at read time, never enforced here.
CREATE TABLE presence (
  worktree  TEXT PRIMARY KEY,
  branch    TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- `PRAGMA foreign_keys` is deliberately absent from this rebuild, unlike the
-- textbook twelve-step dance. Inside migrate()'s transaction the pragma is a
-- silent no-op — SQLite only honours it outside a transaction — and it would
-- guard nothing here regardless: no table references `events` (ADR-008), so
-- there is no foreign key for the rebuild to trip.
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
  -- The holder a forced release displaces (requirement 4): `release --force`
  -- stamps the prior holder here so the takeover reads straight off the
  -- event, with no second query. Nullable and set nowhere else — every other
  -- event type has no prior actor to record. Considered stuffing this into
  -- `reason` instead; rejected, because `reason` means "why" everywhere else
  -- and a generic renderer prints it as one (the same argument that gave
  -- `deleted` its own `title` column in migration 0002).
  prior_actor TEXT,
  created_at  TEXT NOT NULL
);

-- The id column is named explicitly on both sides, which is what carries
-- every row's LITERAL id across rather than letting SQLite renumber the copy
-- from its own insertion order. `listEvents` sorts by this id as a total
-- order; a rebuild that silently renumbered it would still run, and would
-- still be wrong.
INSERT INTO events_new
  (id, type, entity_id, epic_id, actor, from_lane, to_lane, ref, reason, title, created_at)
SELECT id, type, entity_id, epic_id, actor, from_lane, to_lane, ref, reason, title, created_at
FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

-- Dropping `events` drops everything built on it, indexes included — both
-- are recreated here rather than assumed to survive the rename.
CREATE INDEX events_entity ON events(entity_id);
CREATE INDEX events_epic   ON events(epic_id);
