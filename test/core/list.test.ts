import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDependency } from "../../src/core/graph/deps.js";
import { listTasks } from "../../src/core/tasks/repo.js";
import { seedDep, seedEpic, seedTask, seedTime } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

const titles = (result: { tasks: readonly { title: string }[] }): string[] =>
  result.tasks.map((task) => task.title);

describe("listTasks", () => {
  it("returns every task when no filter is given", () => {
    seedTask(fixture.store, { title: "one" });
    seedTask(fixture.store, { title: "two" });

    expect(titles(listTasks(fixture.store))).toHaveLength(2);
  });

  it("says nothing matched rather than erroring on an empty store", () => {
    expect(listTasks(fixture.store).tasks).toEqual([]);
  });

  it("filters by lane, kind, level, assignee and priority", () => {
    seedTask(fixture.store, {
      title: "wanted",
      lane: "Planned",
      kind: "fix",
      priority: 0,
      assignee: "ada",
    });
    seedTask(fixture.store, {
      title: "wrong lane",
      lane: "Defined",
      kind: "fix",
      priority: 0,
      assignee: "ada",
    });
    seedTask(fixture.store, {
      title: "wrong kind",
      lane: "Planned",
      kind: "feat",
      priority: 0,
      assignee: "ada",
    });
    seedEpic(fixture.store, { title: "an epic", lane: "Planned", priority: 0 });

    expect(titles(listTasks(fixture.store, { lane: "Planned", kind: "fix" }))).toEqual(["wanted"]);
    expect(titles(listTasks(fixture.store, { level: "epic" }))).toEqual(["an epic"]);
    expect(titles(listTasks(fixture.store, { assignee: "ada", lane: "Defined" }))).toEqual([
      "wrong lane",
    ]);
    expect(titles(listTasks(fixture.store, { priority: 0 }))).toHaveLength(4);
  });

  it("combines several filters with AND", () => {
    seedTask(fixture.store, { title: "both", lane: "Planned", kind: "fix" });
    seedTask(fixture.store, { title: "one", lane: "Planned", kind: "feat" });

    expect(titles(listTasks(fixture.store, { lane: "Planned", kind: "fix" }))).toEqual(["both"]);
  });

  it("returns only children of the requested epic", () => {
    const epic = seedEpic(fixture.store, { title: "the epic" });
    seedTask(fixture.store, { title: "child", parentId: epic });
    seedTask(fixture.store, { title: "unrelated" });

    expect(titles(listTasks(fixture.store, { epic }))).toEqual(["child"]);
  });

  it("filters by tag", () => {
    seedTask(fixture.store, { title: "tagged", tags: ["urgent"] });
    seedTask(fixture.store, { title: "other", tags: ["later"] });
    seedTask(fixture.store, { title: "untagged" });

    expect(titles(listTasks(fixture.store, { tag: "urgent" }))).toEqual(["tagged"]);
  });

  it("matches an assignee exactly rather than as a pattern", () => {
    // A LIKE filter would make a value containing % match every row. Fuzzy
    // matching is F3's full-text search, not something to smuggle in here.
    seedTask(fixture.store, { title: "real", assignee: "ada" });

    expect(listTasks(fixture.store, { assignee: "%" }).tasks).toEqual([]);
    expect(listTasks(fixture.store, { assignee: "a" }).tasks).toEqual([]);
    expect(listTasks(fixture.store, { assignee: "_da" }).tasks).toEqual([]);
    expect(titles(listTasks(fixture.store, { assignee: "ada" }))).toEqual(["real"]);
  });

  it("treats a tag containing a wildcard as literal text", () => {
    seedTask(fixture.store, { title: "tagged", tags: ["urgent"] });

    expect(listTasks(fixture.store, { tag: "%" }).tasks).toEqual([]);
  });

  it("returns only ready tasks when --ready is given", () => {
    const blocker = seedTask(fixture.store, { title: "blocker" });
    const blocked = seedTask(fixture.store, { title: "blocked" });
    seedDep(fixture.store, blocked, blocker);
    seedTask(fixture.store, { title: "free" });

    expect(titles(listTasks(fixture.store, { ready: true })).sort()).toEqual(["blocker", "free"]);
  });

  it("returns only blocked tasks when --blocked is given", () => {
    const blocker = seedTask(fixture.store, { title: "blocker" });
    const blocked = seedTask(fixture.store, { title: "blocked" });
    seedDep(fixture.store, blocked, blocker);

    expect(titles(listTasks(fixture.store, { ready: false }))).toEqual(["blocked"]);
  });

  it("agrees with the dependency graph about readiness", () => {
    // list joins the same task_readiness view isReady reads, so the two cannot
    // disagree about whether a task is startable.
    const blocker = seedTask(fixture.store, { title: "blocker" });
    const blocked = seedTask(fixture.store, { title: "blocked" });
    addDependency(fixture.store, blocked, blocker);

    expect(titles(listTasks(fixture.store, { ready: false }))).toEqual(["blocked"]);

    fixture.store.db
      .prepare("UPDATE tasks SET lane='Cancelled', closed_at='2026-02-01T00:00:00.000Z' WHERE id=?")
      .run(blocker);

    // Abandoning the blocker releases the dependent, per ADR-003.
    expect(titles(listTasks(fixture.store, { ready: false }))).toEqual([]);
  });

  it("orders results by priority, then creation time", () => {
    seedTask(fixture.store, { title: "late low", priority: 4, createdAt: seedTime(2000) });
    seedTask(fixture.store, { title: "early high", priority: 0, createdAt: seedTime(1000) });
    seedTask(fixture.store, { title: "late high", priority: 0, createdAt: seedTime(3000) });

    expect(titles(listTasks(fixture.store))).toEqual(["early high", "late high", "late low"]);
  });

  it("breaks a created_at tie by rowid", () => {
    // Two rows written in the same millisecond are routine, and without the
    // rowid tiebreak their order would be arbitrary between runs.
    const stamp = seedTime(500);
    seedTask(fixture.store, { title: "first", createdAt: stamp });
    seedTask(fixture.store, { title: "second", createdAt: stamp });
    seedTask(fixture.store, { title: "third", createdAt: stamp });

    for (let run = 0; run < 5; run++) {
      expect(titles(listTasks(fixture.store))).toEqual(["first", "second", "third"]);
    }
  });

  it("honours a limit", () => {
    for (let i = 0; i < 10; i++) seedTask(fixture.store, { title: `t${i}` });

    expect(listTasks(fixture.store, { limit: 3 }).tasks).toHaveLength(3);
  });

  it("includes each task's tags", () => {
    seedTask(fixture.store, { title: "tagged", tags: ["b", "a"] });

    expect(listTasks(fixture.store).tasks[0]?.tags).toEqual(["a", "b"]);
  });
});
