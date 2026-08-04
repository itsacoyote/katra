
CREATE TABLE tasks (
  -- The format is enforced here, not merely produced by generateId. The cycle
  -- walk's instr guard is only exact because no id can be a substring of
  -- another, which holds only while every id has the same length and alphabet.
  -- A single hand-written id defeats cycle detection silently: verified that
  -- with the ids kt-aaaaaa and a, addDependency accepts an edge closing a real
  -- loop, and nothing ever reports it.
  id           TEXT PRIMARY KEY CHECK (id GLOB 'kt-[0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z]'),
  level        TEXT NOT NULL CHECK (level IN ('epic','task')),
  kind         TEXT NOT NULL CHECK (kind IN ('feat','fix','refactor','perf','docs','test','chore')),
  title        TEXT NOT NULL,
  description  TEXT,
  lane         TEXT NOT NULL DEFAULT 'Defined' CHECK (lane IN ('Defined','Researching','Planned','In Progress','In Review','Done','Cancelled')),
  -- typeof, not just the range: SQLite's flexible typing stores 2.5 in an
  -- INTEGER column, and BETWEEN accepts it. The row then throws from
  -- narrowPriority the next time anything reads it, which is a corrupt store
  -- rather than a rejected write.
  priority     INTEGER NOT NULL DEFAULT 2
               CHECK (typeof(priority) = 'integer'
                      AND priority BETWEEN 0 AND 4),
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
  CHECK (lane NOT IN ('Done','Cancelled') OR closed_at IS NOT NULL)
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
         WHERE d.task_id = t.id AND b.lane NOT IN ('Done','Cancelled')
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
