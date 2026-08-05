import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDependency } from "../../src/core/graph/deps.js";
import { nextTask } from "../../src/core/tasks/next.js";
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

  it("breaks a created_at tie by insertion order, not by id", () => {
    // Two rows written in the same millisecond are routine, so the tie needs a
    // decided winner. The ids run *backwards* against insertion order here, so
    // "insertion order" is a claim distinct from "id order" — the previous
    // version used the default sequential seed ids, where the two coincide and
    // the assertion held either way.
    //
    // Measured limitation, recorded rather than papered over: deleting the
    // `t.rowid` tiebreak from the query does **not** fail this test. SQLite's
    // only tie order is rowid, so a plan without the clause returns the same
    // rows in the same order. What the clause buys is that the order is
    // *specified* rather than incidental — SQLite documents the order of equal
    // ORDER BY keys as undefined and free to change with the query plan. That
    // guarantee is structural; this test pins the behaviour it produces.
    const stamp = seedTime(500);
    seedTask(fixture.store, { id: "kt-zzzzzz", title: "first", createdAt: stamp });
    seedTask(fixture.store, { id: "kt-mmmmmm", title: "second", createdAt: stamp });
    seedTask(fixture.store, { id: "kt-aaaaaa", title: "third", createdAt: stamp });

    for (let run = 0; run < 5; run++) {
      expect(titles(listTasks(fixture.store))).toEqual(["first", "second", "third"]);
    }
  });

  it("agrees with next about which of two tied tasks comes first", () => {
    // The consequence that a broken tiebreak would actually have: `list` says
    // work on one task and `next` hands back the other. This one *is*
    // falsifiable — reversing either command's ORDER BY fails it.
    const stamp = seedTime(500);
    seedTask(fixture.store, {
      id: "kt-zzzzzz",
      title: "first",
      lane: "Planned",
      priority: 0,
      createdAt: stamp,
    });
    seedTask(fixture.store, {
      id: "kt-aaaaaa",
      title: "second",
      lane: "Planned",
      priority: 0,
      createdAt: stamp,
    });

    const listed = listTasks(fixture.store, { lane: "Planned" }).tasks[0];
    const chosen = nextTask(fixture.store);
    if (chosen.status !== "found") throw new Error("unreachable");

    expect(chosen.task.id).toBe(listed?.id);
  });

  it("includes each task's tags", () => {
    seedTask(fixture.store, { title: "tagged", tags: ["b", "a"] });

    expect(listTasks(fixture.store).tasks[0]?.tags).toEqual(["a", "b"]);
  });
});

describe("listTasks --limit", () => {
  it("returns at most the requested number, keeping the highest-ranked", () => {
    seedTask(fixture.store, { title: "first", priority: 0 });
    seedTask(fixture.store, { title: "second", priority: 1 });
    seedTask(fixture.store, { title: "third", priority: 2 });

    expect(titles(listTasks(fixture.store, { limit: 2 }))).toEqual(["first", "second"]);
  });

  it("bounds the result after filtering, not before", () => {
    // A limit applied first would return two rows and then filter them down to
    // one, so `--lane Planned --limit 2` could hand back a single task while
    // more matched.
    seedTask(fixture.store, { title: "wrong lane", lane: "Defined", priority: 0 });
    seedTask(fixture.store, { title: "a", lane: "Planned", priority: 1 });
    seedTask(fixture.store, { title: "b", lane: "Planned", priority: 2 });

    expect(titles(listTasks(fixture.store, { lane: "Planned", limit: 2 }))).toEqual(["a", "b"]);
  });

  it("returns everything when no limit is given", () => {
    // Unbounded by default, unlike the event reads: tasks are bounded by how
    // much work exists, and a default cap would have to report truncation.
    for (let i = 0; i < 30; i++) seedTask(fixture.store, { title: `t${i}` });

    expect(listTasks(fixture.store).tasks).toHaveLength(30);
  });

  it("treats a limit of zero as a real answer rather than as unbounded", () => {
    // The falsy-check bug this exists to prevent: `if (limit)` folds 0 into
    // the no-limit branch and returns the entire backlog for a request that
    // asked for none of it.
    seedTask(fixture.store, { title: "one" });

    expect(listTasks(fixture.store, { limit: 0 }).tasks).toEqual([]);
  });

  it("refuses a limit that is not a whole count", () => {
    expect(() => listTasks(fixture.store, { limit: -1 })).toThrowError(/whole number/);
    expect(() => listTasks(fixture.store, { limit: 2.5 })).toThrowError(/whole number/);
  });

  it("does not bound the ready and blocked halves differently", () => {
    const blocker = seedTask(fixture.store, { title: "blocker", priority: 0 });
    const blocked = seedTask(fixture.store, { title: "blocked", priority: 1 });
    seedDep(fixture.store, blocked, blocker);

    expect(titles(listTasks(fixture.store, { ready: true, limit: 1 }))).toEqual(["blocker"]);
    expect(titles(listTasks(fixture.store, { ready: false, limit: 1 }))).toEqual(["blocked"]);
  });
});

describe("listTasks --ready and epics", () => {
  it("leaves epics out of the ready set, which is about startable work", () => {
    // Found by dogfooding: `list --ready` answered "what can I start?" with the
    // F2 epic at the top. An epic has no dependencies of its own, so it
    // satisfies readiness trivially, and P0 sorts it above everything real.
    seedEpic(fixture.store, { title: "an epic", priority: 0 });
    seedTask(fixture.store, { title: "real work", priority: 1 });

    expect(titles(listTasks(fixture.store, { ready: true }))).toEqual(["real work"]);
  });

  it("leaves epics out of the blocked set too", () => {
    // The two are halves of one filter; excluding epics from only one would
    // make `--ready` and `--blocked` disagree about what the universe is.
    const blocker = seedTask(fixture.store, { title: "blocker" });
    const epic = seedEpic(fixture.store, { title: "an epic" });
    const blocked = seedTask(fixture.store, { title: "blocked", parentId: epic });
    seedDep(fixture.store, blocked, blocker);
    seedDep(fixture.store, epic, blocker);

    expect(titles(listTasks(fixture.store, { ready: false }))).toEqual(["blocked"]);
  });

  it("still answers the literal question when --level epic is explicit", () => {
    // Excluding epics outright would make this combination return nothing,
    // always — an empty answer indistinguishable from a suppressed one.
    const blocker = seedTask(fixture.store, { title: "blocker" });
    seedEpic(fixture.store, { title: "free epic" });
    const stuck = seedEpic(fixture.store, { title: "stuck epic" });
    seedDep(fixture.store, stuck, blocker);

    expect(titles(listTasks(fixture.store, { ready: true, level: "epic" }))).toEqual(["free epic"]);
    expect(titles(listTasks(fixture.store, { ready: false, level: "epic" }))).toEqual([
      "stuck epic",
    ]);
  });

  it("still lists epics when readiness is not being asked about", () => {
    // The exclusion belongs to the readiness filters, not to `list` at large.
    seedEpic(fixture.store, { title: "an epic" });
    seedTask(fixture.store, { title: "a task" });

    expect(titles(listTasks(fixture.store)).sort()).toEqual(["a task", "an epic"]);
  });
});

describe("listTasks --ready and finished work", () => {
  it("leaves finished and abandoned tasks out of the ready set", () => {
    // The larger half of the same finding. A Done task has no unfinished
    // dependencies either, so a mature backlog answered "what can I start?"
    // with everything it had ever completed — on the dogfood store, seven of
    // them ahead of the real work.
    seedTask(fixture.store, { title: "done", lane: "Done" });
    seedTask(fixture.store, { title: "dropped", lane: "Cancelled" });
    seedTask(fixture.store, { title: "startable" });

    expect(titles(listTasks(fixture.store, { ready: true }))).toEqual(["startable"]);
  });

  it("still answers the literal question when --lane is explicit", () => {
    seedTask(fixture.store, { title: "done", lane: "Done" });
    seedTask(fixture.store, { title: "startable" });

    expect(titles(listTasks(fixture.store, { ready: true, lane: "Done" }))).toEqual(["done"]);
  });

  it("still lists finished work when readiness is not being asked about", () => {
    seedTask(fixture.store, { title: "done", lane: "Done" });
    seedTask(fixture.store, { title: "open" });

    expect(titles(listTasks(fixture.store)).sort()).toEqual(["done", "open"]);
    expect(titles(listTasks(fixture.store, { lane: "Done" }))).toEqual(["done"]);
  });
});
