import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TERMINAL_LANES } from "../../src/core/enums.js";
import { isKatraException } from "../../src/core/errors.js";
import { addDependency, isReady } from "../../src/core/graph/deps.js";
import { cancelTask, closeTask, reopenTask } from "../../src/core/tasks/lifecycle.js";
import { getTask } from "../../src/core/tasks/repo.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

describe("closeTask", () => {
  it("sets the lane to Done and records closed_at", () => {
    const id = seedTask(fixture.store);

    const { task } = closeTask(fixture.store, id);

    expect(task.lane).toBe("Done");
    expect(task.closedAt).not.toBeNull();
  });

  it("records a reason when one is given", () => {
    const id = seedTask(fixture.store);
    expect(closeTask(fixture.store, id, "shipped").task.closeReason).toBe("shipped");
  });

  it("refuses to close an already-closed task", () => {
    const id = seedTask(fixture.store);
    closeTask(fixture.store, id);

    try {
      closeTask(fixture.store, id);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      // A conflict, not a validation failure: the request is well-formed, the
      // current state refuses it.
      expect(error.detail.code).toBe("conflict");
    }
  });

  it("refuses to close a cancelled task", () => {
    const id = seedTask(fixture.store);
    cancelTask(fixture.store, id, "dropped");

    expect(() => closeTask(fixture.store, id)).toThrowError(/already Cancelled/);
  });
});

describe("cancelTask", () => {
  it("sets the lane to Cancelled and records the reason", () => {
    const id = seedTask(fixture.store);

    const { task } = cancelTask(fixture.store, id, "superseded by kt-2a1");

    expect(task.lane).toBe("Cancelled");
    expect(task.closedAt).not.toBeNull();
    expect(task.closeReason).toBe("superseded by kt-2a1");
  });

  it("lists the tasks that became ready as a result", () => {
    // The ADR-003 payoff, through the real cancel path rather than a seeded
    // lane value: abandoning a blocker must release what it was blocking, and
    // say so.
    const blocker = seedTask(fixture.store, { title: "the blocker" });
    const first = seedTask(fixture.store, { title: "first dependent" });
    const second = seedTask(fixture.store, { title: "second dependent" });
    addDependency(fixture.store, first, blocker);
    addDependency(fixture.store, second, blocker);

    expect(isReady(fixture.store, first)).toBe(false);

    const { unblocked } = cancelTask(fixture.store, blocker, "not doing this");

    expect(unblocked.map((task) => task.title).sort()).toEqual([
      "first dependent",
      "second dependent",
    ]);
    expect(isReady(fixture.store, first)).toBe(true);
    expect(isReady(fixture.store, second)).toBe(true);
  });

  it("reports only the dependents it actually released", () => {
    const blocker = seedTask(fixture.store);
    const other = seedTask(fixture.store, { title: "still blocked elsewhere" });
    const alsoBlocking = seedTask(fixture.store, { lane: "In Progress" });
    addDependency(fixture.store, other, blocker);
    addDependency(fixture.store, other, alsoBlocking);

    const { unblocked } = cancelTask(fixture.store, blocker, "dropped");

    // Still waiting on the other blocker, so it was not released.
    expect(unblocked).toEqual([]);
    expect(isReady(fixture.store, other)).toBe(false);
  });

  it("reports nothing when the task blocked nothing", () => {
    const id = seedTask(fixture.store);
    expect(cancelTask(fixture.store, id, "dropped").unblocked).toEqual([]);
  });

  it("refuses to cancel an already-terminal task", () => {
    const id = seedTask(fixture.store);
    closeTask(fixture.store, id);

    expect(() => cancelTask(fixture.store, id, "too late")).toThrowError(/already Done/);
  });
});

describe("closeTask releases dependents too", () => {
  it("reports what finishing the work unblocked", () => {
    const blocker = seedTask(fixture.store);
    const dependent = seedTask(fixture.store, { title: "was waiting" });
    addDependency(fixture.store, dependent, blocker);

    expect(closeTask(fixture.store, blocker).unblocked.map((t) => t.title)).toEqual([
      "was waiting",
    ]);
  });
});

describe("reopenTask", () => {
  it("returns a cancelled task to the Defined lane on reopen", () => {
    // "some non-terminal lane" is satisfied by all five, which makes it
    // untestable; the default is named instead.
    const id = seedTask(fixture.store);
    cancelTask(fixture.store, id, "dropped");

    const { task } = reopenTask(fixture.store, id);

    expect(task.lane).toBe("Defined");
  });

  it("clears closed_at and close_reason", () => {
    const id = seedTask(fixture.store);
    closeTask(fixture.store, id, "finished");

    const { task } = reopenTask(fixture.store, id);

    expect(task.closedAt).toBeNull();
    expect(task.closeReason).toBeNull();
  });

  it("accepts another active lane", () => {
    const id = seedTask(fixture.store);
    closeTask(fixture.store, id);

    expect(reopenTask(fixture.store, id, "In Progress").task.lane).toBe("In Progress");
  });

  it("refuses a terminal lane on reopen", () => {
    // Otherwise reopen becomes a second path into a terminal lane, bypassing
    // close and cancel exactly as `update --lane Done` would have.
    const id = seedTask(fixture.store);
    closeTask(fixture.store, id);

    for (const lane of TERMINAL_LANES) {
      expect(() => reopenTask(fixture.store, id, lane)).toThrowError(/reopen cannot move/);
    }
    expect(getTask(fixture.store, id)?.lane).toBe("Done");
  });

  it("refuses to reopen a task that is already active", () => {
    const id = seedTask(fixture.store, { lane: "Planned" });

    try {
      reopenTask(fixture.store, id);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("conflict");
      expect(error.message).toMatch(/nothing to reopen/);
    }
  });

  it("blocks its dependents again", () => {
    const blocker = seedTask(fixture.store);
    const dependent = seedTask(fixture.store);
    addDependency(fixture.store, dependent, blocker);
    closeTask(fixture.store, blocker);
    expect(isReady(fixture.store, dependent)).toBe(true);

    reopenTask(fixture.store, blocker);

    expect(isReady(fixture.store, dependent)).toBe(false);
  });
});

describe("concurrent writers", () => {
  it("lets exactly one of two processes close the same task", { timeout: 60_000 }, async () => {
    // The guard and the write have to share a transaction. Guarded outside
    // it, both processes read a non-terminal lane, both pass
    // refuseIfTerminal, and both write — so the second close silently
    // overwrites the first's timestamp and reason, and neither caller is
    // told. BEGIN IMMEDIATE protects the write; it does not protect the
    // decision to write.
    const id = seedTask(fixture.store, { id: "kt-race01" });
    const modules = {
      store: new URL("../../src/core/store.ts", import.meta.url).href,
      lifecycle: new URL("../../src/core/tasks/lifecycle.ts", import.meta.url).href,
    };

    const outcomes = await runConcurrent<{ ok: boolean; conflict: boolean }>({
      count: 2,
      source: `
        const { openStore } = await import(${JSON.stringify(modules.store)});
        const { closeTask } = await import(${JSON.stringify(modules.lifecycle)});
        const { store } = openStore(${JSON.stringify(fixture.repo.dir)}, {});
        barrier();
        let ok = false, conflict = false;
        try { closeTask(store, ${JSON.stringify(id)}, "closed by " + INDEX); ok = true; }
        catch (e) { conflict = /already/i.test(String(e && e.message)); }
        store.close();
        report({ ok, conflict });
      `,
    });

    const results = outcomes.map((o) => o.value).filter((v) => v !== undefined);
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.conflict)).toHaveLength(1);

    // And the surviving row is the winner's, not a blend of both.
    const task = getTask(fixture.store, id);
    expect(task?.lane).toBe("Done");
    expect(task?.closeReason).toMatch(/^closed by [01]$/);
  });
});

describe("reopen reports what it took away", () => {
  it("names the dependents it blocked again", () => {
    // The module's own contract says every transition reports the readiness it
    // changed. `reopen` changes it in the opposite direction and used to say
    // nothing, so an agent reviving a blocker was never told that work it was
    // about to start had just become unstartable.
    const blocker = seedTask(fixture.store, { title: "the blocker" });
    const waiter = seedTask(fixture.store, { title: "was startable" });
    addDependency(fixture.store, waiter, blocker);
    closeTask(fixture.store, blocker);
    expect(isReady(fixture.store, waiter)).toBe(true);

    const { unblocked, reblocked } = reopenTask(fixture.store, blocker);

    expect(unblocked).toEqual([]);
    expect(reblocked.map((task) => task.title)).toEqual(["was startable"]);
  });

  it("reports nothing re-blocked when the dependent was already stuck elsewhere", () => {
    const blocker = seedTask(fixture.store, { title: "one blocker" });
    const other = seedTask(fixture.store, { title: "another blocker", lane: "In Progress" });
    const waiter = seedTask(fixture.store, { title: "doubly blocked" });
    addDependency(fixture.store, waiter, blocker);
    addDependency(fixture.store, waiter, other);
    closeTask(fixture.store, blocker);

    expect(reopenTask(fixture.store, blocker).reblocked).toEqual([]);
  });

  it("leaves close and cancel reporting nothing re-blocked", () => {
    const blocker = seedTask(fixture.store);
    const waiter = seedTask(fixture.store);
    addDependency(fixture.store, waiter, blocker);

    expect(closeTask(fixture.store, blocker).reblocked).toEqual([]);
    expect(reopenTask(fixture.store, blocker).unblocked).toEqual([]);
    expect(cancelTask(fixture.store, blocker, "dropped").reblocked).toEqual([]);
  });
});
