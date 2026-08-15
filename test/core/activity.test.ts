import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityJoin, readRecent, readStale } from "../../src/core/activity.js";
import { deleteTask } from "../../src/core/tasks/delete.js";
import { seedEpic, seedEvent, seedTask, seedTime } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

describe("readRecent orders by the event total order", () => {
  it("orders recent by the event total order, newest first", () => {
    // A later-timestamped event inserted *first* gets the lower event id; an
    // earlier-timestamped event inserted *second* gets the higher one.
    // Ordering by MAX(e.id) puts B first; ordering by MAX(created_at) would
    // put A first — the two disagree by construction, so this pins which
    // column the read actually uses.
    const taskA = seedTask(fixture.store, { title: "A", lane: "Planned" });
    const taskB = seedTask(fixture.store, { title: "B", lane: "Planned" });
    seedEvent(fixture.store, { entityId: taskA, createdAt: seedTime(2000) });
    seedEvent(fixture.store, { entityId: taskB, createdAt: seedTime(1000) });

    const result = readRecent(fixture.store);

    expect(result.hits.map((h) => h.id)).toEqual([taskB, taskA]);
  });

  it("moves an entity to the top of recent when a new event lands", () => {
    const a = seedTask(fixture.store, { title: "a", lane: "Planned" });
    const b = seedTask(fixture.store, { title: "b", lane: "Planned" });
    seedEvent(fixture.store, { entityId: a });
    seedEvent(fixture.store, { entityId: b });

    expect(readRecent(fixture.store).hits[0]?.id).toBe(b);

    seedEvent(fixture.store, { entityId: a });

    expect(readRecent(fixture.store).hits[0]?.id).toBe(a);
  });

  it("ranks epics alongside tasks in recent", () => {
    const epic = seedEpic(fixture.store, { lane: "Planned" });
    const task = seedTask(fixture.store, { lane: "Planned" });
    seedEvent(fixture.store, { entityId: task });
    seedEvent(fixture.store, { entityId: epic });

    const result = readRecent(fixture.store);

    expect(result.hits.map((h) => h.id)).toEqual([epic, task]);
    expect(result.hits[0]?.level).toBe("epic");
  });
});

describe("readStale's cutoff", () => {
  it("returns only non-terminal items strictly older than the cutoff in stale", () => {
    const cutoff = seedTime(5000);

    const staleAndOpen = seedTask(fixture.store, { lane: "Planned", title: "stale and open" });
    seedEvent(fixture.store, { entityId: staleAndOpen, createdAt: seedTime(1000) });

    const freshAndOpen = seedTask(fixture.store, { lane: "Planned", title: "fresh and open" });
    seedEvent(fixture.store, { entityId: freshAndOpen, createdAt: seedTime(9000) });

    const staleButDone = seedTask(fixture.store, { lane: "Done", title: "stale but done" });
    seedEvent(fixture.store, { entityId: staleButDone, createdAt: seedTime(1000) });

    const result = readStale(fixture.store, { olderThan: cutoff });

    expect(result.hits.map((h) => h.id)).toEqual([staleAndOpen]);
  });

  it("keeps the exact-boundary instant out of stale", () => {
    const cutoff = seedTime(5000);
    const boundary = seedTask(fixture.store, { lane: "Planned" });
    seedEvent(fixture.store, { entityId: boundary, createdAt: cutoff });

    const result = readStale(fixture.store, { olderThan: cutoff });

    expect(result.hits.map((h) => h.id)).not.toContain(boundary);
  });
});

describe("truncation", () => {
  it("reports truncation on both reads", () => {
    for (let i = 0; i < 4; i++) {
      const id = seedTask(fixture.store, { lane: "Planned", title: `task ${i}` });
      seedEvent(fixture.store, { entityId: id });
    }

    const recent = readRecent(fixture.store, { limit: 2 });
    expect(recent.hits).toHaveLength(2);
    expect(recent.truncated).toBe(true);

    const stale = readStale(fixture.store, { olderThan: seedTime(999_999), limit: 2 });
    expect(stale.hits).toHaveLength(2);
    expect(stale.truncated).toBe(true);
  });
});

describe("the ghost-event exclusion (ADR-008)", () => {
  it("excludes deleted tasks' surviving events from recent and stale", () => {
    // A cutoff far in real-world future, so the deleted task's `deleted`
    // event — stamped with the live clock, not seedTime's fixed epoch — would
    // still fall on the stale side of the window were it not for the
    // exclusion this test is about. A cutoff too close would let the test
    // pass merely because the ghost's activity happens to be too recent to
    // cross it, which would prove nothing.
    const farFutureCutoff = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();

    const task = seedTask(fixture.store, { lane: "Planned" });
    seedEvent(fixture.store, { entityId: task, type: "created" });
    seedEvent(fixture.store, { entityId: task, type: "status-changed" });

    deleteTask(fixture.store, task);

    const recent = readRecent(fixture.store);
    expect(recent.hits.map((h) => h.id)).not.toContain(task);

    const stale = readStale(fixture.store, { olderThan: farFutureCutoff });
    expect(stale.hits.map((h) => h.id)).not.toContain(task);
  });
});

describe("activityJoin", () => {
  it("keeps event-less tasks with null activity when joined outer", () => {
    const withEvent = seedTask(fixture.store, { lane: "Planned" });
    seedEvent(fixture.store, { entityId: withEvent });
    const eventless = seedTask(fixture.store, { lane: "Planned" });

    const join = activityJoin({ outer: true });
    const rows = fixture.store.db
      .prepare(`SELECT t.id AS id, a.last_activity AS last_activity FROM tasks t ${join.sql}`)
      .all(...join.params) as Array<{ id: string; last_activity: string | null }>;

    const eventlessRow = rows.find((row) => row.id === eventless);
    expect(eventlessRow).toBeDefined();
    expect(eventlessRow?.last_activity).toBeNull();

    const withEventRow = rows.find((row) => row.id === withEvent);
    expect(withEventRow?.last_activity).not.toBeNull();
  });

  it("excludes event-less tasks when joined inner", () => {
    const withEvent = seedTask(fixture.store, { lane: "Planned" });
    seedEvent(fixture.store, { entityId: withEvent });
    const eventless = seedTask(fixture.store, { lane: "Planned" });

    const join = activityJoin({ outer: false });
    const rows = fixture.store.db
      .prepare(`SELECT t.id AS id FROM tasks t ${join.sql}`)
      .all(...join.params) as Array<{ id: string }>;

    expect(rows.map((row) => row.id)).toContain(withEvent);
    expect(rows.map((row) => row.id)).not.toContain(eventless);
  });
});
