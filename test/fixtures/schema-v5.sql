
-- F7 requirement 1: one row per unique external thing — two tasks
-- referencing the same PR share it, one task holds many refs. `id` is
-- internal only (epic risk note 22): never published in the contract, never
-- a CLI input. `ref remove`'s two public forms are the url and the
-- qualified id (provider + external_id), resolved against a task's own
-- linked refs — never this rowid.
CREATE TABLE refs (
  id            INTEGER PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  external_id   TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  -- NULL for a bare id with no derivable URL — a Linear id given without its
  -- workspace slug, for one. An unresolved ref renders as a plain link with
  -- whatever is cached; nothing here blocks on this column being set.
  url           TEXT CHECK (url IS NULL OR length(url) <= 2048),
  -- Empty until the provider cycles (.21+) fill them (spec §4, §7). No CHECK
  -- constrains these: a provider's status/title vocabulary is not this
  -- migration's to define.
  cached_status TEXT NULL,
  cached_title  TEXT NULL,
  synced_at     TEXT NULL,
  UNIQUE (provider, external_id)
);

-- The join table: many tasks to many refs, at most one row per pair.
-- `task_id` and `ref_id` are NOT NULL deliberately, not decoration — SQLite
-- skips NOT NULL enforcement on a rowid table's composite PRIMARY KEY
-- columns, so without it a NULL in either would slip a row past the PK's own
-- guarantee.
CREATE TABLE task_refs (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ref_id  INTEGER NOT NULL REFERENCES refs(id),
  PRIMARY KEY (task_id, ref_id)
);

-- The reverse lookup: orphan GC ("is this ref still linked anywhere") and
-- "what tasks touch this ref" both filter on ref_id, which the composite
-- PK's leading column (task_id) cannot serve.
CREATE INDEX task_refs_ref ON task_refs(ref_id);

-- `PRAGMA foreign_keys` is deliberately absent from this rebuild, same as
-- 0003's: inside migrate()'s transaction the pragma is a silent no-op —
-- SQLite only honours it outside a transaction — and no table references
-- `events` (ADR-008) for it to guard regardless.
CREATE TABLE events_new (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('created','claimed','released','status-changed','note-added','closed','cancelled','reopened','deleted','ref-linked','ref-unlinked')),
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
-- still be wrong. `prior_actor` joins the copy list here for the first
-- time: 0003 introduced the column on its new table but had nothing to copy
-- yet, since it was migrating FROM a table that had no such column. 0005 is
-- the first rebuild of a table that already has `prior_actor` populated, so
-- leaving it off this copy would silently drop every forced release's prior
-- holder.
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
