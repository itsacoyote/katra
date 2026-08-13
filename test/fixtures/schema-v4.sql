
-- Requirement 9 / ADR-013: full-text search over task titles, descriptions
-- and note bodies. External-content, not duplicated storage: `tasks` and
-- `notes` stay the single source of truth, these virtual tables hold only
-- the index, and a corrupted index is recoverable with
-- `INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')` — documented
-- recovery, not a shipped command.
--
-- `content_rowid='rowid'` works because `tasks` is an ordinary rowid table:
-- `id` is a TEXT PRIMARY KEY, not `WITHOUT ROWID`, so SQLite's implicit
-- `rowid` column is there to join the index back to its row
-- (research-verified).
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, description,
  content='tasks',
  content_rowid='rowid'
);

-- The sync-trigger triad, verbatim from the sqlite.org external-content
-- recipe (ADR-013: triggers, not application-level sync, so every writer —
-- including ones that don't exist yet — is covered from inside its own
-- transaction, with nothing for a new write path to remember).
CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description)
  VALUES (new.rowid, new.title, new.description);
END;

-- The special 'delete' command, not a bare DELETE: an external-content FTS5
-- table stores no retrievable columns of its own to filter a DELETE
-- against, only the index built from them. This INSERT is the operation
-- that removes a posting.
CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
  VALUES('delete', old.rowid, old.title, old.description);
END;

-- Scoped to `OF title, description`, not a bare AFTER UPDATE ON tasks: a
-- lane or priority bump is by far the commonest write this table sees —
-- every lifecycle transition touches it — and neither column is indexed. An
-- unscoped trigger would pay the delete+insert FTS tax on every one of those
-- writes for no reindexing benefit; ADR-013's Consequences section accepts
-- that tax only for writes that actually change indexed text.
CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, description ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
  VALUES('delete', old.rowid, old.title, old.description);
  INSERT INTO tasks_fts(rowid, title, description)
  VALUES (new.rowid, new.title, new.description);
END;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  body,
  content='notes',
  content_rowid='rowid'
);

-- Notes are insert-only in this codebase today (notes/repo.ts has no update
-- path) — but the triad is written in full regardless, both to match the
-- sqlite.org canon exactly (ADR-013) and because "no update path exists yet"
-- is not a guarantee this schema should quietly depend on.
CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;

-- `notes.task_id` cascades ON DELETE CASCADE (migration 0002, ADR-008): a
-- note cannot outlive its task. Deleting a task therefore deletes its notes
-- as a database-level side effect of that same statement, and SQLite runs
-- each cascaded removal as an ordinary DELETE against `notes` — which this
-- AFTER DELETE trigger sees exactly like a direct `katra` delete would
-- (probe-verified 2026-08-13, under katra's `foreign_keys = ON` connection: a
-- cascade-deleted note's text left the index). This is the whole mechanism
-- for both cases; no separate trigger on `tasks` reaches into `notes_fts`.
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;

CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;

-- One-time backfill. Migration 0004 runs exactly once per store, ever —
-- `migrate()` is forward-only and never re-applies a step once the store's
-- `user_version` has passed it — so this INSERT...SELECT runs exactly once
-- by construction. That guarantee is worth stating plainly: running it twice
-- would not error, and `integrity-check` would still report the result
-- clean, but every posting would be silently duplicated, skewing bm25
-- ranking — and because neither table's rowid is AUTOINCREMENT, a stale
-- posting left behind by some future bypass of this guarantee would
-- eventually collide with a reused rowid and corrupt that row's snippets.
-- Backfilling here is also what makes the migrated dogfood store searchable
-- with no extra step (ADR-013's stated consequence).
INSERT INTO tasks_fts(rowid, title, description)
  SELECT rowid, title, description FROM tasks;
INSERT INTO notes_fts(rowid, body)
  SELECT rowid, body FROM notes;
