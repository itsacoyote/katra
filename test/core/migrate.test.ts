import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, writeTx } from "../../src/core/db/connection.js";
import { type Migration, migrate, readSchemaVersion } from "../../src/core/db/migrate.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { createNonRepoDir } from "../helpers/fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDbPath(): string {
  const dir = createNonRepoDir();
  cleanups.push(() => dir.cleanup());
  return join(dir.dir, "katra.db");
}

const STEPS: readonly Migration[] = [
  { version: 1, name: "one", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
  { version: 2, name: "two", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY)" },
];

function tables(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

describe("migrate", () => {
  it("applies every step and records the target version on a fresh database", () => {
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());

    expect(readSchemaVersion(db)).toBe(0);
    expect(migrate(db, STEPS)).toBe(2);
    expect(readSchemaVersion(db)).toBe(2);
    expect(tables(db)).toEqual(["a", "b"]);
  });

  it("applies nothing and does not error when run a second time", () => {
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());

    migrate(db, STEPS);
    expect(migrate(db, STEPS)).toBe(0);
    expect(readSchemaVersion(db)).toBe(2);
  });

  it("applies only the steps beyond the current version", () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    cleanups.push(() => db.close());

    expect(migrate(db, STEPS.slice(0, 1))).toBe(1);
    expect(tables(db)).toEqual(["a"]);
    expect(migrate(db, STEPS)).toBe(1);
    expect(tables(db)).toEqual(["a", "b"]);
  });

  it("rolls the whole migration back when a later step fails", () => {
    // A crash mid-migration must not leave a half-built schema behind a stale
    // version, which is why every step shares one transaction.
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());
    const broken: Migration[] = [
      ...STEPS,
      { version: 3, name: "bad", sql: "CREATE TABLE c (this is not valid sql" },
    ];

    expect(() => migrate(db, broken)).toThrow();
    expect(readSchemaVersion(db)).toBe(0);
    expect(tables(db)).toEqual([]);
  });

  it("rolls back a version bump written inside a failing transaction", () => {
    // The rollback test above fails while *preparing* invalid SQL, so the
    // version write is never reached — it proves the schema rolled back, not
    // the version. This pins the version half directly.
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());

    expect(() =>
      writeTx(db, () => {
        db.pragma("user_version = 9");
        throw new Error("abort");
      }),
    ).toThrowError("abort");

    expect(readSchemaVersion(db)).toBe(0);
  });

  it("refuses a store written by a newer schema version", () => {
    // One worktree on a global install and another on a local build is enough
    // to hit this; proceeding would read and write a schema this build does
    // not understand.
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());
    db.pragma("user_version = 99");

    expect(() => migrate(db, STEPS)).toThrowError(/newer katra/);
  });

  it("leaves the version untouched when there are no migrations at all", () => {
    const db = openDatabase(tempDbPath());
    cleanups.push(() => db.close());

    expect(migrate(db, [])).toBe(0);
    expect(readSchemaVersion(db)).toBe(0);
  });

  it("applies the migration exactly once when several processes race a new store", {
    timeout: 60_000,
  }, async () => {
    // Two worktrees running their first command at the same instant. The
    // version probe is retried because a bare pragma read can raise
    // SQLITE_BUSY here before any transaction exists to absorb it.
    const path = tempDbPath();
    const modules = {
      connection: new URL("../../src/core/db/connection.ts", import.meta.url).href,
      migrate: new URL("../../src/core/db/migrate.ts", import.meta.url).href,
    };

    const outcomes = await runConcurrent<{ applied: number; version: number }>({
      count: 6,
      source: `
        const { openDatabase } = await import(${JSON.stringify(modules.connection)});
        const { migrate, readSchemaVersion } = await import(${JSON.stringify(modules.migrate)});
        barrier();
        const steps = [
          { version: 1, name: "one", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
          { version: 2, name: "two", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY)" },
        ];
        const db = openDatabase(${JSON.stringify(path)});
        const applied = migrate(db, steps);
        const version = readSchemaVersion(db);
        db.close();
        report({ applied, version });
      `,
    });

    const failures = outcomes.filter((o) => !o.ok);
    expect(failures.map((f) => f.stderr.slice(0, 300))).toEqual([]);

    const results = outcomes.map((o) => o.value).filter((v) => v !== undefined);
    expect(results).toHaveLength(6);
    // Exactly one process does the work; the rest correctly find nothing to do.
    expect(results.filter((r) => r.applied > 0)).toHaveLength(1);
    expect(results.every((r) => r.version === 2)).toBe(true);

    const db = openDatabase(path);
    cleanups.push(() => db.close());
    expect(tables(db)).toEqual(["a", "b"]);
  });
});
