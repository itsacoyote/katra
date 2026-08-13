/**
 * `loadMigration` — the one-transaction historical write (F5, T6,
 * `katra-9aw.49.6`).
 *
 * Every test here builds a `MigrationPlan` by hand rather than going through
 * `planMigration` (T5, covered by `beads-transform.test.ts`): `load.ts`'s own
 * contract is "given a plan, write exactly this," and testing it against a
 * hand-built plan keeps these tests independent of transform's own decisions
 * — including the atomicity test, whose whole point is a plan `transform.ts`
 * would never actually produce (T6 body: "any exception escaping load [on a
 * transform-clean plan] is a bug, not a report item").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "../../src/core/actor.js";
import type { LoadResult } from "../../src/core/beads/load.js";
import { loadMigration } from "../../src/core/beads/load.js";
import type {
  MigrationPlan,
  PlannedEdge,
  PlannedEvent,
  PlannedItem,
  PlannedNote,
} from "../../src/core/beads/types.js";
import { isKatraException } from "../../src/core/errors.js";
import { listEvents } from "../../src/core/events/repo.js";
import { listDependencies } from "../../src/core/graph/deps.js";
import { listLinks } from "../../src/core/graph/links.js";
import { getTask } from "../../src/core/tasks/repo.js";
import { seedTask, seedTime } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

/**
 * Records every call `load.ts` makes to the two seams the "closed items"
 * choreography (T6 body, step 2) is pinned on, without changing their
 * behaviour — the same `vi.mock` + `vi.hoisted` shape `lifecycle.test.ts`
 * uses to gate `appendEvent`. Needed because the *outcome* of a correctly
 * closed item (final lane `Done`, `closed_at` set) is reachable by more than
 * one implementation — including a raw post-hoc `UPDATE` the task body
 * explicitly forbids — and only watching the calls themselves distinguishes
 * "created into `Defined`, then moved" from "created directly into `Done`"
 * (which `createTaskWithin`'s own guard would refuse) or a bypass.
 */
const seamSpy = vi.hoisted(() => ({
  createTaskCalls: [] as Array<{ readonly title: string; readonly lane: string }>,
  moveCalls: [] as Array<{
    readonly lane: string;
    readonly markClosed: boolean;
    readonly reason: string | null;
  }>,
}));

vi.mock("../../src/core/tasks/repo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/tasks/repo.js")>();
  const createTaskWithin: typeof original.createTaskWithin = (store, input, ctx) => {
    seamSpy.createTaskCalls.push({ title: input.title, lane: input.lane ?? "Defined" });
    return original.createTaskWithin(store, input, ctx);
  };
  return { ...original, createTaskWithin };
});

vi.mock("../../src/core/tasks/lifecycle.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/tasks/lifecycle.js")>();
  const applyMoveWithin: typeof original.applyMoveWithin = (store, taskId, move, ctx) => {
    seamSpy.moveCalls.push({ lane: move.lane, markClosed: move.markClosed, reason: move.reason });
    return original.applyMoveWithin(store, taskId, move, ctx);
  };
  return { ...original, applyMoveWithin };
});

/** A fixed identity for the *migrating* process — distinct from the store fixture's own. */
const MIGRATING_IDENTITY: Identity = { worktree: "/repo/migrator", branch: () => "migrate/beads" };
/** `actorFromIdentity(MIGRATING_IDENTITY)`, spelled out per ADR-007's `<branch> @ <path>` format. */
const MIGRATING_ACTOR = "migrate/beads @ /repo/migrator";

/** The minimal planned item: every required {@link PlannedItem} field, nothing optional left implicit. */
function makeItem(overrides: Partial<PlannedItem> & { readonly oldId: string }): PlannedItem {
  return {
    level: "task",
    kind: "feat",
    title: `Item ${overrides.oldId}`,
    description: null,
    lane: "Defined",
    priority: 2,
    assignee: null,
    parentOldId: null,
    tags: [],
    createdAt: seedTime(0),
    updatedAt: seedTime(0),
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

function makePlan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  return { items: [], notes: [], edges: [], events: [], ...overrides };
}

/** Looks up a minted id by the plan's old id, or fails the test with a clear message. */
function newIdOf(result: LoadResult, oldId: string): string {
  const entry = result.idMap.find((e) => e.oldId === oldId);
  if (entry?.newId == null) throw new Error(`loadMigration minted no id for "${oldId}"`);
  return entry.newId;
}

const countRows = (store: StoreFixture["store"], table: string): number =>
  (store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
  seamSpy.createTaskCalls.length = 0;
  seamSpy.moveCalls.length = 0;
});
afterEach(() => fixture.cleanup());

describe("loadMigration", () => {
  it("refuses a store that already contains any task with conflict before writing", () => {
    seedTask(fixture.store, { title: "already here" });
    const plan = makePlan({ items: [makeItem({ oldId: "b-1" })] });

    try {
      loadMigration(fixture.store, plan, MIGRATING_IDENTITY);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("conflict");
    }

    // Nothing from the plan landed — just the one task seeded before the call.
    expect(countRows(fixture.store, "tasks")).toBe(1);
  });

  it("loads epics before tasks so parents always pre-exist", () => {
    // Deliberately listed task-before-epic: `plan.items` is not itself
    // sorted this way (transform.ts emits input order), so a load.ts that
    // trusted that order would try to resolve "epic-1" as a parent before
    // it exists.
    const plan = makePlan({
      items: [
        makeItem({ oldId: "task-1", level: "task", parentOldId: "epic-1", title: "Task" }),
        makeItem({ oldId: "epic-1", level: "epic", title: "Epic" }),
      ],
    });

    const result = loadMigration(fixture.store, plan, MIGRATING_IDENTITY);

    const epicId = newIdOf(result, "epic-1");
    const taskId = newIdOf(result, "task-1");
    expect(getTask(fixture.store, taskId)?.parentId).toBe(epicId);
  });

  it("creates closed items in Defined and closes them through the move seam rather than creating into a terminal lane", () => {
    const plan = makePlan({
      items: [
        makeItem({
          oldId: "closed-1",
          title: "Closed item",
          lane: "Done",
          createdAt: seedTime(0),
          updatedAt: seedTime(1_000),
          closedAt: seedTime(2_000),
          closeReason: "shipped",
        }),
      ],
    });

    loadMigration(fixture.store, plan, MIGRATING_IDENTITY);

    expect(seamSpy.createTaskCalls).toEqual([{ title: "Closed item", lane: "Defined" }]);
    expect(seamSpy.moveCalls).toEqual([{ lane: "Done", markClosed: true, reason: "shipped" }]);
  });

  it("stamps beads' historical created_at, updated_at and closed_at on migrated rows", () => {
    const createdAt = seedTime(0);
    const updatedAt = seedTime(5_000);
    const closedAt = seedTime(9_000);
    const plan = makePlan({
      items: [
        makeItem({
          oldId: "closed-2",
          lane: "Done",
          createdAt,
          updatedAt,
          closedAt,
          closeReason: "done",
        }),
      ],
    });

    const result = loadMigration(fixture.store, plan, MIGRATING_IDENTITY);
    const task = getTask(fixture.store, newIdOf(result, "closed-2"));

    expect(task?.createdAt).toBe(createdAt);
    expect(task?.updatedAt).toBe(updatedAt);
    expect(task?.closedAt).toBe(closedAt);
    expect(task?.closeReason).toBe("done");
  });

  it("round-trips an open item's distinct updated_at", () => {
    const createdAt = seedTime(0);
    const updatedAt = seedTime(4_000); // later than createdAt, on a never-closed item
    const plan = makePlan({
      items: [makeItem({ oldId: "open-1", lane: "In Progress", createdAt, updatedAt })],
    });

    const result = loadMigration(fixture.store, plan, MIGRATING_IDENTITY);
    const task = getTask(fixture.store, newIdOf(result, "open-1"));

    expect(task?.createdAt).toBe(createdAt);
    expect(task?.updatedAt).toBe(updatedAt);
    expect(task?.lane).toBe("In Progress");
    expect(task?.closedAt).toBeNull();
  });

  it("appends all events after all rows, in the plan's chronological order, ids monotone with time", () => {
    const epic = makeItem({
      oldId: "epic-x",
      level: "epic",
      title: "Epic X",
      createdAt: seedTime(0),
    });
    const task = makeItem({
      oldId: "task-x",
      level: "task",
      parentOldId: "epic-x",
      title: "Task X",
      createdAt: seedTime(10),
    });

    // Listed task-before-epic — the opposite of row-creation order (epics
    // first). A load.ts that appended each item's `created` event while
    // creating its row, instead of collecting every event into one final
    // pass over `plan.events`, would produce the epic's event id first;
    // this plan says the task's event must land first.
    const events: PlannedEvent[] = [
      { type: "created", itemOldId: "task-x", at: seedTime(10), title: "Task X" },
      { type: "created", itemOldId: "epic-x", at: seedTime(0), title: "Epic X" },
    ];

    const plan = makePlan({ items: [epic, task], events });

    loadMigration(fixture.store, plan, MIGRATING_IDENTITY);

    const { events: stored } = listEvents(fixture.store, { limit: 10 });
    const chronological = [...stored].reverse(); // listEvents is newest-first

    expect(chronological.map((e) => e.title)).toEqual(["Task X", "Epic X"]);
    const ids = chronological.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stamps the migrating actor on created/closed events and the beads author on note-added events and notes", () => {
    const beadsAuthor = "alice @ original-machine";
    const item = makeItem({
      oldId: "item-1",
      title: "Item item-1",
      lane: "Done",
      createdAt: seedTime(0),
      updatedAt: seedTime(10),
      closedAt: seedTime(20),
      closeReason: "shipped",
    });
    const note: PlannedNote = {
      id: "note-1",
      itemOldId: "item-1",
      kind: "general",
      body: "a migrated comment",
      actor: beadsAuthor,
      createdAt: seedTime(5),
    };
    const events: PlannedEvent[] = [
      { type: "created", itemOldId: "item-1", at: seedTime(0), title: "Item item-1" },
      {
        type: "note-added",
        itemOldId: "item-1",
        at: seedTime(5),
        noteRef: "note-1",
        actor: beadsAuthor,
      },
      { type: "closed", itemOldId: "item-1", at: seedTime(20), reason: "shipped" },
    ];

    const plan = makePlan({ items: [item], notes: [note], events });

    const result = loadMigration(fixture.store, plan, MIGRATING_IDENTITY);

    const { events: stored } = listEvents(fixture.store, { limit: 10 });
    const chronological = [...stored].reverse();
    expect(chronological.map((e) => ({ type: e.type, actor: e.actor }))).toEqual([
      { type: "created", actor: MIGRATING_ACTOR },
      { type: "note-added", actor: beadsAuthor },
      { type: "closed", actor: MIGRATING_ACTOR },
    ]);

    const noteRow = fixture.store.db
      .prepare("SELECT actor FROM notes WHERE task_id = ?")
      .get(newIdOf(result, "item-1")) as { actor: string };
    expect(noteRow.actor).toBe(beadsAuthor);
  });

  it("canonicalizes link endpoints after id remapping", () => {
    const itemA = makeItem({ oldId: "link-a", title: "Link A" });
    const itemB = makeItem({ oldId: "link-b", title: "Link B" });
    // Old-id order reversed relative to the edge below, so this cannot pass
    // by accident of the old ids already sorting the way the edge lists them.
    const edges: PlannedEdge[] = [
      { kind: "link", aOldId: "link-b", bOldId: "link-a", createdAt: seedTime(5) },
    ];
    const plan = makePlan({ items: [itemA, itemB], edges });

    const result = loadMigration(fixture.store, plan, MIGRATING_IDENTITY);
    const newA = newIdOf(result, "link-a");
    const newB = newIdOf(result, "link-b");

    const row = fixture.store.db.prepare("SELECT a_id, b_id FROM links").get() as {
      a_id: string;
      b_id: string;
    };
    expect(row.a_id < row.b_id).toBe(true);
    expect([row.a_id, row.b_id].sort()).toEqual([newA, newB].sort());

    expect(listLinks(fixture.store, newA).map((l) => l.id)).toEqual([newB]);
    expect(listLinks(fixture.store, newB).map((l) => l.id)).toEqual([newA]);
  });

  it("preserves dependency edges' own historical created_at", () => {
    const blocker = makeItem({ oldId: "dep-blocker", title: "Blocker" });
    const blocked = makeItem({ oldId: "dep-blocked", title: "Blocked" });
    const edgeCreatedAt = seedTime(777);
    const edges: PlannedEdge[] = [
      {
        kind: "dependency",
        taskOldId: "dep-blocked",
        dependsOnOldId: "dep-blocker",
        createdAt: edgeCreatedAt,
      },
    ];
    const plan = makePlan({ items: [blocker, blocked], edges });

    const result = loadMigration(fixture.store, plan, MIGRATING_IDENTITY);
    const newBlockedId = newIdOf(result, "dep-blocked");
    const newBlockerId = newIdOf(result, "dep-blocker");

    const row = fixture.store.db
      .prepare("SELECT created_at FROM deps WHERE task_id = ? AND depends_on_id = ?")
      .get(newBlockedId, newBlockerId) as { created_at: string };
    expect(row.created_at).toBe(edgeCreatedAt);
    expect(listDependencies(fixture.store, newBlockedId).map((d) => d.id)).toEqual([newBlockerId]);
  });

  it("rolls back everything when an insert fails mid-load", () => {
    const item = makeItem({ oldId: "poison-item", title: "Poisoned" });
    const note: PlannedNote = {
      id: "note-1",
      itemOldId: "poison-item",
      kind: "general",
      body: "a note that should vanish with everything else",
      actor: "author @ x",
      createdAt: seedTime(1),
    };
    // Poison: a dependency edge whose `dependsOnOldId` names no item in the
    // plan at all. `transform.ts` dangling-checks every edge against its own
    // accepted-item set, so it would never actually hand this to load.ts —
    // built by hand here purely to force a failure partway through step 3,
    // after the item and note rows above have already been written, so a
    // rollback that only undid the edge itself would leave those behind.
    const edges: PlannedEdge[] = [
      {
        kind: "dependency",
        taskOldId: "poison-item",
        dependsOnOldId: "ghost-item",
        createdAt: seedTime(2),
      },
    ];

    const plan = makePlan({ items: [item], notes: [note], edges });

    expect(() => loadMigration(fixture.store, plan, MIGRATING_IDENTITY)).toThrow();

    for (const table of ["tasks", "tags", "notes", "deps", "links", "events"]) {
      expect(countRows(fixture.store, table)).toBe(0);
    }
  });
});
