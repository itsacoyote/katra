/**
 * `loadMigration` — the one-transaction historical write (F5, T6,
 * `katra-9aw.49.6`).
 *
 * Most tests here build a `MigrationPlan` by hand rather than going through
 * `planMigration` (T5, covered by `beads-transform.test.ts`): `load.ts`'s own
 * contract is "given a plan, write exactly this," and testing it against a
 * hand-built plan keeps these tests independent of transform's own decisions
 * — including the atomicity test, whose whole point is a plan `transform.ts`
 * would never actually produce (T6 body: "any exception escaping load [on a
 * transform-clean plan] is a bug, not a report item"). The "loadMigration +
 * planMigration pairing" describe block below is the deliberate exception:
 * it runs a real, hostile `BeadsExtract` through the real `planMigration`
 * and feeds the resulting plan straight into `loadMigration`, to prove the
 * two stages actually agree at the seam — a transform-passed plan loads with
 * zero write-path exceptions, which no hand-built-plan test can discharge on
 * its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "../../src/core/actor.js";
import type { BeadsExtract } from "../../src/core/beads/extract.js";
import type { LoadResult } from "../../src/core/beads/load.js";
import { loadMigration } from "../../src/core/beads/load.js";
import { planMigration } from "../../src/core/beads/transform.js";
import type {
  BeadsComment,
  BeadsDependency,
  BeadsIssue,
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

const countRows = (
  store: { db: { prepare: (sql: string) => { get: () => unknown } } },
  table: string,
): number => (store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

const ROLLBACK_TABLES = ["tasks", "tags", "notes", "deps", "links", "events"] as const;

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

/**
 * Snapshots row counts across every table `loadMigration` writes to,
 * immediately after each event `appendEvent` actually commits — taken from
 * *inside* the still-open transaction, which is the only vantage point that
 * can see uncommitted writes at all. Backs the rollback test's non-vacuity
 * proof (T6-review fix #3): disabling `writeTx`'s own rollback to inspect
 * mid-transaction state from outside is not a real option (it would test a
 * different, broken implementation, not this one), so the alternative is to
 * capture the state from the inside, at the last point before the poison
 * throws, and separately confirm every count reads zero again once the
 * exception has propagated and the transaction has actually rolled back.
 */
const rollbackSpy = vi.hoisted(() => ({
  lastSnapshot: null as Record<string, number> | null,
}));

vi.mock("../../src/core/events/repo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/events/repo.js")>();
  const appendEvent: typeof original.appendEvent = (store, event, now) => {
    const id = original.appendEvent(store, event, now);
    const snapshot: Record<string, number> = {};
    for (const table of ROLLBACK_TABLES) snapshot[table] = countRows(store, table);
    rollbackSpy.lastSnapshot = snapshot;
    return id;
  };
  return { ...original, appendEvent };
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

/** The minimal bd issue for the pairing test's hostile fixture — mirrors `beads-transform.test.ts`'s own `makeIssue`. */
function pairIssue(overrides: Partial<BeadsIssue> & { readonly id: string }): BeadsIssue {
  return {
    title: `Issue ${overrides.id}`,
    description: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: "",
    created_at: seedTime(0),
    created_by: "",
    updated_at: seedTime(0),
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    ...overrides,
  };
}

function pairEdge(issueId: string, dependsOnId: string, type: string): BeadsDependency {
  return { issue_id: issueId, depends_on_id: dependsOnId, type, created_at: seedTime(0) };
}

function pairComment(issueId: string, text: string): BeadsComment {
  return { id: `${issueId}:c1`, issue_id: issueId, author: "bob", text, created_at: seedTime(0) };
}

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
  seamSpy.createTaskCalls.length = 0;
  seamSpy.moveCalls.length = 0;
  rollbackSpy.lastSnapshot = null;
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
    const itemA = makeItem({
      oldId: "item-a",
      title: "Item A",
      lane: "Done",
      createdAt: seedTime(0),
      updatedAt: seedTime(0),
      closedAt: seedTime(40),
      closeReason: "done a",
    });
    const itemB = makeItem({
      oldId: "item-b",
      title: "Item B",
      lane: "Done",
      createdAt: seedTime(10),
      updatedAt: seedTime(10),
      closedAt: seedTime(30),
      closeReason: "done b",
    });
    const note: PlannedNote = {
      id: "note-a",
      itemOldId: "item-a",
      kind: "general",
      body: "a note on A",
      actor: "author @ x",
      createdAt: seedTime(20),
    };

    // Interleaved by item AND type, in true chronological order: A opens,
    // B opens, A gets a note, B closes, A closes. `plan.items` lists B
    // before A — the opposite of this event sequence's first appearance of
    // each item — so a load.ts that fired `created` events while creating
    // each row, instead of collecting every event into one final pass over
    // `plan.events`, would put B's `created` event before A's here.
    const events: PlannedEvent[] = [
      { type: "created", itemOldId: "item-a", at: seedTime(0), title: "Item A" },
      { type: "created", itemOldId: "item-b", at: seedTime(10), title: "Item B" },
      {
        type: "note-added",
        itemOldId: "item-a",
        at: seedTime(20),
        noteRef: "note-a",
        actor: "author @ x",
      },
      { type: "closed", itemOldId: "item-b", at: seedTime(30), reason: "done b" },
      { type: "closed", itemOldId: "item-a", at: seedTime(40), reason: "done a" },
    ];

    const plan = makePlan({ items: [itemB, itemA], notes: [note], events });

    const result = loadMigration(fixture.store, plan, MIGRATING_IDENTITY);
    const oldIdByNewId = new Map(result.idMap.map((entry) => [entry.newId, entry.oldId]));

    const { events: stored } = listEvents(fixture.store, { limit: 10 });
    const chronological = [...stored].reverse(); // listEvents is newest-first

    expect(
      chronological.map((e) => ({ type: e.type, itemOldId: oldIdByNewId.get(e.entityId) })),
    ).toEqual([
      { type: "created", itemOldId: "item-a" },
      { type: "created", itemOldId: "item-b" },
      { type: "note-added", itemOldId: "item-a" },
      { type: "closed", itemOldId: "item-b" },
      { type: "closed", itemOldId: "item-a" },
    ]);

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

  it("rolls back everything when a plan reference cannot be resolved mid-load", () => {
    const item1 = makeItem({
      oldId: "rollback-1",
      title: "Rollback One",
      tags: ["migrated", "beads:rollback-1"],
    });
    const item2 = makeItem({ oldId: "rollback-2", title: "Rollback Two" });
    const note: PlannedNote = {
      id: "note-1",
      itemOldId: "rollback-1",
      kind: "general",
      body: "a note that should vanish with everything else",
      actor: "author @ x",
      createdAt: seedTime(1),
    };
    const edges: PlannedEdge[] = [
      {
        kind: "dependency",
        taskOldId: "rollback-1",
        dependsOnOldId: "rollback-2",
        createdAt: seedTime(2),
      },
      { kind: "link", aOldId: "rollback-1", bOldId: "rollback-2", createdAt: seedTime(3) },
    ];
    // Poison: a `note-added` event whose `noteRef` names no planned note at
    // all, placed after a valid `created` event for each item — so every
    // other table (tasks, tags, notes, deps, links, events) already has real
    // rows by the time this throws, and a rollback that only undid the
    // failed event itself would leave every one of them behind.
    const events: PlannedEvent[] = [
      { type: "created", itemOldId: "rollback-1", at: seedTime(4), title: "Rollback One" },
      { type: "created", itemOldId: "rollback-2", at: seedTime(5), title: "Rollback Two" },
      {
        type: "note-added",
        itemOldId: "rollback-1",
        at: seedTime(6),
        noteRef: "ghost-note",
        actor: "author @ x",
      },
    ];

    const plan = makePlan({ items: [item1, item2], notes: [note], edges, events });

    try {
      loadMigration(fixture.store, plan, MIGRATING_IDENTITY);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("internal");
    }

    // Non-vacuity: right before the poison threw, every one of the six
    // tables genuinely had rows — proving there was something real for the
    // rollback below to actually undo, not just an empty transaction.
    const preThrow = rollbackSpy.lastSnapshot;
    expect(preThrow).not.toBeNull();
    for (const table of ROLLBACK_TABLES) {
      expect(preThrow?.[table], `expected ${table} to have rows before the throw`).toBeGreaterThan(
        0,
      );
    }

    // And now that the exception has propagated out of loadMigration and
    // writeTx has rolled back, every one of those same tables reads zero.
    for (const table of ROLLBACK_TABLES) {
      expect(countRows(fixture.store, table)).toBe(0);
    }
  });
});

describe("loadMigration + planMigration pairing", () => {
  it("loads a transform-passed plan through every pre-classification path with zero write-path exceptions", () => {
    const issues: BeadsIssue[] = [
      // Empty-title issue — excluded entirely by transform's title-trim gate.
      pairIssue({ id: "empty-title", title: "   " }),

      // Three-level hierarchy: epic -> mid -> grandchild. Grandchild gets
      // reparented directly onto the epic (two-level flattening).
      pairIssue({ id: "epic-root", issue_type: "epic", title: "Epic Root" }),
      pairIssue({
        id: "mid-task",
        title: "Mid Task",
        dependencies: [pairEdge("mid-task", "epic-root", "parent-child")],
      }),
      pairIssue({
        id: "grandchild-task",
        title: "Grandchild Task",
        dependencies: [pairEdge("grandchild-task", "mid-task", "parent-child")],
      }),

      // A closed issue.
      pairIssue({
        id: "closed-task",
        title: "Closed Task",
        status: "closed",
        closed_at: seedTime(100),
        close_reason: "shipped",
      }),

      // Self-edge — dropped as a self/duplicate edge; the item itself still lands.
      pairIssue({
        id: "self-edge-task",
        title: "Self Edge Task",
        dependencies: [pairEdge("self-edge-task", "self-edge-task", "blocks")],
      }),

      // Dangling edge — target names no accepted issue; the item itself still lands.
      pairIssue({
        id: "dangling-task",
        title: "Dangling Task",
        dependencies: [pairEdge("dangling-task", "ghost-issue", "blocks")],
      }),

      // A blocks cycle between two issues — one direction survives
      // (sorted-first wins), the other is deterministically dropped and reported.
      pairIssue({
        id: "cycle-a",
        title: "Cycle A",
        dependencies: [pairEdge("cycle-a", "cycle-b", "blocks")],
      }),
      pairIssue({
        id: "cycle-b",
        title: "Cycle B",
        dependencies: [pairEdge("cycle-b", "cycle-a", "blocks")],
      }),

      // Blank comment body — excluded, no note; the item itself still lands.
      pairIssue({
        id: "blank-comment-task",
        title: "Blank Comment Task",
        comments: [pairComment("blank-comment-task", "   ")],
      }),

      // A real (non-blank) comment — the only fixture entry that actually
      // exercises the PlannedNote.id <-> PlannedEvent.noteRef handoff with
      // transform's real id scheme (`${issue.id}:note-${index}`, mapIssue)
      // resolved through load's noteIdMap, rather than a hand-built
      // PlannedNote/PlannedEvent pair the other load.ts tests use. A
      // distinct issue from blank-comment-task: pairComment always mints
      // `${issueId}:c1`, so two comments on the same issue would collide.
      pairIssue({
        id: "commented-task",
        title: "Commented Task",
        comments: [pairComment("commented-task", "a real comment worth keeping")],
      }),
    ];

    const extract: BeadsExtract = {
      issues,
      skippedRecords: { count: 0, byType: [], truncated: false },
    };
    const { plan, report } = planMigration(extract, MIGRATING_ACTOR, seedTime(-1_000));

    // The real assertion: loading a transform-passed plan raises nothing.
    const result = loadMigration(fixture.store, plan, MIGRATING_IDENTITY);

    // Sane row counts: one fewer task than the raw fixture (the empty-title
    // issue never became a PlannedItem at all), exactly one epic, one real
    // dependency edge (cycle-a -> cycle-b; the self-edge, the dangling edge
    // and the cycle's losing direction all dropped without a row), one real
    // note (the blank comment stayed excluded), and one `created` event per
    // surviving item plus one `closed` plus one `note-added`.
    expect(countRows(fixture.store, "tasks")).toBe(issues.length - 1);
    expect(result.counts.byLevel.epic).toBe(1);
    expect(result.counts.byLevel.task).toBe(issues.length - 2);
    expect(countRows(fixture.store, "deps")).toBe(1);
    expect(countRows(fixture.store, "notes")).toBe(1);
    expect(countRows(fixture.store, "events")).toBe(issues.length - 1 + 2); // one created each, plus one closed, plus one note-added

    // Grandchild reparented directly onto the epic, not its immediate parent.
    const epicId = newIdOf(result, "epic-root");
    expect(getTask(fixture.store, newIdOf(result, "grandchild-task"))?.parentId).toBe(epicId);
    expect(report.reparented.items.some((r) => r.oldId === "grandchild-task")).toBe(true);

    // The closed issue closed honestly through the move seam, not a direct
    // terminal-lane creation.
    expect(getTask(fixture.store, newIdOf(result, "closed-task"))?.lane).toBe("Done");

    // The real comment's note-added event points at the actual minted note
    // id — proving transform's PlannedNote.id <-> PlannedEvent.noteRef
    // handoff (`${issue.id}:note-${index}`, resolved through load's
    // noteIdMap) works end to end with transform's real id scheme, not just
    // the hand-built plan-local ids the rest of this file uses.
    const commentedTaskId = newIdOf(result, "commented-task");
    const noteRow = fixture.store.db
      .prepare("SELECT id FROM notes WHERE task_id = ?")
      .get(commentedTaskId) as { id: string };
    const { events: commentedTaskEvents } = listEvents(fixture.store, {
      entityId: commentedTaskId,
    });
    const noteEvent = commentedTaskEvents.find((e) => e.type === "note-added");
    expect(noteEvent?.ref).toBe(noteRow.id);

    // Every hostile path actually got pre-classified, not silently ignored.
    expect(report.invalidItems.count).toBe(1);
    expect(report.duplicateEdges.items.some((e) => e.fromOldId === "self-edge-task")).toBe(true);
    expect(report.danglingEdges.items.some((e) => e.fromOldId === "dangling-task")).toBe(true);
    expect(report.blocksCycles.count).toBe(1);
    expect(report.invalidNotes.count).toBe(1);
  });
});
