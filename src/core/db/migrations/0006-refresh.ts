/**
 * `ref-status-changed`: the events rebuild that lets F8's `refresh` record
 * when an external ref's status actually moved.
 *
 * The third rebuild of `events` for the same reason as 0003's and 0005's:
 * SQLite has no `ALTER TABLE ... ALTER COLUMN` and cannot widen a `CHECK`
 * constraint, so accepting `ref-status-changed` in `events.type` means
 * creating the new shape, copying every row across, dropping the old table
 * and renaming the new one in — the 12-column explicit list on both sides of
 * the `INSERT ... SELECT`, `prior_actor` included: leaving it off would
 * silently drop every forced release's prior holder, the trap 0005's own
 * docstring records for the rebuild before this one.
 *
 * Built from a `Sets` object like `0001-init.ts`, `0002-events-and-notes.ts`,
 * `0003-claims-and-presence.ts` and `0005-refs.ts`, for the same reason: a
 * `.sql` file cannot reference a TypeScript array, and `eventTypes` is a
 * parameter rather than a direct `EVENT_TYPES` import so a test can inject a
 * value no hardcoded list could know about.
 */

import { EVENT_TYPES, sqlEnum } from "../../enums.js";
import type { Migration } from "../migrate.js";

export interface RefreshSets {
  readonly eventTypes: readonly string[];
}

export const DEFAULT_REFRESH_SETS: RefreshSets = {
  eventTypes: EVENT_TYPES,
};

/** Renders migration 0006's DDL for the given value sets. */
export function buildRefreshDdl(sets: RefreshSets = DEFAULT_REFRESH_SETS): string {
  return `
-- \`PRAGMA foreign_keys\` is deliberately absent from this rebuild, same as
-- 0003's and 0005's: inside migrate()'s transaction the pragma is a silent
-- no-op — SQLite only honours it outside a transaction — and no table
-- references \`events\` (ADR-008) for it to guard regardless.
CREATE TABLE events_new (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN (${sqlEnum(sets.eventTypes)})),
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
-- from its own insertion order. \`listEvents\` sorts by this id as a total
-- order; a rebuild that silently renumbered it would still run, and would
-- still be wrong. \`prior_actor\` makes the copy list here for the second
-- rebuild running, exactly as 0005 carried it forward from 0003 — omitting it
-- would silently drop every forced release's prior holder.
INSERT INTO events_new
  (id, type, entity_id, epic_id, actor, from_lane, to_lane, ref, reason, title, prior_actor, created_at)
SELECT id, type, entity_id, epic_id, actor, from_lane, to_lane, ref, reason, title, prior_actor, created_at
FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

-- Dropping \`events\` drops everything built on it, indexes included — both
-- are recreated here rather than assumed to survive the rename.
CREATE INDEX events_entity ON events(entity_id);
CREATE INDEX events_epic   ON events(epic_id);
`;
}

export const migration0006: Migration = {
  version: 6,
  name: "refresh",
  sql: buildRefreshDdl(),
};
