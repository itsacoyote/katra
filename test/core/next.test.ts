import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDependency } from "../../src/core/graph/deps.js";
import { nextTask } from "../../src/core/tasks/next.js";
import { seedEpic, seedTask, seedTime } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

/** Seeds a planned, startable task. */
function planned(title: string, extra: Record<string, unknown> = {}): string {
  return seedTask(fixture.store, { title, lane: "Planned", ...extra });
}

describe("nextTask", () => {
  it("returns the lowest-priority-number ready task in the Planned lane", () => {
    planned("low", { priority: 4 });
    planned("high", { priority: 0 });
    planned("middle", { priority: 2 });

    const result = nextTask(fixture.store);

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.title).toBe("high");
  });

  it("breaks a priority tie by choosing the oldest task", () => {
    planned("later", { priority: 0, createdAt: seedTime(2000) });
    planned("earlier", { priority: 0, createdAt: seedTime(1000) });

    const result = nextTask(fixture.store);
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.title).toBe("earlier");
  });

  it("breaks a created_at tie by insertion order, not by id", () => {
    // Ids descend while insertion order ascends, so "insertion order" is a
    // distinct claim from "id order". With the default sequential seed ids the
    // two agreed and the assertion held either way.
    //
    // As in the matching list test, dropping `t.rowid` from the query does not
    // fail this — SQLite's only tie order is rowid. The clause makes the order
    // specified rather than incidental; the cross-command agreement test in
    // list.test.ts is the falsifiable half.
    const stamp = seedTime(500);
    planned("first", { id: "kt-zzzzzz", priority: 0, createdAt: stamp });
    planned("second", { id: "kt-aaaaaa", priority: 0, createdAt: stamp });

    for (let run = 0; run < 5; run++) {
      const result = nextTask(fixture.store);
      if (result.status !== "found") throw new Error("unreachable");
      expect(result.task.title).toBe("first");
    }
  });

  it("never returns a task outside the Planned lane", () => {
    seedTask(fixture.store, { title: "defined", lane: "Defined", priority: 0 });
    seedTask(fixture.store, { title: "in progress", lane: "In Progress", priority: 0 });
    planned("planned", { priority: 4 });

    const result = nextTask(fixture.store);
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.title).toBe("planned");
  });

  it("never returns a blocked task", () => {
    const blocker = seedTask(fixture.store, { title: "blocker" });
    const blocked = planned("blocked but urgent", { priority: 0 });
    addDependency(fixture.store, blocked, blocker);
    planned("startable", { priority: 3 });

    const result = nextTask(fixture.store);
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.title).toBe("startable");
  });

  it("returns exactly one item even when many qualify", () => {
    for (let i = 0; i < 10; i++) planned(`task ${i}`);

    const result = nextTask(fixture.store);
    expect(result.status).toBe("found");
  });

  it("names the epic when the task belongs to one", () => {
    const epic = seedEpic(fixture.store, { title: "the epic" });
    planned("child", { parentId: epic });

    const result = nextTask(fixture.store);
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.epic?.title).toBe("the epic");
  });

  it("returns only tasks of the requested kind", () => {
    planned("a feature", { kind: "feat", priority: 0 });
    planned("a bug", { kind: "fix", priority: 4 });

    const result = nextTask(fixture.store, { kind: "fix" });
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.title).toBe("a bug");
  });

  it("narrows to a single epic", () => {
    const wanted = seedEpic(fixture.store, { title: "wanted" });
    const other = seedEpic(fixture.store, { title: "other" });
    planned("in the other epic", { parentId: other, priority: 0 });
    planned("in the wanted epic", { parentId: wanted, priority: 4 });

    const result = nextTask(fixture.store, { epic: wanted });
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.title).toBe("in the wanted epic");
  });

  it("distinguishes an empty backlog from a fully blocked one", () => {
    // The whole reason the empty case is a union rather than null: an agent
    // that reads "nothing" as "no work left" stops working.
    const empty = nextTask(fixture.store);
    expect(empty).toEqual({ status: "none", blocked: [] });

    const blocker = seedTask(fixture.store, { title: "the blocker", lane: "In Progress" });
    const blocked = planned("stuck");
    addDependency(fixture.store, blocked, blocker);

    const stuck = nextTask(fixture.store);
    expect(stuck.status).toBe("none");
    if (stuck.status !== "none") throw new Error("unreachable");
    expect(stuck.blocked).toHaveLength(1);
    expect(stuck.blocked[0]?.title).toBe("stuck");
    expect(stuck.blocked[0]?.blockers.map((b) => b.title)).toEqual(["the blocker"]);
  });

  it("lists every blocked planned task, worst priority first", () => {
    const blocker = seedTask(fixture.store, { title: "blocker" });
    const urgent = planned("urgent", { priority: 0 });
    const later = planned("later", { priority: 4 });
    addDependency(fixture.store, urgent, blocker);
    addDependency(fixture.store, later, blocker);

    const result = nextTask(fixture.store);
    if (result.status !== "none") throw new Error("unreachable");
    expect(result.blocked.map((t) => t.title)).toEqual(["urgent", "later"]);
  });

  it("reports nothing blocked when the filter excludes every planned task", () => {
    planned("a feature", { kind: "feat" });

    const result = nextTask(fixture.store, { kind: "docs" });
    expect(result).toEqual({ status: "none", blocked: [] });
  });

  it("becomes available once the blocker is cancelled", () => {
    const blocker = seedTask(fixture.store, { title: "blocker" });
    const blocked = planned("waiting");
    addDependency(fixture.store, blocked, blocker);
    expect(nextTask(fixture.store).status).toBe("none");

    fixture.store.db
      .prepare("UPDATE tasks SET lane='Cancelled', closed_at='2026-02-01T00:00:00.000Z' WHERE id=?")
      .run(blocker);

    const result = nextTask(fixture.store);
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.title).toBe("waiting");
  });
});
