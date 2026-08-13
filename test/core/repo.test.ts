import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTx, writeTx } from "../../src/core/db/connection.js";
import { isKatraException } from "../../src/core/errors.js";
import { listEvents } from "../../src/core/events/repo.js";
import { addDependency } from "../../src/core/graph/deps.js";
import { closeTask } from "../../src/core/tasks/lifecycle.js";
import { nextTask } from "../../src/core/tasks/next.js";
import { createTask, createTaskWithin, getTask, showTask } from "../../src/core/tasks/repo.js";
import { seedEpic, seedTask, seedTime } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

describe("createTask", () => {
  it("creates a task in the Defined lane with workable defaults", () => {
    const task = createTask(fixture.store, { title: "wire up the parser" });

    expect(task.id).toMatch(/^kt-[0-9a-z]{6}$/);
    expect(task).toMatchObject({
      level: "task",
      kind: "feat",
      lane: "Defined",
      priority: 2,
      title: "wire up the parser",
      description: null,
      assignee: null,
      parentId: null,
      closedAt: null,
      tags: [],
    });
  });

  it("creates an epic when the level says so", () => {
    expect(createTask(fixture.store, { title: "an epic", level: "epic" }).level).toBe("epic");
  });

  it("trims the title and refuses an empty one", () => {
    expect(createTask(fixture.store, { title: "  padded  " }).title).toBe("padded");
    expect(() => createTask(fixture.store, { title: "   " })).toThrowError(/needs a title/);
  });

  it("writes a task and its tags with an identical created_at", () => {
    // One transaction, one timestamp — rows written together must not drift by
    // a millisecond, or created_at ordering stops being meaningful.
    const task = createTask(fixture.store, { title: "tagged", tags: ["urgent", "backend"] });

    expect(task.tags).toEqual(["backend", "urgent"]);
    expect(task.createdAt).toBe(task.updatedAt);
    expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("ignores blank and duplicate tags", () => {
    const task = createTask(fixture.store, { title: "t", tags: ["a", " ", "a", " b "] });
    expect(task.tags).toEqual(["a", "b"]);
  });

  it("accepts a parent given as a partial id", () => {
    const epic = seedEpic(fixture.store, { id: "kt-ep1234" });

    const task = createTask(fixture.store, { title: "child", parentId: "ep12" });

    expect(task.parentId).toBe(epic);
  });

  it.each(["Done", "Cancelled"] as const)("refuses to create a task in %s", (lane) => {
    // `add` is the third lane-setting path after `update` and `reopen`, and it
    // was the one without a guard. The schema still refuses the row, but as a
    // raw CHECK-constraint dump reported under the code "internal" — which is
    // not a KatraErrorCode, so a consumer switching over the union hits a
    // value the type says cannot exist.
    try {
      createTask(fixture.store, { title: "born finished", lane });
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      expect(error.message).not.toContain("CHECK constraint");
      expect(error.message).toContain("katra close");
      expect(error.message).toContain("katra cancel");
    }
  });

  it("refuses a parent that is not an epic, naming what it actually is", () => {
    const other = seedTask(fixture.store, { id: "kt-tk1234" });

    try {
      createTask(fixture.store, { title: "child", parentId: other });
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      // A validation refusal, not the trigger's RAISE(ABORT) leaking through:
      // the trigger's bare string reached the user as an internal error, which
      // reads as a katra crash rather than as a rejected argument.
      expect(error.detail.code).toBe("validation");
      expect(error.message).toContain("is a task, not an epic");
      expect(error.message).toContain(other);
    }
  });

  it("reports an unknown parent as not found rather than as a constraint failure", () => {
    try {
      createTask(fixture.store, { title: "child", parentId: "kt-nope00" });
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("not_found");
    }
  });

  it("rejects every value outside a fixed set", () => {
    const bad = [
      { title: "t", level: "story" },
      { title: "t", kind: "style" },
      { title: "t", lane: "Ready" },
      { title: "t", priority: 9 },
    ] as const;

    for (const input of bad) {
      expect(() => createTask(fixture.store, input as never)).toThrowError(/must be one of/);
    }
  });

  it("leaves nothing behind when the write fails part-way", () => {
    const before = fixture.store.db.prepare("SELECT COUNT(*) c FROM tasks").get();
    expect(() =>
      createTask(fixture.store, { title: "doomed", tags: ["ok"], lane: "Nope" as never }),
    ).toThrow();

    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM tasks").get()).toEqual(before);
    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM tags").get()).toEqual({ c: 0 });
  });

  it("gives every created task a distinct id", () => {
    const ids = new Set(
      Array.from({ length: 300 }, (_u, i) => createTask(fixture.store, { title: `t${i}` }).id),
    );
    expect(ids.size).toBe(300);
  });

  it("outer createTask still stamps writeTx's now and appends the created event", () => {
    const local = createStoreFixture({ actor: "someone @ /repo/x" });
    try {
      const task = createTask(local.store, { title: "wrapped" });

      const events = listEvents(local.store, { entityId: task.id }).events;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "created",
        entityId: task.id,
        actor: "someone @ /repo/x",
        title: "wrapped",
        createdAt: task.createdAt,
      });
    } finally {
      local.cleanup();
    }
  });
});

describe("createTaskWithin", () => {
  it("createTaskWithin stamps the caller's createdAt and a distinct updatedAt on the row", () => {
    const createdAt = seedTime();
    const updatedAt = seedTime(5_000);

    const id = writeTx(fixture.store.db, () =>
      createTaskWithin(fixture.store, { title: "seam task" }, { createdAt, updatedAt }),
    );

    const task = getTask(fixture.store, id);
    expect(task?.createdAt).toBe(createdAt);
    expect(task?.updatedAt).toBe(updatedAt);
    expect(task?.updatedAt).not.toBe(task?.createdAt);
  });

  it("createTaskWithin appends no event and throws outside a transaction", () => {
    expect(() =>
      createTaskWithin(fixture.store, { title: "no seam" }, { createdAt: seedTime() }),
    ).toThrowError(/inside an open transaction/);

    const id = writeTx(fixture.store.db, () =>
      createTaskWithin(fixture.store, { title: "seamed" }, { createdAt: seedTime() }),
    );

    expect(listEvents(fixture.store, { entityId: id }).events).toEqual([]);
  });

  it("createTaskWithin throws when called inside a read transaction", () => {
    // The other half of the transaction-required guard: `db.inTransaction` is
    // also true inside a deferred read, so only `assertNotReadOnly` catches
    // this — see its own docs (`db/connection.ts`) for why the plain
    // `inTransaction` check above cannot.
    expect(() =>
      readTx(fixture.store.db, () =>
        createTaskWithin(fixture.store, { title: "in a read" }, { createdAt: seedTime() }),
      ),
    ).toThrowError(/read transaction/);
  });

  it("createTaskWithin still enforces title validation and the terminal-lane guard", () => {
    writeTx(fixture.store.db, () => {
      expect(() =>
        createTaskWithin(fixture.store, { title: "   " }, { createdAt: seedTime() }),
      ).toThrowError(/needs a title/);

      expect(() =>
        createTaskWithin(
          fixture.store,
          { title: "born finished", lane: "Done" },
          { createdAt: seedTime() },
        ),
      ).toThrowError(/katra close/);
    });
  });
});

describe("getTask", () => {
  it("returns undefined for an id that does not exist", () => {
    expect(getTask(fixture.store, "kt-absent")).toBeUndefined();
  });

  it("round-trips every field through the row mapper", () => {
    const epic = seedEpic(fixture.store);
    const created = createTask(fixture.store, {
      title: "full",
      level: "task",
      kind: "fix",
      description: "a description",
      lane: "Planned",
      priority: 0,
      assignee: "someone",
      parentId: epic,
      tags: ["x"],
    });

    expect(getTask(fixture.store, created.id)).toEqual(created);
  });

  it("refuses to narrow a row whose stored value is outside the allowed set", () => {
    // A row can be written by an older build or by raw SQL, so the mapper
    // treats it as untrusted rather than casting.
    const id = seedTask(fixture.store);
    // The CHECK blocks a bad kind, so simulate an older build's value by
    // rebuilding the row with constraints momentarily off.
    fixture.store.db.pragma("ignore_check_constraints = ON");
    fixture.store.db.prepare("UPDATE tasks SET kind = 'style' WHERE id = ?").run(id);
    fixture.store.db.pragma("ignore_check_constraints = OFF");

    expect(() => getTask(fixture.store, id)).toThrowError(/kind must be one of/);
  });
});

describe("showTask", () => {
  it("resolves a partial id and returns the task", () => {
    const created = createTask(fixture.store, { title: "findable" });
    const prefix = created.id.slice(3, 6);

    expect(showTask(fixture.store, prefix).task).toEqual(created);
  });

  it("names the parent epic rather than only its id", () => {
    const epic = createTask(fixture.store, { title: "the epic", level: "epic" });
    const child = createTask(fixture.store, { title: "the child", parentId: epic.id });

    const detail = showTask(fixture.store, child.id);

    expect(detail.parent).toEqual({
      id: epic.id,
      title: "the epic",
      level: "epic",
      lane: "Defined",
    });
  });

  it("reports no parent for a top-level task", () => {
    const task = createTask(fixture.store, { title: "orphan" });
    expect(showTask(fixture.store, task.id).parent).toBeNull();
  });

  it("lists the unfinished dependencies standing in the task's way", () => {
    // Found by dogfooding: `show` was the only view that never mentioned
    // dependencies, so a blocked task rendered identically to a startable one
    // — in the command an agent uses to decide whether to start it.
    const blocker = createTask(fixture.store, { title: "must land first" });
    const task = createTask(fixture.store, { title: "waits" });
    addDependency(fixture.store, task.id, blocker.id);

    expect(showTask(fixture.store, task.id).blockers).toEqual([
      { id: blocker.id, title: "must land first", lane: "Defined" },
    ]);
  });

  it("reports no blockers for a task nothing is holding up", () => {
    const task = createTask(fixture.store, { title: "free" });

    expect(showTask(fixture.store, task.id).blockers).toEqual([]);
  });

  it("drops a dependency from blockers once it reaches a terminal lane", () => {
    // The same set `next` reports. An agent asking `show` whether it can start
    // something and one asking `next` for something to start must not get
    // different answers.
    const blocker = createTask(fixture.store, { title: "must land first" });
    const task = createTask(fixture.store, { title: "waits" });
    addDependency(fixture.store, task.id, blocker.id);

    closeTask(fixture.store, blocker.id);

    expect(showTask(fixture.store, task.id).blockers).toEqual([]);
    // Still a dependency, just no longer in the way — the edge itself survives.
    expect(showTask(fixture.store, blocker.id).blocking.map((t) => t.id)).toEqual([task.id]);
  });

  it("agrees with next about what is blocking a task", () => {
    // The consequence a divergence would actually have: two commands giving
    // an agent different answers about the same task.
    const blocker = createTask(fixture.store, { title: "blocker", lane: "Planned" });
    const task = createTask(fixture.store, { title: "waits", lane: "Planned" });
    addDependency(fixture.store, task.id, blocker.id);

    const result = nextTask(fixture.store);
    if (result.status !== "found") throw new Error("unreachable");
    // `next` hands back the blocker itself; asking `show` about the blocked
    // task must name that same task as what stands in the way.
    expect(showTask(fixture.store, task.id).blockers.map((b) => b.id)).toEqual([result.task.id]);
  });

  it("lists the tasks that finishing this one would release", () => {
    const blocker = createTask(fixture.store, { title: "the blocker" });
    const one = createTask(fixture.store, { title: "waits a", priority: 0 });
    const two = createTask(fixture.store, { title: "waits b", priority: 1 });
    addDependency(fixture.store, one.id, blocker.id);
    addDependency(fixture.store, two.id, blocker.id);

    expect(showTask(fixture.store, blocker.id).blocking.map((t) => t.id)).toEqual([one.id, two.id]);
    expect(showTask(fixture.store, blocker.id).blockers).toEqual([]);
  });

  it("keeps blockers and blocking distinct rather than reporting the edge twice", () => {
    // Symmetry would make every dependency look mutual, which is the one thing
    // a dependency is not.
    const blocker = createTask(fixture.store, { title: "first" });
    const task = createTask(fixture.store, { title: "second" });
    addDependency(fixture.store, task.id, blocker.id);

    const blocked = showTask(fixture.store, task.id);
    const upstream = showTask(fixture.store, blocker.id);

    expect(blocked.blockers.map((t) => t.id)).toEqual([blocker.id]);
    expect(blocked.blocking).toEqual([]);
    expect(upstream.blockers).toEqual([]);
    expect(upstream.blocking.map((t) => t.id)).toEqual([task.id]);
  });

  it("throws not_found for an id that matches nothing", () => {
    try {
      showTask(fixture.store, "zzzz");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("not_found");
    }
  });

  it("throws ambiguous_id listing candidates when a prefix matches several", () => {
    seedTask(fixture.store, { id: "kt-aa0001" });
    seedTask(fixture.store, { id: "kt-aa0002" });

    try {
      showTask(fixture.store, "aa");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("ambiguous_id");
      if (error.detail.code !== "ambiguous_id") throw new Error("unreachable");
      expect(error.detail.candidates).toEqual(["kt-aa0001", "kt-aa0002"]);
    }
  });
});

describe("reading a malformed row", () => {
  it("refuses a text column holding a BLOB rather than handing back a Buffer", () => {
    // SQLite's affinity rules let a BLOB sit in a TEXT NOT NULL column, and
    // better-sqlite3 returns it as a Buffer. Cast rather than narrowed, it
    // reached formatTaskDetail, where .trim() threw a TypeError reported as
    // `internal` and exit 4 — telling an agent to escalate a broken machine
    // when the truth is one malformed row. Under --json it serialised as
    // {"type":"Buffer","data":[…]}, which matches nothing katra publishes.
    const id = seedTask(fixture.store, { title: "fine for now" });
    fixture.store.db
      .prepare("UPDATE tasks SET title = ? WHERE id = ?")
      .run(Buffer.from("not text"), id);

    try {
      getTask(fixture.store, id);
      expect.unreachable("should have refused the row");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      expect(error.message).toContain("title");
      expect(error.message).toMatch(/malformed/);
    }
  });

  it("still accepts a NULL in a column that allows one", () => {
    const id = seedTask(fixture.store, { description: null, assignee: null });
    const task = getTask(fixture.store, id);

    expect(task?.description).toBeNull();
    expect(task?.assignee).toBeNull();
  });
});
