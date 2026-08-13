# ADR-013: FTS5 external-content index, synchronized by triggers

## Status

Accepted

## Date

2026-08-13

## Context

F6 adds `search` — full-text over task titles/descriptions and note bodies
(spec §6c). The index must answer two demands that pull in different
directions: it must never drift from the store (the store is written by
concurrent processes across worktrees, and a search that misses a task that
exists is worse than no search), and it must not complicate every write path
(F5's seam work just finished centralizing those).

SQLite's FTS5 is already compiled into `better-sqlite3`; the question is not
the engine but the synchronization mechanism.

## Decision

**External-content FTS5 tables** (`content=tasks`, `content=notes`) **kept in
sync by AFTER INSERT/UPDATE/DELETE triggers on the content tables**, created
in migration 0004 alongside a one-time backfill of existing rows.

- External-content, not contentless or duplicated: the store stays the single
  source of truth; FTS holds only the index, and a corrupted index is
  recoverable by rebuild (`INSERT INTO <fts>(<fts>) VALUES('rebuild')`) —
  documented recovery, not a shipped command.
- Triggers, not application-level sync: a trigger fires inside the same
  transaction as the write it mirrors, for every writer — including ones that
  don't exist yet. An app-level hook is one more thing `createTaskWithin`,
  the F5 loader, and every future write path must each remember; the 0003
  events rebuild already proved how migrations handle schema evolution
  around such tables.

## Consequences

- Every task/note write pays a small FTS-maintenance tax inside its existing
  transaction. Measured against the same budget discipline as F3/F4: the
  perf criterion covers it.
- Migration 0004 must create the virtual tables, the triggers, and backfill —
  the migrated dogfood store becomes searchable with no extra step.
- UPDATE sync on external-content tables uses FTS5's delete+insert protocol
  inside the trigger — an implementation detail the migration owns once,
  instead of every writer owning forever.
- Read commands stay pure: search only reads; nothing about the index is
  maintained at read time.
- The trigger/index pairing is a coupling any future schema change on
  `tasks`/`notes` has to honor deliberately — `integrity-check` will not flag
  a break. A migration that rebuilds either table by drop-and-recreate (0002's
  and 0003's own idiom for widening a `CHECK`) drops these triggers with the
  table, and must recreate them and rebuild the index in that same step. A
  future `VACUUM` (none exists today) would need the same treatment, since it
  can renumber the implicit rowids `content_rowid='rowid'` depends on.

## Alternatives considered

**Rebuild-on-read (lazy index).** Makes reads into writers — exactly what
ADR-011 narrowed presence to avoid, and a staleness window between rebuilds
in which search lies about the store.

**App-level sync in the repo functions.** A second place every write must
remember, forever; a forgotten call site silently unindexes rows. Triggers
cannot be forgotten.

**Contentless/duplicated FTS storage.** Doubles stored text and adds manual
delete bookkeeping for no gain at this scale.
