import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimFor, claimTask } from "../../src/core/claims/repo.js";
import { isKatraException } from "../../src/core/errors.js";
import { listEvents } from "../../src/core/events/repo.js";
import { addDependency, isReady } from "../../src/core/graph/deps.js";
import { addLink } from "../../src/core/graph/links.js";
import { linkRef, listRefs } from "../../src/core/refs/repo.js";
import { deleteTask } from "../../src/core/tasks/delete.js";
import { getTask } from "../../src/core/tasks/repo.js";
import { seedDep, seedEpic, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

/**
 * A pass-through count of `writeTx` calls, mirrored from `refs.test.ts`'s own
 * `writeTxSpy` — pins the critical invariant that `deleteTask`'s orphan-ref
 * GC rides its existing transaction rather than opening a second one. Vitest
 * gives each test file its own module registry (`isolate`, pinned on in
 * vitest.config.ts), so this factory never reaches `refs.test.ts`'s counter.
 */
const writeTxSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/core/db/connection.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/db/connection.js")>();
  const writeTx: typeof original.writeTx = (db, fn) => {
    writeTxSpy.calls += 1;
    return original.writeTx(db, fn);
  };
  return { ...original, writeTx };
});

const GITHUB_REF = {
  provider: "github",
  externalId: "owner/repo#12",
  url: "https://github.com/owner/repo/pull/12",
};

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

const count = (table: string): number =>
  (fixture.store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

describe("what a delete reports as released", () => {
  it("says nothing about a dependent that was already startable", () => {
    // The filter that makes this true — "was blocked before, ready after" —
    // is a no-op for close/cancel/reopen, whose guards prove the subject was
    // non-terminal. `delete` accepts any lane, so this is the only path where
    // it matters, and removing it leaves the whole suite green.
    const alreadyDone = seedTask(fixture.store, { title: "already finished", lane: "Done" });
    const waiter = seedTask(fixture.store, { title: "never actually blocked" });
    seedDep(fixture.store, waiter, alreadyDone);
    expect(isReady(fixture.store, waiter)).toBe(true);

    expect(deleteTask(fixture.store, alreadyDone).unblocked).toEqual([]);
  });
});

describe("deleteTask", () => {
  it("removes the task", () => {
    const id = seedTask(fixture.store, { title: "a mistake" });

    expect(deleteTask(fixture.store, id)).toMatchObject({ id, title: "a mistake" });
    expect(getTask(fixture.store, id)).toBeUndefined();
  });

  it("removes its dependency, link and tag rows", () => {
    const id = seedTask(fixture.store, { tags: ["x"] });
    const other = seedTask(fixture.store);
    addDependency(fixture.store, id, other);
    addLink(fixture.store, id, other);

    deleteTask(fixture.store, id);

    expect(count("deps")).toBe(0);
    expect(count("links")).toBe(0);
    expect(count("tags")).toBe(0);
    // The other task survives untouched.
    expect(getTask(fixture.store, other)).toBeDefined();
  });

  it("reports the tasks its removal unblocked", () => {
    // ON DELETE CASCADE takes the dependency rows with it, which silently
    // makes dependents startable — the same consequence cancel reports.
    const blocker = seedTask(fixture.store);
    const dependent = seedTask(fixture.store, { title: "was waiting" });
    addDependency(fixture.store, dependent, blocker);
    expect(isReady(fixture.store, dependent)).toBe(false);

    const result = deleteTask(fixture.store, blocker);

    expect(result.unblocked.map((t) => t.title)).toEqual(["was waiting"]);
    expect(isReady(fixture.store, dependent)).toBe(true);
  });

  it("reports nothing when the task blocked nothing", () => {
    expect(deleteTask(fixture.store, seedTask(fixture.store)).unblocked).toEqual([]);
  });

  it("refuses to delete an epic that still has children", () => {
    const epic = seedEpic(fixture.store);
    seedTask(fixture.store, { parentId: epic });
    seedTask(fixture.store, { parentId: epic });

    try {
      deleteTask(fixture.store, epic);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("conflict");
      // Names the count, so the reader knows the size of the problem.
      expect(error.message).toMatch(/2 children/);
      expect(error.message).toMatch(/cancel/);
    }
  });

  it("says child rather than children when there is one", () => {
    const epic = seedEpic(fixture.store);
    seedTask(fixture.store, { parentId: epic });

    expect(() => deleteTask(fixture.store, epic)).toThrowError(/1 child\b/);
  });

  it("leaves every child's parent_id intact after a refused deletion", () => {
    const epic = seedEpic(fixture.store);
    const child = seedTask(fixture.store, { parentId: epic });

    expect(() => deleteTask(fixture.store, epic)).toThrow();

    expect(getTask(fixture.store, child)?.parentId).toBe(epic);
    expect(getTask(fixture.store, epic)).toBeDefined();
  });

  it("deletes an epic once its children are gone", () => {
    const epic = seedEpic(fixture.store);
    const child = seedTask(fixture.store, { parentId: epic });

    deleteTask(fixture.store, child);

    expect(() => deleteTask(fixture.store, epic)).not.toThrow();
    expect(count("tasks")).toBe(0);
  });

  it("deletes an epic once its children are reparented away", () => {
    const first = seedEpic(fixture.store, { id: "kt-ep0001" });
    const second = seedEpic(fixture.store, { id: "kt-ep0002" });
    const child = seedTask(fixture.store, { parentId: first });

    fixture.store.db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(second, child);

    expect(() => deleteTask(fixture.store, first)).not.toThrow();
  });

  it("is refused by the database even when the application check is bypassed", () => {
    // The count check exists to say how many children are in the way. The
    // guarantee is ON DELETE RESTRICT, which holds against raw SQL too.
    const epic = seedEpic(fixture.store);
    seedTask(fixture.store, { parentId: epic });

    expect(() => fixture.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(epic)).toThrow();
  });

  it("accepts a partial id", () => {
    const id = seedTask(fixture.store, { id: "kt-ab1234" });
    expect(deleteTask(fixture.store, "ab1").id).toBe(id);
  });

  it("reports an unknown id as not found", () => {
    expect(() => deleteTask(fixture.store, "zzzz")).toThrowError(/no task matches/);
  });
});

describe("claim settlement", () => {
  it("logs released before the cascade when a claimed task is deleted", () => {
    const id = seedTask(fixture.store, { title: "claimed then removed" });
    const { claim } = claimTask(fixture.store, id);

    deleteTask(fixture.store, id);

    // The cascade (ON DELETE CASCADE off the task row) leaves nothing behind
    // to find — the row is gone either way — but `released` proves it was
    // recorded before that happened, not merely that the claim vanished.
    expect(claimFor(fixture.store, id)).toBeNull();
    const events = listEvents(fixture.store, { entityId: id }).events;
    // Newest first: deleted is appended after the cascade, released before it.
    expect(events.map((e) => e.type)).toEqual(["deleted", "released", "claimed"]);
    const released = events.find((e) => e.type === "released");
    expect(released?.priorActor).toBeNull();
    expect(released?.actor).toBe(claim.actor);
  });

  it("appends no released event when the deleted task was never claimed", () => {
    const id = seedTask(fixture.store);

    deleteTask(fixture.store, id);

    expect(listEvents(fixture.store, { entityId: id }).events.map((e) => e.type)).toEqual([
      "deleted",
    ]);
  });
});

describe("deleteTask orphan-ref GC (epic risk note 16)", () => {
  it("deleting the sole holder task GCs the refs row (direct DB read)", () => {
    const id = seedTask(fixture.store);
    linkRef(fixture.store, id, GITHUB_REF);
    expect(count("refs")).toBe(1);

    deleteTask(fixture.store, id);

    expect(count("refs")).toBe(0);
  });

  it("deleting one of two holder tasks keeps the row and the survivor's view", () => {
    const taskA = seedTask(fixture.store);
    const taskB = seedTask(fixture.store);
    linkRef(fixture.store, taskA, GITHUB_REF);
    linkRef(fixture.store, taskB, GITHUB_REF);

    deleteTask(fixture.store, taskA);

    expect(count("refs")).toBe(1);
    expect(listRefs(fixture.store, taskB)).toEqual([
      expect.objectContaining({ provider: "github", externalId: "owner/repo#12" }),
    ]);
  });

  it("delete emits no ref-unlinked events", () => {
    const id = seedTask(fixture.store);
    linkRef(fixture.store, id, GITHUB_REF);

    deleteTask(fixture.store, id);

    const events = fixture.store.db
      .prepare("SELECT type FROM events WHERE type = 'ref-unlinked'")
      .all();
    expect(events).toEqual([]);
  });

  it("GC and delete are atomic (simulated failure keeps both or neither — house crash-consistency pattern)", () => {
    // better-sqlite3 nests `db.transaction(...)` as a SAVEPOINT when one is
    // already open — wrapping `deleteTask` in an outer transaction that throws
    // *after* it has already returned proves the task row's cascade and the
    // ref's orphan GC live in one rollback-able unit. The mid-transaction read
    // is load-bearing: without it, these assertions are indistinguishable from
    // "the GC never ran at all", and the test passes with the feature deleted.
    // (Which halves share one transaction is the writeTxSpy test's job — the
    // savepoint nesting here cannot observe that.)
    const id = seedTask(fixture.store);
    linkRef(fixture.store, id, GITHUB_REF);

    let midTx: { task: unknown; refs: number } | undefined;
    expect(() =>
      fixture.store.db.transaction(() => {
        deleteTask(fixture.store, id);
        // Read *inside* the transaction, before the rollback: proves both
        // writes actually landed, so what follows is a rollback and not a GC
        // that never ran.
        midTx = { task: getTask(fixture.store, id), refs: count("refs") };
        throw new Error("boom, after deleteTask already returned");
      })(),
    ).toThrowError("boom, after deleteTask already returned");

    // Both happened...
    expect(midTx).toEqual({ task: undefined, refs: 0 });
    // ...and both were undone.
    expect(getTask(fixture.store, id)).toBeDefined();
    expect(count("refs")).toBe(1);
  });

  it("deleteTask opens exactly one write transaction — the cascade and orphan GC share it", () => {
    const id = seedTask(fixture.store);
    linkRef(fixture.store, id, GITHUB_REF);

    writeTxSpy.calls = 0;
    deleteTask(fixture.store, id);

    expect(writeTxSpy.calls).toBe(1);
  });
});
