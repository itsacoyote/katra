import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate, readSchemaVersion } from "../../src/core/db/migrate.js";
import { migration0001 } from "../../src/core/db/migrations/0001-init.js";
import {
  buildClaimsAndPresenceDdl,
  buildEventsDdl,
  buildInitDdl,
  DEFAULT_EVENT_SETS,
  DEFAULT_SCHEMA_SETS,
  MIGRATIONS,
} from "../../src/core/db/migrations/index.js";
import { EVENT_TYPES, LANES, NOTE_KINDS } from "../../src/core/enums.js";
import { rowToEvent } from "../../src/core/events/repo.js";
import { generateId, NOTE_ID_PREFIX } from "../../src/core/id-format.js";

type DB = Database.Database;

const TS = "2026-08-03T00:00:00.000Z";

function freshDb(ddl: string = buildInitDdl()): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(ddl);
  return db;
}

/** Inserts a row with raw SQL, deliberately bypassing any application validation. */
function rawInsert(db: DB, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO tasks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
    ...Object.values(row),
  );
}

function baseTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "kt-aaaaaa",
    level: "task",
    kind: "feat",
    title: "a task",
    lane: "Defined",
    priority: 2,
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

/**
 * Inserts a row with raw SQL, bypassing application validation like
 * {@link rawInsert} does for tasks.
 *
 * Version-agnostic — the column set is identical before and after 0003's
 * rebuild bar the CHECK it widens and the nullable `prior_actor` it adds —
 * so both the 0002 and 0003 describe blocks share this one copy.
 */
function event(db: DB, row: Record<string, unknown>): void {
  const full = {
    type: "created",
    entity_id: "kt-aaaaaa",
    actor: "main @ /repo",
    created_at: TS,
    ...row,
  };
  const cols = Object.keys(full);
  db.prepare(
    `INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...Object.values(full));
}

describe("initial schema", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it("creates every table, view and index the model needs", () => {
    const names = db
      .prepare("SELECT type, name FROM sqlite_master ORDER BY type, name")
      .all() as Array<{ type: string; name: string }>;
    const byType = (type: string) => names.filter((n) => n.type === type).map((n) => n.name);

    expect(byType("table")).toEqual(["deps", "links", "tags", "tasks"]);
    expect(byType("view")).toEqual(["task_readiness"]);
    expect(byType("trigger")).toEqual([
      "tasks_epic_demotion_guard",
      "tasks_parent_must_be_epic_insert",
      "tasks_parent_must_be_epic_update",
    ]);
  });

  it("is the migration the runner ships as version 1", () => {
    expect(MIGRATIONS[0]?.version).toBe(1);
    expect(MIGRATIONS[0]?.name).toBe("init");
    // Ordered, and every version distinct: `migrate` filters and sorts by
    // version, so a duplicate or a gap would silently skip a step.
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it("matches the committed schema byte for byte", () => {
    // Migration 1 is rendered from the enum arrays at import time, so a store
    // created BEFORE an enum changes keeps its old CHECK forever — forward-only
    // migration never re-runs step 1. Comparing the builder to itself could
    // never catch that. This golden file turns any enum edit red, forcing a
    // conscious choice: update the snapshot for a pre-release change, or add
    // migration 0002 to rebuild the affected constraint.
    const golden = readFileSync(
      fileURLToPath(new URL("../fixtures/schema-v1.sql", import.meta.url)),
      "utf8",
    );
    expect(MIGRATIONS[0]?.sql).toBe(golden);
  });
});

// Acceptance criterion 33: every constrained field is rejected by the database
// itself, not merely by application code. Each of these writes raw SQL that
// bypasses validation entirely — one field tested is not four.
describe("database-level rejection of every constrained field", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it("rejects an id that does not match the generated format", () => {
    // The cycle walk's path guard uses instr, which is only exact while no id
    // can be a substring of another — true only if every id has the same
    // length and alphabet. That invariant lived in a comment. Verified: with
    // the ids `kt-aaaaaa` and `a` in one store, addDependency accepts an edge
    // that closes a real loop and nothing ever reports it.
    for (const id of ["a", "kt-abc", "kt-aaaaaaa", "kt-AAAAAA", "kt-aaaa_a", "task-123456"]) {
      expect(() => rawInsert(db, baseTask({ id })), `${id} should be rejected`).toThrowError(
        /CHECK constraint failed/,
      );
    }
  });

  it("accepts an id the generator could actually produce", () => {
    // The guard on the guard: a pattern that rejected everything would satisfy
    // the test above without katra being able to write a row at all.
    expect(() => rawInsert(db, baseTask({ id: generateId() }))).not.toThrow();
  });

  it("rejects an insert whose level is outside the allowed set", () => {
    expect(() => rawInsert(db, baseTask({ level: "story" }))).toThrowError(
      /CHECK constraint failed/,
    );
  });

  it("rejects an insert whose kind is outside the allowed set", () => {
    expect(() => rawInsert(db, baseTask({ kind: "style" }))).toThrowError(
      /CHECK constraint failed/,
    );
  });

  it("rejects an insert whose lane is outside the allowed set", () => {
    expect(() => rawInsert(db, baseTask({ lane: "Ready" }))).toThrowError(
      /CHECK constraint failed/,
    );
  });

  it("rejects an insert whose priority is outside the allowed range", () => {
    expect(() => rawInsert(db, baseTask({ priority: 5 }))).toThrowError(/CHECK constraint failed/);
    expect(() => rawInsert(db, baseTask({ id: "kt-bbbbbb", priority: -1 }))).toThrowError(
      /CHECK constraint failed/,
    );
  });

  it("rejects a priority that is in range but not an integer", () => {
    // SQLite's typing is flexible: without `typeof(priority) = 'integer'` an
    // INTEGER column stores 2.5 happily and `BETWEEN 0 AND 4` accepts it. The
    // row is then rejected by narrowPriority on every subsequent read — a
    // store that is already corrupt rather than a write that was refused.
    expect(() => rawInsert(db, baseTask({ priority: 2.5 }))).toThrowError(
      /CHECK constraint failed/,
    );
    expect(() => rawInsert(db, baseTask({ id: "kt-cccccc", priority: 0.5 }))).toThrowError(
      /CHECK constraint failed/,
    );

    // A numeric string is a different case and must still be accepted:
    // INTEGER affinity converts "2" to the integer 2 losslessly, so the stored
    // value is exactly what a caller passing 2 would have written.
    expect(() => rawInsert(db, baseTask({ id: "kt-dddddd", priority: "2" }))).not.toThrow();
  });
});

describe("hierarchy rules", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    rawInsert(db, baseTask({ id: "kt-epic01", level: "epic", title: "an epic" }));
  });

  it("accepts a task parented to an epic", () => {
    expect(() =>
      rawInsert(db, baseTask({ id: "kt-task01", parent_id: "kt-epic01" })),
    ).not.toThrow();
  });

  it("rejects a task whose parent_id references a task rather than an epic", () => {
    rawInsert(db, baseTask({ id: "kt-task01", parent_id: "kt-epic01" }));
    expect(() => rawInsert(db, baseTask({ id: "kt-task02", parent_id: "kt-task01" }))).toThrowError(
      /must reference an epic/,
    );
  });

  it("rejects a task whose parent_id references a row that does not exist", () => {
    expect(() => rawInsert(db, baseTask({ id: "kt-task01", parent_id: "kt-ghost0" }))).toThrowError(
      /must reference an epic/,
    );
  });

  it("rejects reparenting an existing task onto a non-epic", () => {
    rawInsert(db, baseTask({ id: "kt-task01", parent_id: "kt-epic01" }));
    rawInsert(db, baseTask({ id: "kt-task02", parent_id: "kt-epic01" }));

    expect(() =>
      db.prepare("UPDATE tasks SET parent_id = 'kt-task01' WHERE id = 'kt-task02'").run(),
    ).toThrowError(/must reference an epic/);
  });

  it("rejects an epic that is given a parent", () => {
    expect(() =>
      rawInsert(db, baseTask({ id: "kt-epic02", level: "epic", parent_id: "kt-epic01" })),
    ).toThrowError(/CHECK constraint failed/);
  });

  it("rejects a task that is its own parent", () => {
    // On INSERT this aborts in the epic trigger first: the row does not exist
    // yet, so the subquery is NULL and NULL IS NOT 'epic' is true. Reaching the
    // self-parent CHECK at all requires an UPDATE on an existing epic.
    expect(() =>
      db.prepare("UPDATE tasks SET parent_id = id WHERE id = 'kt-epic01'").run(),
    ).toThrowError(/parent_id IS NULL OR parent_id <> id/);
  });

  it("refuses to demote an epic that still has children", () => {
    // Both parent triggers fire only on parent_id writes, and RESTRICT only
    // covers deletes — so without its own guard a level change would strand
    // every child pointing at a row that is no longer an epic.
    rawInsert(db, baseTask({ id: "kt-task01", parent_id: "kt-epic01" }));

    expect(() =>
      db.prepare("UPDATE tasks SET level='task' WHERE id='kt-epic01'").run(),
    ).toThrowError(/cannot demote an epic/);
  });

  it("allows demoting an epic once it has no children", () => {
    expect(() =>
      db.prepare("UPDATE tasks SET level='task' WHERE id='kt-epic01'").run(),
    ).not.toThrow();
  });

  it("refuses to delete an epic that still has children", () => {
    rawInsert(db, baseTask({ id: "kt-task01", parent_id: "kt-epic01" }));

    // RESTRICT surfaces as SQLITE_CONSTRAINT_TRIGGER, not
    // SQLITE_CONSTRAINT_FOREIGNKEY, because SQLite implements foreign-key
    // actions through an internal trigger mechanism.
    expect(() => db.prepare("DELETE FROM tasks WHERE id = 'kt-epic01'").run()).toThrow();
    expect(db.prepare("SELECT parent_id FROM tasks WHERE id = 'kt-task01'").get()).toEqual({
      parent_id: "kt-epic01",
    });
  });

  it("deletes an epic once its children are gone", () => {
    rawInsert(db, baseTask({ id: "kt-task01", parent_id: "kt-epic01" }));
    db.prepare("DELETE FROM tasks WHERE id = 'kt-task01'").run();

    expect(() => db.prepare("DELETE FROM tasks WHERE id = 'kt-epic01'").run()).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) c FROM tasks").get()).toEqual({ c: 0 });
  });
});

describe("terminal lanes always carry closed_at", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it("accepts a terminal lane with closed_at set", () => {
    expect(() => rawInsert(db, baseTask({ lane: "Done", closed_at: TS }))).not.toThrow();
  });

  it("rejects Done without closed_at even via raw SQL", () => {
    // The seed helper is a deliberate validation bypass, so this invariant has
    // to hold at the database layer or it does not hold at all.
    expect(() => rawInsert(db, baseTask({ lane: "Done" }))).toThrowError(/CHECK constraint failed/);
  });

  it("rejects Cancelled without closed_at even via raw SQL", () => {
    expect(() => rawInsert(db, baseTask({ lane: "Cancelled" }))).toThrowError(
      /CHECK constraint failed/,
    );
  });

  it("accepts a non-terminal lane with no closed_at", () => {
    expect(() => rawInsert(db, baseTask({ lane: "In Progress" }))).not.toThrow();
  });

  it("rejects an UPDATE that moves a task to Done without closed_at", () => {
    // This is the path requirement 51 exists to block — `update --lane Done`
    // slipping past close/cancel. The INSERT cases alone would not pin it.
    rawInsert(db, baseTask({ id: "kt-upd001" }));
    expect(() =>
      db.prepare("UPDATE tasks SET lane='Done' WHERE id='kt-upd001'").run(),
    ).toThrowError(/CHECK constraint failed/);
  });

  it("rejects clearing closed_at while the lane is still terminal", () => {
    rawInsert(db, baseTask({ id: "kt-upd002", lane: "Done", closed_at: TS }));
    expect(() =>
      db.prepare("UPDATE tasks SET closed_at=NULL WHERE id='kt-upd002'").run(),
    ).toThrowError(/CHECK constraint failed/);
  });

  it("rejects promoting a parented task to an epic", () => {
    rawInsert(db, baseTask({ id: "kt-epic01", level: "epic", closed_at: null }));
    rawInsert(db, baseTask({ id: "kt-child1", parent_id: "kt-epic01" }));
    expect(() =>
      db.prepare("UPDATE tasks SET level='epic' WHERE id='kt-child1'").run(),
    ).toThrowError(/CHECK constraint failed/);
  });
});

describe("cascade behaviour", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    rawInsert(db, baseTask({ id: "kt-aaa001" }));
    rawInsert(db, baseTask({ id: "kt-bbb002" }));
    db.prepare("INSERT INTO deps VALUES ('kt-aaa001','kt-bbb002',?)").run(TS);
    db.prepare("INSERT INTO links VALUES ('kt-aaa001','kt-bbb002',?)").run(TS);
    db.prepare("INSERT INTO tags VALUES ('kt-aaa001','urgent')").run();
  });

  it("removes a task's dependency, link and tag rows when it is deleted", () => {
    db.prepare("DELETE FROM tasks WHERE id = 'kt-aaa001'").run();

    expect(db.prepare("SELECT COUNT(*) c FROM deps").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM links").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM tags").get()).toEqual({ c: 0 });
  });

  it("rejects a self-dependency", () => {
    expect(() =>
      db.prepare("INSERT INTO deps VALUES ('kt-bbb002','kt-bbb002',?)").run(TS),
    ).toThrowError(/CHECK constraint failed/);
  });

  it("rejects a link stored in non-canonical order", () => {
    expect(() =>
      db.prepare("INSERT INTO links VALUES ('kt-zzz999','kt-aaa001',?)").run(TS),
    ).toThrow();
  });
});

describe("task_readiness view", () => {
  let db: DB;
  const readiness = (id: string): number =>
    (
      db.prepare("SELECT is_ready FROM task_readiness WHERE id = ?").get(id) as {
        is_ready: number;
      }
    ).is_ready;

  beforeEach(() => {
    db = freshDb();
    rawInsert(db, baseTask({ id: "kt-block1" }));
    rawInsert(db, baseTask({ id: "kt-waits1" }));
    db.prepare("INSERT INTO deps VALUES ('kt-waits1','kt-block1',?)").run(TS);
  });

  it("reports a task with no dependencies as ready", () => {
    expect(readiness("kt-block1")).toBe(1);
  });

  it("reports a task blocked by a non-terminal dependency as not ready", () => {
    expect(readiness("kt-waits1")).toBe(0);
  });

  it("reports the task as ready once its blocker reaches Done", () => {
    db.prepare("UPDATE tasks SET lane='Done', closed_at=? WHERE id='kt-block1'").run(TS);
    expect(readiness("kt-waits1")).toBe(1);
  });

  it("reports the task as ready once its blocker is Cancelled", () => {
    // ADR-003: abandoning a blocker must release what it was blocking, or
    // dropping an approach strands every task behind it forever.
    db.prepare("UPDATE tasks SET lane='Cancelled', closed_at=? WHERE id='kt-block1'").run(TS);
    expect(readiness("kt-waits1")).toBe(1);
  });

  it("keeps the task blocked while its blocker is merely in review", () => {
    db.prepare("UPDATE tasks SET lane='In Review' WHERE id='kt-block1'").run();
    expect(readiness("kt-waits1")).toBe(0);
  });
});

describe("the DDL is generated, not copied", () => {
  it("builds a constraint from an injected value no hardcoded list could contain", () => {
    // Acceptance criterion 34. Asserting the DDL merely *contains* the rendered
    // enum output would pass against a hardcoded literal, since the two render
    // identically — only a value invented at call time can distinguish them.
    const ddl = buildInitDdl({
      ...DEFAULT_SCHEMA_SETS,
      lanes: [...LANES, "Sentinel"],
    });

    expect(ddl).toContain("'Sentinel'");

    const db = freshDb(ddl);
    expect(() => rawInsert(db, baseTask({ lane: "Sentinel" }))).not.toThrow();
    db.close();
  });

  it("derives the priority bounds and default from the declared set", () => {
    const ddl = buildInitDdl({
      ...DEFAULT_SCHEMA_SETS,
      priorityMin: 7,
      priorityMax: 9,
      priorityDefault: 8,
    });

    expect(ddl).toContain("BETWEEN 7 AND 9");
    expect(ddl).toContain("DEFAULT 8");
  });
});

describe("buildInitDdl's own inputs", () => {
  it("refuses a non-integer priority bound rather than interpolating it", () => {
    // sqlEnum escapes the string sets; the numbers have no such escape and go
    // straight into the DDL. Unreachable with DEFAULT_SCHEMA_SETS — but `sets`
    // is a parameter precisely so callers can pass their own, which is the
    // trap sqlEnum's own comment warns about for the next person.
    for (const bad of [
      { priorityMin: 1.5 },
      { priorityMax: Number.NaN },
      { priorityDefault: "2 OR 1=1" as unknown as number },
    ]) {
      expect(() => buildInitDdl({ ...DEFAULT_SCHEMA_SETS, ...bad })).toThrowError(
        /must be an integer/,
      );
    }
  });
});

describe("migration 0002 — events and notes", () => {
  /** A store at exactly v1, as an existing installation would have. */
  function v1Store(): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migration0001.sql);
    db.pragma("user_version = 1");
    return db;
  }

  function freshV2(): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // Scoped to steps 1-2 deliberately, same trap as the two inline call sites
    // below: MIGRATIONS now carries migration 0003, and the unscoped call
    // silently built a v3 store here — every test in this block using
    // freshV2() was measuring 0003's rebuild, not 0002's own DDL.
    migrate(db, MIGRATIONS.slice(0, 2));
    return db;
  }

  const note = (db: DB, row: Record<string, unknown> = {}): void => {
    const full = {
      id: "nt-aaaaaa",
      task_id: "kt-aaaaaa",
      body: "a note",
      actor: "main @ /repo",
      created_at: TS,
      ...row,
    };
    const cols = Object.keys(full);
    db.prepare(
      `INSERT INTO notes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    ).run(...Object.values(full));
  };

  it("matches the committed v2 schema byte for byte", () => {
    // Same reason as v1's snapshot: this DDL is rendered from the enum arrays
    // at import time, and forward-only migration never re-runs a step. A store
    // created before an enum changes keeps its old CHECK forever, so comparing
    // the builder to itself could never catch the drift.
    //
    // This fixture was regenerated when 0003 widened EVENT_TYPES with
    // claimed/released: migration 0002's DEFAULT_EVENT_SETS imports the array
    // live, so the rendered CHECK moved with it. That is safe here only
    // because 0003 immediately rebuilds `events` — a fresh install applies
    // both steps inside one transaction, so nobody ever sees the wider
    // 0002-only CHECK on its own, and both migration paths (fresh install,
    // v2-store upgrade) converge on the same final constraint. Widening
    // EVENT_TYPES again *without* a matching rebuild migration would leave
    // two stores at the same user_version with different CHECKs — the trap
    // for whoever adds F5's ref-linked/ref-status-changed next.
    const golden = readFileSync(
      fileURLToPath(new URL("../fixtures/schema-v2.sql", import.meta.url)),
      "utf8",
    );
    expect(MIGRATIONS[1]?.sql).toBe(golden);
    expect(MIGRATIONS[1]?.version).toBe(2);
  });

  it("leaves migration 1's golden fixture untouched", () => {
    // Adding a step must not edit an earlier one — an installed store already
    // ran step 1 and will never run it again.
    const golden = readFileSync(
      fileURLToPath(new URL("../fixtures/schema-v1.sql", import.meta.url)),
      "utf8",
    );
    expect(MIGRATIONS[0]?.sql).toBe(golden);
  });

  it("migrates a v1 store to v2 without touching its tasks", () => {
    const db = v1Store();
    rawInsert(db, baseTask({ title: "survives the migration" }));

    expect(readSchemaVersion(db)).toBe(1);
    // Scoped to steps 1-2 deliberately: migration 0003's own v2->v3 path has
    // its own describe block below, and running the full MIGRATIONS list here
    // would carry this store past v2 without this test saying so.
    expect(migrate(db, MIGRATIONS.slice(0, 2))).toBe(1);
    expect(readSchemaVersion(db)).toBe(2);

    expect(db.prepare("SELECT title FROM tasks WHERE id='kt-aaaaaa'").get()).toEqual({
      title: "survives the migration",
    });
    db.close();
  });

  it("brings a fresh store straight to version 2", () => {
    const db = new Database(":memory:");
    expect(readSchemaVersion(db)).toBe(0);
    expect(migrate(db, MIGRATIONS.slice(0, 2))).toBe(2);
    expect(readSchemaVersion(db)).toBe(2);

    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toEqual(["deps", "events", "links", "notes", "tags", "tasks"]);
    db.close();
  });

  it("creates the indexes the entity and epic reads depend on", () => {
    // Nothing prunes events, and the session digest reads them on every start.
    // Unindexed, log degrades to a full scan as history accumulates.
    const db = freshV2();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%event%'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(indexes.sort()).toEqual(["events_entity", "events_epic"]);

    for (const [column, index] of [
      ["entity_id", "events_entity"],
      ["epic_id", "events_epic"],
    ] as const) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT * FROM events WHERE ${column} = ?`)
        .all("kt-aaaaaa") as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" ")).toContain(index);
    }
    db.close();
  });

  it("builds the event-type constraint from the array, not a literal", () => {
    // Asserting the DDL contains the rendered enum would pass against a
    // hardcoded list, since the two render identically. Only a value invented
    // at call time can distinguish them.
    const ddl = buildEventsDdl({
      ...DEFAULT_EVENT_SETS,
      eventTypes: [...EVENT_TYPES, "sentinel-event"],
    });
    expect(ddl).toContain("'sentinel-event'");

    const db = new Database(":memory:");
    db.exec(migration0001.sql);
    db.exec(ddl);
    expect(() => event(db, { type: "sentinel-event" })).not.toThrow();
    db.close();
  });

  it("builds the note-kind constraint from the array, not a literal", () => {
    const ddl = buildEventsDdl({
      ...DEFAULT_EVENT_SETS,
      noteKinds: [...NOTE_KINDS, "sentinel-kind"],
    });
    expect(ddl).toContain("'sentinel-kind'");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migration0001.sql);
    db.exec(ddl);
    rawInsert(db, baseTask());
    expect(() => note(db, { kind: "sentinel-kind" })).not.toThrow();
    db.close();
  });

  it("rejects an event type outside the generated set", () => {
    const db = freshV2();
    expect(() => event(db, { type: "updated" })).toThrowError(/CHECK constraint failed/);
    db.close();
  });

  it("accepts an event whose epic_id is null", () => {
    // A top-level task has no epic, and an epic's own events have none either
    // since an epic never has a parent. NOT NULL here — the consistent-looking
    // mirror of entity_id — would reject every event for a task created
    // without --parent.
    const db = freshV2();
    expect(() => event(db, { epic_id: null })).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 1 });
    db.close();
  });

  it("accepts an event for a task that does not exist", () => {
    // ADR-008: entity_id is a historical reference, not a foreign key. A
    // helpfully-added REFERENCES clause would make this throw.
    const db = freshV2();
    expect(() => event(db, { entity_id: "kt-zzzzzz", type: "deleted" })).not.toThrow();
    db.close();
  });

  it("keeps a task's events when the task is deleted", () => {
    const db = freshV2();
    rawInsert(db, baseTask());
    event(db, { entity_id: "kt-aaaaaa" });

    db.prepare("DELETE FROM tasks WHERE id='kt-aaaaaa'").run();

    expect(db.prepare("SELECT COUNT(*) c FROM events WHERE entity_id='kt-aaaaaa'").get()).toEqual({
      c: 1,
    });
    db.close();
  });

  it("removes a task's notes when the task is deleted", () => {
    // The opposite case, and deliberately so: history survives, content does
    // not. A note without its task is unreachable and unreadable.
    const db = freshV2();
    rawInsert(db, baseTask());
    note(db);

    db.prepare("DELETE FROM tasks WHERE id='kt-aaaaaa'").run();

    expect(db.prepare("SELECT COUNT(*) c FROM notes").get()).toEqual({ c: 0 });
    db.close();
  });

  it("refuses a note on a task that does not exist", () => {
    const db = freshV2();
    expect(() => note(db, { task_id: "kt-zzzzzz" })).toThrowError(/FOREIGN KEY constraint failed/);
    db.close();
  });

  it("rejects a note id that does not match the generated nt- pattern", () => {
    const db = freshV2();
    rawInsert(db, baseTask());

    for (const bad of ["kt-aaaaaa", "nt-aaaaa", "nt-aaaaaaa", "nt-AAAAAA", "nt-aaa_aa", "aaaaaa"]) {
      expect(() => note(db, { id: bad }), bad).toThrowError(/CHECK constraint failed/);
    }
    expect(() => note(db, { id: generateId(NOTE_ID_PREFIX) })).not.toThrow();
    db.close();
  });

  it("rejects an empty note body at the database level", () => {
    // NOT NULL alone accepts the empty string, and the body IS the note. The
    // application refuses this too; this is the guarantee under raw SQL.
    const db = freshV2();
    rawInsert(db, baseTask());

    expect(() => note(db, { body: "" })).toThrowError(/CHECK constraint failed/);
    db.close();
  });

  it("defaults a note's kind to general", () => {
    const db = freshV2();
    rawInsert(db, baseTask());
    db.prepare("INSERT INTO notes (id,task_id,body,actor,created_at) VALUES (?,?,?,?,?)").run(
      "nt-aaaaaa",
      "kt-aaaaaa",
      "a note",
      "main @ /repo",
      TS,
    );

    expect(db.prepare("SELECT kind FROM notes").get()).toEqual({ kind: "general" });
    db.close();
  });
});

describe("buildEventsDdl's own inputs", () => {
  it("refuses a default note kind outside the constraint it generates", () => {
    // The kinds go through sqlEnum; the default is interpolated raw into a
    // DEFAULT clause. A default outside the CHECK makes every insert that
    // omits a kind fail — at runtime, in a shipped store.
    expect(() =>
      buildEventsDdl({ ...DEFAULT_EVENT_SETS, noteKindDefault: "summary" }),
    ).toThrowError(/noteKindDefault must be one of/);
  });

  it("refuses a note id prefix that is not a bare lowercase prefix", () => {
    for (const bad of ["nt", "NT-", "nt-'", "n1-", ""]) {
      expect(() => buildEventsDdl({ ...DEFAULT_EVENT_SETS, noteIdPrefix: bad }), bad).toThrowError(
        /noteIdPrefix must be/,
      );
    }
  });
});

describe("migration 0003 — claims and presence", () => {
  /** A store at exactly v2, as an installation before this feature would have. */
  function v2Store(): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, MIGRATIONS.slice(0, 2));
    return db;
  }

  function freshV3(): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, MIGRATIONS);
    return db;
  }

  it("matches the pinned v3 schema fixture", () => {
    // Same reason as v1 and v2's snapshots — this DDL is rendered from
    // EVENT_TYPES at import time. The warning that matters here more than for
    // either earlier snapshot: this proves the DDL *text*, nothing about
    // whether the rebuild it describes actually preserves a store's data —
    // that is what the next three tests are for.
    const golden = readFileSync(
      fileURLToPath(new URL("../fixtures/schema-v3.sql", import.meta.url)),
      "utf8",
    );
    expect(MIGRATIONS[2]?.sql).toBe(golden);
    expect(MIGRATIONS[2]?.version).toBe(3);
  });

  it("builds the event-type constraint from the array, not a literal", () => {
    // Same reasoning as 0002's analogous test: asserting the DDL contains the
    // rendered enum would pass against a hardcoded list, since the two render
    // identically. Only a value invented at call time can distinguish them.
    const ddl = buildClaimsAndPresenceDdl({
      eventTypes: [...EVENT_TYPES, "sentinel-event"],
    });
    expect(ddl).toContain("'sentinel-event'");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, MIGRATIONS.slice(0, 2));
    db.exec(ddl);
    rawInsert(db, baseTask());
    expect(() => event(db, { type: "sentinel-event" })).not.toThrow();
    db.close();
  });

  it("upgrades a v2 store to v3 keeping tasks, events and notes", () => {
    const db = v2Store();
    rawInsert(db, baseTask({ title: "survives the rebuild" }));
    event(db, { entity_id: "kt-aaaaaa", title: "survives the rebuild" });
    db.prepare("INSERT INTO notes (id, task_id, body, actor, created_at) VALUES (?,?,?,?,?)").run(
      "nt-aaaaaa",
      "kt-aaaaaa",
      "a note",
      "main @ /repo",
      TS,
    );

    expect(readSchemaVersion(db)).toBe(2);
    expect(migrate(db, MIGRATIONS)).toBe(1);
    expect(readSchemaVersion(db)).toBe(3);

    expect(db.prepare("SELECT title FROM tasks WHERE id='kt-aaaaaa'").get()).toEqual({
      title: "survives the rebuild",
    });
    expect(db.prepare("SELECT COUNT(*) c FROM events WHERE entity_id='kt-aaaaaa'").get()).toEqual({
      c: 1,
    });
    expect(db.prepare("SELECT body FROM notes WHERE id='nt-aaaaaa'").get()).toEqual({
      body: "a note",
    });
    db.close();
  });

  it("brings a fresh store straight to version 3", () => {
    const db = new Database(":memory:");
    expect(readSchemaVersion(db)).toBe(0);
    expect(migrate(db, MIGRATIONS)).toBe(3);
    expect(readSchemaVersion(db)).toBe(3);

    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toEqual([
      "claims",
      "deps",
      "events",
      "links",
      "notes",
      "presence",
      "tags",
      "tasks",
    ]);
    db.close();
  });

  it("recreates both events indexes after the rebuild", () => {
    // Dropping `events` drops everything built on it. Same assertion 0002's
    // analogous test makes, pinned again here because the rebuild is a second
    // place either index could quietly fail to come back.
    const db = freshV3();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%event%'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(indexes.sort()).toEqual(["events_entity", "events_epic"]);

    for (const [column, index] of [
      ["entity_id", "events_entity"],
      ["epic_id", "events_epic"],
    ] as const) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT * FROM events WHERE ${column} = ?`)
        .all("kt-aaaaaa") as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" ")).toContain(index);
    }
    db.close();
  });

  it("preserves event ids and order across the rebuild", () => {
    // A gap in the ids is what actually distinguishes a rebuild that carries
    // literal ids from one that silently renumbers the copy: an
    // INSERT...SELECT that omitted the id column would close this gap, and
    // `listEvents`' ordering depends on the id staying a total order.
    const db = v2Store();
    rawInsert(db, baseTask());
    event(db, { entity_id: "kt-aaaaaa", type: "created" });
    event(db, { entity_id: "kt-aaaaaa", type: "status-changed" });
    event(db, { entity_id: "kt-aaaaaa", type: "closed" });
    db.prepare("DELETE FROM events WHERE id = 2").run();

    const idsOf = (): number[] =>
      (db.prepare("SELECT id FROM events ORDER BY id").all() as Array<{ id: number }>).map(
        (row) => row.id,
      );
    expect(idsOf()).toEqual([1, 3]);

    migrate(db, MIGRATIONS);

    expect(idsOf()).toEqual([1, 3]);
    db.close();
  });

  it("accepts claimed and released and still refuses an unknown type", () => {
    const db = freshV3();
    rawInsert(db, baseTask());

    expect(() => event(db, { type: "claimed" })).not.toThrow();
    expect(() => event(db, { type: "released" })).not.toThrow();
    expect(() => event(db, { type: "updated" })).toThrowError(/CHECK constraint failed/);
    db.close();
  });

  it("carries prior_actor through a round trip and defaults it null", () => {
    const db = freshV3();
    rawInsert(db, baseTask());
    event(db, { type: "released" });
    event(db, { type: "released", prior_actor: "feature/x @ /repo/wt-x" });

    const rows = db.prepare("SELECT * FROM events ORDER BY id").all();
    expect(rows.map((row) => rowToEvent(row as never).priorActor)).toEqual([
      null,
      "feature/x @ /repo/wt-x",
    ]);
    db.close();
  });

  const claim = (db: DB, row: Record<string, unknown> = {}): void => {
    const full = {
      task_id: "kt-aaaaaa",
      holder: "/repo/wt-a",
      actor: "main @ /repo/wt-a",
      claimed_at: TS,
      ...row,
    };
    const cols = Object.keys(full);
    db.prepare(
      `INSERT INTO claims (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    ).run(...Object.values(full));
  };

  it("refuses a second claim on the same task", () => {
    // T4's compare-and-set design rests on this: `task_id PRIMARY KEY` is what
    // makes "at most one claim per task" a schema guarantee rather than an
    // application check a race could slip past.
    const db = freshV3();
    rawInsert(db, baseTask());
    claim(db);

    expect(() => claim(db, { holder: "/repo/wt-b", actor: "main @ /repo/wt-b" })).toThrowError(
      /UNIQUE constraint failed/,
    );
    db.close();
  });

  it("releases a claim when its task is deleted", () => {
    const db = freshV3();
    rawInsert(db, baseTask());
    claim(db);

    db.prepare("DELETE FROM tasks WHERE id = 'kt-aaaaaa'").run();

    expect(db.prepare("SELECT COUNT(*) c FROM claims").get()).toEqual({ c: 0 });
    db.close();
  });

  it("refuses a claim on a task that does not exist", () => {
    const db = freshV3();

    expect(() => claim(db, { task_id: "kt-zzzzzz" })).toThrowError(/FOREIGN KEY constraint failed/);
    db.close();
  });

  it("keeps one presence row per worktree", () => {
    // Requirement 2's UPSERT cadence (ADR-011): every command bumps this row
    // rather than inserting a new one, so `worktree PRIMARY KEY` has to be a
    // real conflict target, not decoration.
    const db = freshV3();
    const upsert = (branch: string, lastSeen: string): void => {
      db.prepare(
        `INSERT INTO presence (worktree, branch, last_seen) VALUES (?,?,?)
         ON CONFLICT(worktree) DO UPDATE SET branch = excluded.branch, last_seen = excluded.last_seen`,
      ).run("/repo/wt-a", branch, lastSeen);
    };

    upsert("main", "2026-01-01T00:00:00.000Z");
    upsert("feature/x", "2026-01-01T00:05:00.000Z");

    expect(db.prepare("SELECT * FROM presence").all()).toEqual([
      { worktree: "/repo/wt-a", branch: "feature/x", last_seen: "2026-01-01T00:05:00.000Z" },
    ]);
    db.close();
  });
});
