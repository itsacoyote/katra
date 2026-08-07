/**
 * `readTx` — the deferred read snapshot, and the guard that keeps writes out.
 *
 * Two connections to one store are the point of every test here: a snapshot
 * that only ever sees its own writes proves nothing, and WAL's whole promise is
 * that a reader and a writer can run at once.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readTx, writeTx } from "../../src/core/db/connection.js";
import { isKatraException } from "../../src/core/errors.js";
import { appendEvent } from "../../src/core/events/repo.js";
import { openStore } from "../../src/core/store.js";
import { createGitRepo } from "../helpers/fixture.js";
import { seedTask } from "../helpers/seed.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Two independent handles on one store, as two worktrees would have. */
function twoStores() {
  const repo = createGitRepo();
  cleanups.push(() => repo.cleanup());
  const a = openStore(repo.dir, { createIfMissing: true, actor: () => "a @ /wt-a" });
  const b = openStore(repo.dir, { actor: () => "b @ /wt-b" });
  cleanups.push(() => {
    a.store.close();
    b.store.close();
  });
  return { a: a.store, b: b.store };
}

function countTasks(store: { db: { prepare: (sql: string) => { get: () => unknown } } }): number {
  return (store.db.prepare("SELECT COUNT(*) c FROM tasks").get() as { c: number }).c;
}

describe("readTx", () => {
  it("shows every read inside one transaction the same snapshot", () => {
    // The reason board needs this at all: five queries that must add up to one
    // picture. Without a transaction each is its own implicit snapshot, and a
    // commit landing between the counts query and the ready query yields a
    // header that contradicts the rows beneath it.
    const { a, b } = twoStores();
    seedTask(a, { title: "first" });

    const seen = readTx(a.db, () => {
      // The read *before* the concurrent write is what pins the snapshot: a
      // deferred transaction takes no lock until its first access, so opening
      // one and then writing from B would leave nothing to be stale against.
      const before = countTasks(a);
      seedTask(b, { title: "written by the other worktree" });
      const after = countTasks(a);
      return { before, after };
    });

    expect(seen.before).toBe(1);
    expect(seen.after).toBe(1);
    // And the write really did land — otherwise this test passes because
    // nothing happened.
    expect(countTasks(a)).toBe(2);
  });

  it("does not block a concurrent writer", () => {
    // The property `.immediate()` would destroy, and the reason this is
    // deferred. `writeTx` takes the write lock up front precisely because
    // writers must serialise; a board read that did the same would make the
    // command the spec wants run constantly into a source of contention.
    const { a, b } = twoStores();

    expect(() =>
      readTx(a.db, () => {
        countTasks(a);
        seedTask(b, { title: "lands while a reader holds its snapshot" });
      }),
    ).not.toThrow();

    expect(countTasks(b)).toBe(1);
  });

  it("returns what its callback returns", () => {
    const { a } = twoStores();
    expect(readTx(a.db, () => "value")).toBe("value");
  });

  it("releases the snapshot when the callback throws", () => {
    // A transaction left open would hold a read snapshot forever, which stops
    // WAL checkpointing for the whole store — not just for this handle.
    const { a } = twoStores();

    expect(() =>
      readTx(a.db, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(a.db.inTransaction).toBe(false);
    expect(() => writeTx(a.db, () => seedTask(a, {}))).not.toThrow();
  });
});

describe("writes are refused inside a read transaction", () => {
  it("refuses appendEvent inside a read transaction", () => {
    // The trap this guard exists for. `appendEvent` refuses to run outside a
    // transaction by checking `db.inTransaction` — and a deferred read sets
    // that flag too, so before this marker existed the check passed and the
    // insert went on to attempt a snapshot upgrade. That is the SQLITE_BUSY
    // hazard `writeTx` is IMMEDIATE to avoid: measured across six concurrent
    // processes, the deferred default lost about a third of all writes.
    const { a } = twoStores();
    const task = seedTask(a, { title: "a task" });

    try {
      readTx(a.db, () =>
        appendEvent(
          a,
          { type: "created", entityId: task, epicId: null, actor: "a @ /wt-a" },
          "2026-01-01T00:00:00.000Z",
        ),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("internal");
      expect(error.message).toMatch(/read transaction/);
    }

    expect(a.db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 0 });
  });

  it("refuses writeTx nested inside a read transaction", () => {
    // Nesting turns it into a SAVEPOINT, which cannot upgrade the deferred read
    // it sits inside — the failure would surface as SQLITE_BUSY at commit,
    // far from the code that caused it.
    const { a } = twoStores();

    expect(() => readTx(a.db, () => writeTx(a.db, () => seedTask(a, {})))).toThrowError(
      /read transaction/,
    );
  });

  it("lets a write run once the read transaction has finished", () => {
    // The guard is scoped to the transaction, not sticky on the handle.
    const { a } = twoStores();
    readTx(a.db, () => countTasks(a));

    expect(() => writeTx(a.db, () => seedTask(a, { title: "after" }))).not.toThrow();
    expect(countTasks(a)).toBe(1);
  });

  it("keeps the guard accurate through nested read transactions", () => {
    // Board wraps its sections; a section helper wrapping its own reads is a
    // reasonable thing for someone to write later. The inner one must not
    // clear the marker on its way out.
    const { a } = twoStores();

    expect(() =>
      readTx(a.db, () => {
        readTx(a.db, () => countTasks(a));
        return writeTx(a.db, () => seedTask(a, {}));
      }),
    ).toThrowError(/read transaction/);
  });
});
