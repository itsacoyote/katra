import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimFor, claimTask } from "../../src/core/claims/repo.js";
import { readTx, writeTx } from "../../src/core/db/connection.js";
import type { EventType } from "../../src/core/enums.js";
import { TERMINAL_LANES } from "../../src/core/enums.js";
import { isKatraException } from "../../src/core/errors.js";
import { listEvents } from "../../src/core/events/repo.js";
import { addDependency, isReady } from "../../src/core/graph/deps.js";
import type { Move } from "../../src/core/tasks/lifecycle.js";
import {
  applyMoveWithin,
  cancelTask,
  closeTask,
  reopenTask,
} from "../../src/core/tasks/lifecycle.js";
import { getTask } from "../../src/core/tasks/repo.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { seedClaim, seedTask, seedTime } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture, OTHER_IDENTITY, openAs } from "../helpers/store.js";

/**
 * Lets one test fail the append of a single, named event type — everything
 * else passes through to the real `appendEvent` untouched. Both
 * `claims/repo.ts`'s `settleClaim` and this module's own `transition` share
 * `events/repo.js`, so gating on `event.type` (rather than call order) is
 * what lets the atomicity test fail *specifically* the lifecycle event
 * (`closed`) while leaving `settleClaim`'s own `released` append to succeed
 * on its own — the shape of failure that actually distinguishes "one shared
 * transaction" from "two separate ones" (see that test).
 */
const appendEventHook = vi.hoisted(() => ({ throwOnType: null as EventType | null }));
vi.mock("../../src/core/events/repo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/events/repo.js")>();
  const appendEvent: typeof original.appendEvent = (store, event, now) => {
    if (event.type === appendEventHook.throwOnType) {
      throw new Error(`forced failure appending "${event.type}", to prove atomicity`);
    }
    return original.appendEvent(store, event, now);
  };
  return { ...original, appendEvent };
});

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
  appendEventHook.throwOnType = null;
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

describe("applyMoveWithin", () => {
  it("applyMoveWithin moves the row to Done stamping the caller's at as closed_at and a distinct updatedAt, no event, no claim settlement", () => {
    const id = seedTask(fixture.store);
    seedClaim(fixture.store, { taskId: id, holder: "/repo/wt-ghost" });
    const at = seedTime(3_000);
    const updatedAt = seedTime(4_000);
    const move: Move = { lane: "Done", markClosed: true, reason: "shipped", event: "closed" };

    expect(() => applyMoveWithin(fixture.store, id, move, { at })).toThrowError(
      /inside an open transaction/,
    );

    writeTx(fixture.store.db, () => {
      applyMoveWithin(fixture.store, id, move, { at, updatedAt });
    });

    const task = getTask(fixture.store, id);
    expect(task?.lane).toBe("Done");
    expect(task?.closedAt).toBe(at);
    expect(task?.updatedAt).toBe(updatedAt);
    expect(task?.updatedAt).not.toBe(task?.closedAt);
    expect(task?.closeReason).toBe("shipped");
    // The seam does none of transition's other work: a pre-existing claim is
    // untouched, and no event was appended.
    expect(claimFor(fixture.store, id)).not.toBeNull();
    expect(listEvents(fixture.store, { entityId: id }).events).toEqual([]);
  });

  it("throws when called inside a read transaction", () => {
    // The other half of the transaction-required guard: `db.inTransaction` is
    // also true inside a deferred read, so only `assertNotReadOnly` catches
    // this — see its own docs (`db/connection.ts`) for why the plain
    // `inTransaction` check alone cannot.
    const id = seedTask(fixture.store);
    const move: Move = { lane: "Done", markClosed: true, reason: null, event: "closed" };

    expect(() =>
      readTx(fixture.store.db, () => applyMoveWithin(fixture.store, id, move, { at: seedTime() })),
    ).toThrowError(/read transaction/);
  });

  it("defaults updated_at to ctx.at when updatedAt is omitted", () => {
    const id = seedTask(fixture.store);
    const at = seedTime(6_000);
    const move: Move = { lane: "Done", markClosed: true, reason: null, event: "closed" };

    writeTx(fixture.store.db, () => {
      applyMoveWithin(fixture.store, id, move, { at });
    });

    expect(getTask(fixture.store, id)?.updatedAt).toBe(at);
  });

  it("throws not_found for an id that does not exist", () => {
    const move: Move = { lane: "Done", markClosed: true, reason: null, event: "closed" };

    expect(() =>
      writeTx(fixture.store.db, () =>
        applyMoveWithin(fixture.store, "kt-absent", move, { at: seedTime() }),
      ),
    ).toThrowError(/no task matches/);
  });

  it("throws internal when a Move marks closed into a non-terminal lane", () => {
    // A hand-built Move — the F5 loader's own use of this seam — could close
    // into a non-terminal lane; the schema's own CHECK only constrains the
    // converse (a terminal lane with no closed_at), so nothing else stops
    // this from writing closed_at onto a task the lane still calls active.
    const id = seedTask(fixture.store);
    const move: Move = { lane: "In Progress", markClosed: true, reason: null, event: "closed" };

    expect(() =>
      writeTx(fixture.store.db, () => applyMoveWithin(fixture.store, id, move, { at: seedTime() })),
    ).toThrowError(/terminal lane/);
  });
});

describe("transition", () => {
  it("close, cancel and reopen still behave byte-identically through the seam", () => {
    const closable = seedTask(fixture.store);
    const { task: closed } = closeTask(fixture.store, closable, "shipped");
    expect(closed.lane).toBe("Done");
    expect(closed.closeReason).toBe("shipped");
    expect(closed.closedAt).not.toBeNull();

    const cancellable = seedTask(fixture.store);
    const { task: cancelled } = cancelTask(fixture.store, cancellable, "dropped");
    expect(cancelled.lane).toBe("Cancelled");
    expect(cancelled.closeReason).toBe("dropped");
    expect(cancelled.closedAt).not.toBeNull();

    const { task: reopened } = reopenTask(fixture.store, cancellable);
    expect(reopened.lane).toBe("Defined");
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closeReason).toBeNull();
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

describe("claim settlement", () => {
  it("releases a claim and logs released when a claimed task closes", () => {
    const id = seedTask(fixture.store);
    const { claim } = claimTask(fixture.store, id);

    closeTask(fixture.store, id);

    expect(claimFor(fixture.store, id)).toBeNull();
    const events = listEvents(fixture.store, { entityId: id }).events;
    // Newest first: the lifecycle event lands after settleClaim's release.
    expect(events.map((e) => e.type)).toEqual(["closed", "released", "claimed"]);
    const released = events.find((e) => e.type === "released");
    expect(released?.priorActor).toBeNull();
    expect(released?.actor).toBe(claim.actor);
  });

  it("releases a claim and logs released when a claimed task is cancelled", () => {
    const id = seedTask(fixture.store);
    claimTask(fixture.store, id);

    cancelTask(fixture.store, id, "dropped");

    expect(claimFor(fixture.store, id)).toBeNull();
    const events = listEvents(fixture.store, { entityId: id }).events;
    expect(events.map((e) => e.type)).toEqual(["cancelled", "released", "claimed"]);
  });

  it("appends no released event on reopen", () => {
    // Claiming a terminal task is refused by `claimTask`'s own guard, so
    // "terminal and still claimed" is reached the way claims.test.ts reaches
    // its edge states — seeded directly, bypassing the guard — to prove
    // `reopen` leaves any claim it finds untouched, not merely one it cannot
    // reach through the normal claim path.
    const id = seedTask(fixture.store, { lane: "Done" });
    seedClaim(fixture.store, {
      taskId: id,
      holder: "/repo/wt-ghost",
      actor: "feature/ghost @ /repo/wt-ghost",
    });

    reopenTask(fixture.store, id);

    expect(claimFor(fixture.store, id)).not.toBeNull();
    expect(listEvents(fixture.store, { entityId: id }).events.map((e) => e.type)).toEqual([
      "reopened",
    ]);
  });

  it("records the displaced holder when a non-holder closes a claimed task", () => {
    const id = seedTask(fixture.store);
    const { claim } = claimTask(fixture.store, id);

    const other = openAs(fixture.repo.dir, OTHER_IDENTITY);
    try {
      closeTask(other, id);
    } finally {
      other.close();
    }

    expect(claimFor(fixture.store, id)).toBeNull();
    const events = listEvents(fixture.store, { entityId: id }).events;
    expect(events.map((e) => e.type)).toEqual(["closed", "released", "claimed"]);
    const released = events.find((e) => e.type === "released");
    // A non-holder settling the claim as a side effect of closing is a
    // takeover in every way that matters to the event stream, so it carries
    // the displaced holder exactly the way a forced release does.
    expect(released?.priorActor).toBe(claim.actor);
    expect(released?.actor).toBe(`${OTHER_IDENTITY.branch()} @ ${OTHER_IDENTITY.worktree}`);
  });

  it("appends no released event when the task was never claimed", () => {
    const id = seedTask(fixture.store);

    closeTask(fixture.store, id);

    expect(listEvents(fixture.store, { entityId: id }).events.map((e) => e.type)).toEqual([
      "closed",
    ]);
  });

  it("lands the lifecycle and released events atomically or not at all", () => {
    // Fails only the second write — the lifecycle event — after `settleClaim`
    // has already issued the claim's delete and its own `released` insert.
    // This proves the delete and the released insert share this
    // transaction's rollback with the lifecycle event. It does NOT catch a
    // nested `writeTx`: better-sqlite3 turns one into a SAVEPOINT that rolls
    // back with the outer transaction regardless (`events/repo.ts`'s
    // `appendEvent`, lines 214-219, documents the same trap). The guard
    // against `transition` ever reaching for `releaseTask` instead of
    // `settleClaim` — `releaseTask` opens its own top-level `writeTx`, which
    // would genuinely commit separately — is the identity-resolves-before-
    // the-write-lock spy test in `claims.test.ts`, extended to cover
    // close/cancel/reopen/delete.
    const id = seedTask(fixture.store);
    claimTask(fixture.store, id);

    appendEventHook.throwOnType = "closed";
    try {
      expect(() => closeTask(fixture.store, id)).toThrowError(/forced failure appending "closed"/);
    } finally {
      appendEventHook.throwOnType = null;
    }

    // Nothing committed: the lane never moved, the claim is still held, and
    // neither the released nor the closed event exists — the transaction that
    // wraps both rolled back as one.
    expect(getTask(fixture.store, id)?.lane).not.toBe("Done");
    expect(claimFor(fixture.store, id)).not.toBeNull();
    expect(listEvents(fixture.store, { entityId: id }).events.map((e) => e.type)).toEqual([
      "claimed",
    ]);
  });
});
