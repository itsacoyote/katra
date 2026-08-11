import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDependency } from "../../src/core/graph/deps.js";
import { nextTask, readyPredicate } from "../../src/core/tasks/next.js";
import { listTasks } from "../../src/core/tasks/repo.js";
import { seedClaim, seedEpic, seedTask, seedTime } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

/** A worktree distinct from the fixture's own identity, for contended claims. */
const OTHER_WORKTREE = "/repo/elsewhere";

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
    expect(empty).toEqual({ status: "none", blocked: [], untriaged: 0, claimedElsewhere: 0 });

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

  it("separates nothing-planned from everything-blocked from nothing-at-all", () => {
    // Three answers hide behind "nothing to do". The first is the one that
    // used to read as a dead end: `add` puts work in Defined, so a caller who
    // has just filled a store gets told about a lane they never chose.
    const nothingAtAll = nextTask(fixture.store);
    expect(nothingAtAll).toMatchObject({ blocked: [], untriaged: 0 });

    seedTask(fixture.store, { title: "never triaged", lane: "Defined" });
    seedTask(fixture.store, { title: "also waiting", lane: "Researching" });
    const nothingPlanned = nextTask(fixture.store);
    expect(nothingPlanned).toMatchObject({ blocked: [], untriaged: 2 });

    const blocker = seedTask(fixture.store, { title: "the blocker", lane: "In Progress" });
    const blocked = planned("stuck");
    addDependency(fixture.store, blocked, blocker);
    const everythingBlocked = nextTask(fixture.store);
    if (everythingBlocked.status !== "none") throw new Error("unreachable");
    expect(everythingBlocked.blocked).toHaveLength(1);
    // `In Progress` counts as untriaged too — it is unfinished work outside
    // the Planned lane — but Done and Cancelled never do.
    expect(everythingBlocked.untriaged).toBe(3);
  });

  it("does not count finished or abandoned work as waiting to be planned", () => {
    seedTask(fixture.store, { title: "done", lane: "Done" });
    seedTask(fixture.store, { title: "dropped", lane: "Cancelled" });

    expect(nextTask(fixture.store)).toMatchObject({ untriaged: 0 });
  });

  it("counts only what the filters asked about", () => {
    // `next --epic X` reporting the whole store's untriaged count would name a
    // number the caller cannot act on from where they are standing.
    const wanted = seedEpic(fixture.store, { title: "wanted" });
    const other = seedEpic(fixture.store, { title: "other" });
    seedTask(fixture.store, { title: "mine", parentId: wanted, lane: "Defined" });
    seedTask(fixture.store, { title: "theirs", parentId: other, lane: "Defined" });

    expect(nextTask(fixture.store, { epic: wanted })).toMatchObject({ untriaged: 1 });
    // Two tasks, not four: the two epics holding them are containers, and
    // telling someone to plan an epic points at work that does not exist.
    expect(nextTask(fixture.store)).toMatchObject({ untriaged: 2 });
    expect(nextTask(fixture.store, { level: "epic" })).toMatchObject({ untriaged: 2 });
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
    expect(result).toEqual({ status: "none", blocked: [], untriaged: 0, claimedElsewhere: 0 });
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

describe("epics are not work", () => {
  it("returns the planned task, not a higher-priority planned epic", () => {
    // The invariant `board`'s ready section depends on: its first row must be
    // what `next` returns, and its own filter excludes epics. Before this,
    // `next`'s candidate select had no level guard at all — only
    // `countUntriaged` did — so a Planned epic outranked every task behind it
    // and `next` answered with a container nobody can pick up.
    seedEpic(fixture.store, { title: "the epic", lane: "Planned", priority: 0 });
    planned("real work", { priority: 1 });

    const result = nextTask(fixture.store);

    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.title).toBe("real work");
  });

  it("still returns an epic when --level epic is explicit", () => {
    // The same escape hatch `countUntriaged` and `list --ready` already honour:
    // an explicit `--level` means the caller is asking about epics on purpose.
    const epic = seedEpic(fixture.store, { title: "the epic", lane: "Planned" });

    const result = nextTask(fixture.store, { level: "epic" });

    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.id).toBe(epic);
  });

  it("omits a blocked planned epic from the blocked list", () => {
    // The second query, which the first draft of this change left alone.
    // Listing an epic as blocked work advertises something `next` will never
    // hand out, so the two branches have to agree about what counts as work.
    const epic = seedEpic(fixture.store, { title: "blocked epic", lane: "Planned" });
    const blocker = planned("the blocker");
    addDependency(fixture.store, epic, blocker);
    const task = planned("blocked task");
    addDependency(fixture.store, task, blocker);
    // Leave nothing startable, so `next` has to fall through to the blocked
    // branch rather than answering with `the blocker` itself.
    fixture.store.db.prepare("UPDATE tasks SET lane = 'Defined' WHERE id = ?").run(blocker);

    const result = nextTask(fixture.store);

    if (result.status !== "none") throw new Error("unreachable");
    expect(result.blocked.map((b) => b.title)).toEqual(["blocked task"]);
  });
});

describe("claims steer the candidate query (F4 T6)", () => {
  it("skips a task claimed by another worktree", () => {
    const claimed = planned("claimed elsewhere", { priority: 0 });
    seedClaim(fixture.store, { taskId: claimed, holder: OTHER_WORKTREE });
    const unclaimed = planned("free to take", { priority: 4 });

    const result = nextTask(fixture.store);

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.id).toBe(unclaimed);
  });

  it("ranks the caller's own claim above a higher-priority unclaimed task", () => {
    // A single-task fixture would prove nothing — priority 0 is the highest
    // and would win the plain ranking regardless of any claim, so both
    // candidates have to be seeded for this to be falsifiable.
    const own = fixture.store.identity().worktree;
    const resumed = planned("resume this", { priority: 4 });
    seedClaim(fixture.store, { taskId: resumed, holder: own });
    planned("higher priority, unclaimed", { priority: 0 });

    const result = nextTask(fixture.store);

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.id).toBe(resumed);
  });

  it("does not resurrect an own claim that already left Planned", () => {
    // ADR-012's boundary: an own claim only resumes within next's Planned
    // scope. One already moved to In Progress is the board digest's to
    // surface, not next's — readyPredicate's own lane filter is what keeps
    // it out, with no special-casing needed here.
    const own = fixture.store.identity().worktree;
    const started = seedTask(fixture.store, {
      title: "already under way",
      lane: "In Progress",
      priority: 0,
    });
    seedClaim(fixture.store, { taskId: started, holder: own });
    const stillPlanned = planned("still to start", { priority: 4 });

    const result = nextTask(fixture.store);

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.task.id).toBe(stillPlanned);
  });

  it("reports claimed-elsewhere separately from an empty backlog", () => {
    const empty = nextTask(fixture.store);
    expect(empty).toEqual({ status: "none", blocked: [], untriaged: 0, claimedElsewhere: 0 });

    const claimed = planned("taken");
    seedClaim(fixture.store, { taskId: claimed, holder: OTHER_WORKTREE });

    const result = nextTask(fixture.store);

    expect(result.status).toBe("none");
    if (result.status !== "none") throw new Error("unreachable");
    expect(result.blocked).toEqual([]);
    expect(result.untriaged).toBe(0);
    expect(result.claimedElsewhere).toBe(1);
  });

  it("keeps another worktree's blocked task in the blocked list", () => {
    // The blocked branch and countUntriaged stay untouched by claims — only
    // the candidate query applies the exclusion.
    const blocker = seedTask(fixture.store, { title: "the blocker" });
    const blocked = planned("stuck and claimed");
    addDependency(fixture.store, blocked, blocker);
    seedClaim(fixture.store, { taskId: blocked, holder: OTHER_WORKTREE });

    const result = nextTask(fixture.store);

    expect(result.status).toBe("none");
    if (result.status !== "none") throw new Error("unreachable");
    expect(result.blocked.map((b) => b.title)).toEqual(["stuck and claimed"]);
    // Not ready, so it never enters the claimed-elsewhere count either —
    // that count is scoped to readyPredicate's pool, same as the candidate
    // query it mirrors.
    expect(result.claimedElsewhere).toBe(0);
  });

  it("leaves readyPredicate unchanged from F3", () => {
    // Byte-identical: claims must never become a filter baked into the
    // shared predicate (plan-review HIGH-1). Only the candidate query above
    // layers claim exclusion on top, via `AND NOT (...)`.
    expect(readyPredicate().sql).toBe("t.lane = ? AND r.is_ready = ? AND t.level = 'task'");
    expect(readyPredicate().params).toEqual(["Planned", 1]);
  });

  it("keeps list --ready claim-neutral where next is not", () => {
    const claimed = planned("taken but ready");
    seedClaim(fixture.store, { taskId: claimed, holder: OTHER_WORKTREE });

    const listed = listTasks(fixture.store, { ready: true });
    expect(listed.tasks.map((t) => t.id)).toContain(claimed);

    const result = nextTask(fixture.store);
    expect(result.status).toBe("none");
  });
});
