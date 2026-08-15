
CREATE TABLE events (
  -- INTEGER PRIMARY KEY is SQLite's rowid: assigned inside the write
  -- transaction, so it is a total order that agrees with commit order. Nobody
  -- types it, which is why it is not a kt-style random id.
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('created','claimed','released','status-changed','note-added','closed','cancelled','reopened','deleted','ref-linked','ref-unlinked')),
  -- NO foreign key, by decision (ADR-008). The task may be gone; the event is
  -- still true.
  entity_id  TEXT NOT NULL,
  -- NULLABLE, and this is load-bearing: a top-level task has no epic, and an
  -- epic's own events have none either since an epic never has a parent. NOT
  -- NULL here would reject every event for a task created without --parent.
  epic_id    TEXT,
  actor      TEXT NOT NULL,
  -- status-changed only; NULL everywhere else.
  from_lane  TEXT,
  to_lane    TEXT,
  -- The note id, for note-added. Dangles once the note cascades away with its
  -- task, exactly like entity_id.
  ref        TEXT,
  -- Why, and only why: close and cancel put a human explanation here. It is
  -- deliberately NOT where a deleted task's title goes — see title below.
  reason     TEXT,
  -- The entity's title at the time, stamped on created and deleted.
  --
  -- Its own column rather than reason, because reason means "why" everywhere
  -- else and any generic renderer prints it as one. A LEFT JOIN to tasks
  -- cannot substitute: it returns NULL precisely for a deleted task, which is
  -- the whole scenario this column exists for.
  title      TEXT,
  created_at TEXT NOT NULL
);

-- Nothing prunes this table (ADR-008), and the entity read is
-- `WHERE entity_id = ? OR epic_id = ?`. Unindexed, every log degrades to a
-- full scan as history accumulates — and the session digest reads it on every
-- session start.
CREATE INDEX events_entity  ON events(entity_id);
CREATE INDEX events_epic    ON events(epic_id);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY CHECK (id GLOB 'nt-[0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z]'),
  -- CASCADE, unlike events: a note is content attached to a live task, not a
  -- record of an occurrence. Without its task it is unreachable.
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'general'
             CHECK (kind IN ('general','handoff','decision','acceptance')),
  -- The body IS the note, so an empty one is a validation refusal rather than
  -- a row. The length check makes that a database guarantee: a NOT NULL column
  -- still happily accepts the empty string.
  body       TEXT NOT NULL CHECK (length(body) > 0),
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Composite because notes are always read for one task, newest first.
CREATE INDEX notes_task ON notes(task_id, created_at);
