import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildInitDdl,
  DEFAULT_SCHEMA_SETS,
  MIGRATIONS,
} from "../../src/core/db/migrations/index.js";
import { LANES } from "../../src/core/enums.js";

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
    expect(MIGRATIONS).toHaveLength(1);
    expect(MIGRATIONS[0]?.version).toBe(1);
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
    expect(() => rawInsert(db, baseTask({ id: "kt-task01", parent_id: "kt-ghost" }))).toThrowError(
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
    rawInsert(db, baseTask({ id: "kt-epicX", level: "epic", closed_at: null }));
    rawInsert(db, baseTask({ id: "kt-child1", parent_id: "kt-epicX" }));
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
