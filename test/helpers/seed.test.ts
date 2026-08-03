import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetSeedIds,
  seedDep,
  seedEpic,
  seedLink,
  seedMany,
  seedTag,
  seedTask,
  seedTime,
} from "./seed.js";
import type { StoreFixture } from "./store.js";
import { createStoreFixture } from "./store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
  resetSeedIds();
});
afterEach(() => fixture.cleanup());

const count = (table: string): number =>
  (fixture.store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

describe("store fixture", () => {
  it("hands back a migrated store in a real repository", () => {
    expect(fixture.store.db.open).toBe(true);
    expect(count("tasks")).toBe(0);
    expect(fixture.store.dbPath.startsWith(fixture.repo.dir)).toBe(true);
  });
});

describe("seedTask", () => {
  it("inserts a task with workable defaults and returns its id", () => {
    const id = seedTask(fixture.store);

    const row = fixture.store.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    expect(row).toMatchObject({ level: "task", kind: "feat", lane: "Defined", priority: 2 });
  });

  it("supplies closed_at automatically for a terminal lane", () => {
    // The schema requires it; making every caller remember would turn an
    // invariant into a chore.
    const done = seedTask(fixture.store, { lane: "Done" });
    const cancelled = seedTask(fixture.store, { lane: "Cancelled" });

    const rows = fixture.store.db
      .prepare("SELECT id, closed_at FROM tasks WHERE id IN (?,?) ORDER BY id")
      .all(done, cancelled) as Array<{ closed_at: string | null }>;
    expect(rows.every((r) => r.closed_at !== null)).toBe(true);
  });

  it("still fails the schema when a terminal lane is explicitly given no closed_at", () => {
    // The bypass must not become a loophole: this is a deliberate raw write,
    // and the database is the last line of defence for the invariant.
    expect(() => seedTask(fixture.store, { lane: "Done", closedAt: null })).toThrowError(
      /CHECK constraint failed/,
    );
  });

  it("refuses to seed a row the model forbids", () => {
    const task = seedTask(fixture.store);
    expect(() => seedTask(fixture.store, { parentId: task })).toThrowError(
      /must reference an epic/,
    );
  });

  it("parents a task to a seeded epic", () => {
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const task = seedTask(fixture.store, { parentId: epic });

    expect(fixture.store.db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(task)).toEqual({
      parent_id: epic,
    });
  });

  it("attaches tags given inline", () => {
    const id = seedTask(fixture.store, { tags: ["urgent", "backend"] });

    const tags = fixture.store.db
      .prepare("SELECT tag FROM tags WHERE task_id=? ORDER BY tag")
      .all(id)
      .map((r) => (r as { tag: string }).tag);
    expect(tags).toEqual(["backend", "urgent"]);
  });

  it("produces ids that do not collide", () => {
    const ids = new Set([
      seedTask(fixture.store),
      seedTask(fixture.store),
      seedTask(fixture.store),
    ]);
    expect(ids.size).toBe(3);
  });
});

describe("seed relationships", () => {
  it("records a dependency", () => {
    const blocker = seedTask(fixture.store);
    const blocked = seedTask(fixture.store);
    seedDep(fixture.store, blocked, blocker);

    const ready = fixture.store.db
      .prepare("SELECT is_ready FROM task_readiness WHERE id=?")
      .get(blocked);
    expect(ready).toEqual({ is_ready: 0 });
  });

  it("stores a link in canonical order regardless of the order given", () => {
    // links enforces a_id < b_id, so an unsorted insert would fail about half
    // the time — a confusing way for an unrelated test to break.
    const first = seedTask(fixture.store, { id: "kt-zzzzzz" });
    const second = seedTask(fixture.store, { id: "kt-aaaaaa" });

    seedLink(fixture.store, first, second);

    expect(fixture.store.db.prepare("SELECT a_id, b_id FROM links").get()).toEqual({
      a_id: "kt-aaaaaa",
      b_id: "kt-zzzzzz",
    });
  });

  it("tags an existing task", () => {
    const id = seedTask(fixture.store);
    seedTag(fixture.store, id, "later");
    expect(count("tags")).toBe(1);
  });
});

describe("seedMany", () => {
  it("inserts many tasks with distinct, ordered timestamps", () => {
    // T6 needs two thousand rows before createTask exists.
    const ids = seedMany(fixture.store, 500);

    expect(new Set(ids).size).toBe(500);
    expect(count("tasks")).toBe(500);

    const stamps = fixture.store.db
      .prepare("SELECT created_at FROM tasks ORDER BY created_at")
      .all()
      .map((r) => (r as { created_at: string }).created_at);
    expect(stamps[0]).toBe(seedTime(0));
    expect(new Set(stamps).size).toBe(500);
  });
});
