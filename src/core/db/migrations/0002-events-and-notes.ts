/**
 * The event stream and typed notes.
 *
 * Built from the enum arrays like `0001-init.ts`, and parameterised for the
 * same reason: a test can inject a value no hardcoded list could know about,
 * which is the only way to prove the DDL is generated rather than copied.
 *
 * Two decisions here are the ones a reader will want to argue with, and both
 * are settled in ADRs rather than in this file:
 *
 * - **`events` has no foreign key to `tasks`** (ADR-008). An event records that
 *   something happened, and it happened whether or not the row still exists.
 *   `ON DELETE CASCADE` would erase the answer to the one audit question most
 *   worth asking; `RESTRICT` would make `delete` unreachable, since every task
 *   has a `created` event from birth. `entity_id` and `epic_id` are therefore
 *   historical references, not foreign keys — every read joining them to
 *   `tasks` must use an outer join.
 * - **`notes` cascades** (ADR-008 again). A note is fat content attached to a
 *   live task, not a record of an occurrence; without its task it is
 *   unreachable and unreadable. History survives, content does not.
 */

import { EVENT_TYPES, NOTE_KIND_DEFAULT, NOTE_KINDS, sqlEnum } from "../../enums.js";
import { KatraException } from "../../errors.js";
import { idPattern, NOTE_ID_PREFIX } from "../../id-format.js";
import type { Migration } from "../migrate.js";

export interface EventSets {
  readonly eventTypes: readonly string[];
  readonly noteKinds: readonly string[];
  readonly noteKindDefault: string;
  readonly noteIdPrefix: string;
}

export const DEFAULT_EVENT_SETS: EventSets = {
  eventTypes: EVENT_TYPES,
  noteKinds: NOTE_KINDS,
  noteKindDefault: NOTE_KIND_DEFAULT,
  noteIdPrefix: NOTE_ID_PREFIX,
};

/** Renders the events-and-notes DDL for the given value sets. */
export function buildEventsDdl(sets: EventSets = DEFAULT_EVENT_SETS): string {
  // Everything interpolated here is either escaped or validated. The default
  // goes through sqlEnum like the sets do — membership in `noteKinds` is not
  // enough on its own, since a caller could supply a matching kind *and* a
  // default containing a quote. The prefix cannot use sqlEnum (it lands inside
  // a GLOB pattern, not a string literal), so it is shape-checked below.
  // Unreachable with DEFAULT_EVENT_SETS — but `sets` is a parameter precisely
  // so callers can pass their own.
  if (!sets.noteKinds.includes(sets.noteKindDefault)) {
    throw new KatraException({
      code: "validation",
      message:
        `schema noteKindDefault must be one of ${sets.noteKinds.join(", ")}, ` +
        `got ${JSON.stringify(sets.noteKindDefault)} — a default outside the CHECK ` +
        "would make every note insert that omits a kind fail",
      field: "noteKindDefault",
      value: sets.noteKindDefault,
    });
  }
  if (!/^[a-z]+-$/.test(sets.noteIdPrefix)) {
    throw new KatraException({
      code: "validation",
      message: `schema noteIdPrefix must be lowercase letters ending in "-", got ${JSON.stringify(
        sets.noteIdPrefix,
      )}`,
      field: "noteIdPrefix",
      value: sets.noteIdPrefix,
    });
  }

  return `
CREATE TABLE events (
  -- INTEGER PRIMARY KEY is SQLite's rowid: assigned inside the write
  -- transaction, so it is a total order that agrees with commit order. Nobody
  -- types it, which is why it is not a kt-style random id.
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN (${sqlEnum(sets.eventTypes)})),
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
-- \`WHERE entity_id = ? OR epic_id = ?\`. Unindexed, every log degrades to a
-- full scan as history accumulates — and the session digest reads it on every
-- session start.
CREATE INDEX events_entity  ON events(entity_id);
CREATE INDEX events_epic    ON events(epic_id);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY CHECK (id GLOB '${idPattern(sets.noteIdPrefix)}'),
  -- CASCADE, unlike events: a note is content attached to a live task, not a
  -- record of an occurrence. Without its task it is unreachable.
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT ${sqlEnum([sets.noteKindDefault])}
             CHECK (kind IN (${sqlEnum(sets.noteKinds)})),
  -- The body IS the note, so an empty one is a validation refusal rather than
  -- a row. The length check makes that a database guarantee: a NOT NULL column
  -- still happily accepts the empty string.
  body       TEXT NOT NULL CHECK (length(body) > 0),
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Composite because notes are always read for one task, newest first.
CREATE INDEX notes_task ON notes(task_id, created_at);
`;
}

export const migration0002: Migration = {
  version: 2,
  name: "events-and-notes",
  sql: buildEventsDdl(),
};
