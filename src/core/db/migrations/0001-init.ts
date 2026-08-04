/**
 * The initial schema.
 *
 * The DDL is *built* from the enum arrays rather than written beside them.
 * A `.sql` text file cannot reference a TypeScript array, which is precisely
 * how a renamed lane would leave the `CHECK` constraint behind — and these
 * constraints are load-bearing, since the store is written by concurrent
 * processes and a type does not survive to runtime.
 *
 * `buildInitDdl` takes the sets as an argument for the same reason: a test can
 * inject a value no hardcoded list could know about, which is the only way to
 * prove the DDL is generated rather than copied.
 */

import {
  KINDS,
  LANES,
  LEVELS,
  PRIORITY_DEFAULT,
  PRIORITY_MAX,
  PRIORITY_MIN,
  sqlEnum,
  TERMINAL_LANES,
} from "../../enums.js";
import type { Migration } from "../migrate.js";

export interface SchemaSets {
  readonly levels: readonly string[];
  readonly kinds: readonly string[];
  readonly lanes: readonly string[];
  readonly terminalLanes: readonly string[];
  readonly priorityMin: number;
  readonly priorityMax: number;
  readonly priorityDefault: number;
}

export const DEFAULT_SCHEMA_SETS: SchemaSets = {
  levels: LEVELS,
  kinds: KINDS,
  lanes: LANES,
  terminalLanes: TERMINAL_LANES,
  priorityMin: PRIORITY_MIN,
  priorityMax: PRIORITY_MAX,
  priorityDefault: PRIORITY_DEFAULT,
};

/** Renders the initial DDL for the given value sets. */
export function buildInitDdl(sets: SchemaSets = DEFAULT_SCHEMA_SETS): string {
  const terminal = sqlEnum(sets.terminalLanes);

  return `
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  level        TEXT NOT NULL CHECK (level IN (${sqlEnum(sets.levels)})),
  kind         TEXT NOT NULL CHECK (kind IN (${sqlEnum(sets.kinds)})),
  title        TEXT NOT NULL,
  description  TEXT,
  lane         TEXT NOT NULL DEFAULT 'Defined' CHECK (lane IN (${sqlEnum(sets.lanes)})),
  -- typeof, not just the range: SQLite's flexible typing stores 2.5 in an
  -- INTEGER column, and BETWEEN accepts it. The row then throws from
  -- narrowPriority the next time anything reads it, which is a corrupt store
  -- rather than a rejected write.
  priority     INTEGER NOT NULL DEFAULT ${sets.priorityDefault}
               CHECK (typeof(priority) = 'integer'
                      AND priority BETWEEN ${sets.priorityMin} AND ${sets.priorityMax}),
  assignee     TEXT,
  -- RESTRICT, not SET NULL: SET NULL orphans an epic's children with no error,
  -- no lane change and no trace. RESTRICT makes refusing that deletion a
  -- database guarantee rather than an application check.
  parent_id    TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  closed_at    TEXT,
  close_reason TEXT,
  CHECK (parent_id IS NULL OR parent_id <> id),
  -- An epic sits at the top of the two-level hierarchy, so it never has a parent.
  CHECK (level <> 'epic' OR parent_id IS NULL),
  -- A terminal lane always carries closed_at. This is what stops any path other
  -- than close/cancel from producing terminal work that silently releases its
  -- dependents, including raw SQL that bypasses application validation.
  CHECK (lane NOT IN (${terminal}) OR closed_at IS NOT NULL)
);

-- "parent must be an epic" cannot be a CHECK: SQLite prohibits subqueries
-- there. A trigger is the only declarative way to enforce it, and it has to
-- cover reparenting as well as insertion.
CREATE TRIGGER tasks_parent_must_be_epic_insert
BEFORE INSERT ON tasks
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'parent_id must reference an epic')
  WHERE (SELECT level FROM tasks WHERE id = NEW.parent_id) IS NOT 'epic';
END;

CREATE TRIGGER tasks_parent_must_be_epic_update
BEFORE UPDATE OF parent_id ON tasks
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'parent_id must reference an epic')
  WHERE (SELECT level FROM tasks WHERE id = NEW.parent_id) IS NOT 'epic';
END;

-- The two triggers above fire only on parent_id writes, so demoting an epic
-- that still has children would slip past both and leave every child pointing
-- at a row that is no longer an epic. RESTRICT covers deletion; this covers
-- the level change.
CREATE TRIGGER tasks_epic_demotion_guard
BEFORE UPDATE OF level ON tasks
WHEN OLD.level = 'epic' AND NEW.level <> 'epic'
BEGIN
  SELECT RAISE(ABORT, 'cannot demote an epic that still has children')
  WHERE EXISTS (SELECT 1 FROM tasks WHERE parent_id = OLD.id);
END;

CREATE TABLE deps (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE links (
  a_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  b_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (a_id, b_id),
  -- Canonical ordering makes symmetry a storage invariant: one pair, one row,
  -- never the same link recorded twice in opposite directions.
  CHECK (a_id < b_id)
);

CREATE TABLE tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

-- THE definition of readiness. list, next, cancel and delete all join this
-- view, and isReady() queries it for one row. A second NOT EXISTS expression
-- written anywhere else is the drift this exists to prevent.
CREATE VIEW task_readiness AS
SELECT t.id AS id,
       NOT EXISTS (
         SELECT 1 FROM deps d
         JOIN tasks b ON b.id = d.depends_on_id
         WHERE d.task_id = t.id AND b.lane NOT IN (${terminal})
       ) AS is_ready
FROM tasks t;

CREATE INDEX tasks_lane_priority ON tasks(lane, priority);
CREATE INDEX tasks_parent        ON tasks(parent_id);
-- Chronological ordering lives here rather than in the id, because ids are
-- random by design (ADR-001).
CREATE INDEX tasks_created       ON tasks(created_at);
CREATE INDEX deps_depends_on     ON deps(depends_on_id);
-- Serves requirement 44's --tag filter. The table's primary key is
-- (task_id, tag), which cannot answer "which tasks carry this tag".
CREATE INDEX tags_tag            ON tags(tag);
`;
}

export const migration0001: Migration = {
  version: 1,
  name: "init",
  sql: buildInitDdl(),
};
