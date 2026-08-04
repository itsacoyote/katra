/**
 * What the four write paths actually record.
 *
 * `events.test.ts` covers the append primitive; this covers the wiring — which
 * commands emit, which deliberately do not, and what travels on each event.
 * Kept in one file rather than split across the four command tests so
 * "all seven types are emitted by a real path" is a single assertion rather
 * than four partial ones nobody adds up.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "../../src/core/enums.js";
import { deleteTask } from "../../src/core/tasks/delete.js";
import { cancelTask, closeTask, reopenTask } from "../../src/core/tasks/lifecycle.js";
import { createTask } from "../../src/core/tasks/repo.js";
import { updateTask } from "../../src/core/tasks/update.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

const ACTOR = "feature/f2 @ /repo/wt-f2";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture({ actor: ACTOR });
});
afterEach(() => fixture.cleanup());

interface EventRow {
  readonly id: number;
  readonly type: string;
  readonly entity_id: string;
  readonly epic_id: string | null;
  readonly actor: string;
  readonly from_lane: string | null;
  readonly to_lane: string | null;
  readonly reason: string | null;
  readonly title: string | null;
}

const events = (entityId?: string): EventRow[] =>
  fixture.store.db
    .prepare(
      entityId === undefined
        ? "SELECT * FROM events ORDER BY id"
        : "SELECT * FROM events WHERE entity_id = ? ORDER BY id",
    )
    .all(...(entityId === undefined ? [] : [entityId])) as EventRow[];

const types = (entityId?: string): string[] => events(entityId).map((e) => e.type);

describe("add", () => {
  it("records a created event when a task is added", () => {
    const task = createTask(fixture.store, { title: "write the thing" });

    expect(events(task.id)).toMatchObject([
      {
        type: "created",
        entity_id: task.id,
        epic_id: null,
        actor: ACTOR,
        title: "write the thing",
        from_lane: null,
        to_lane: null,
        reason: null,
      },
    ]);
  });

  it("stamps the parent epic on a child's created event", () => {
    const epic = createTask(fixture.store, { title: "an epic", level: "epic" });
    const child = createTask(fixture.store, { title: "a child", parentId: epic.id });

    expect(events(child.id)[0]?.epic_id).toBe(epic.id);
  });

  it("stamps an epic's own id on its own created event", () => {
    // An epic's parent_id is always NULL by CHECK, so the obvious
    // `epic_id = parentId` would leave an epic's own history unstamped and an
    // epic-scoped read would silently exclude it.
    const epic = createTask(fixture.store, { title: "an epic", level: "epic" });

    expect(events(epic.id)[0]?.epic_id).toBe(epic.id);
  });

  it("leaves neither task nor event when the create fails", () => {
    // The event and the entity share one transaction, so a refused create
    // cannot leave history claiming it happened.
    expect(() =>
      createTask(fixture.store, { title: "doomed", parentId: "kt-zzzzzz" }),
    ).toThrowError();

    expect(events()).toEqual([]);
    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM tasks").get()).toEqual({ c: 0 });
  });

  it("records the title on the event, not only on the task", () => {
    // A created event outlives its task (ADR-008). Once the row is deleted no
    // join can recover what it was called, so the event has to carry it.
    const task = createTask(fixture.store, { title: "a typo" });
    deleteTask(fixture.store, task.id);

    expect(events(task.id)[0]).toMatchObject({ type: "created", title: "a typo" });
  });
});

describe("update", () => {
  it("records both lanes when the lane changes", () => {
    const task = createTask(fixture.store, { title: "a task" });

    updateTask(fixture.store, task.id, { lane: "In Progress" });

    expect(events(task.id)).toMatchObject([
      { type: "created" },
      {
        type: "status-changed",
        from_lane: "Defined",
        to_lane: "In Progress",
        actor: ACTOR,
        reason: null,
      },
    ]);
  });

  it("records nothing when only the title changes", () => {
    // Requirement 11. Attribute churn in the stream buries the signal it
    // exists to carry.
    const task = createTask(fixture.store, { title: "before" });

    updateTask(fixture.store, task.id, { title: "after" });

    expect(types(task.id)).toEqual(["created"]);
  });

  it("records nothing for priority, kind, assignee or tags", () => {
    const task = createTask(fixture.store, { title: "a task" });

    updateTask(fixture.store, task.id, { priority: 0 });
    updateTask(fixture.store, task.id, { kind: "fix" });
    updateTask(fixture.store, task.id, { assignee: "ada" });
    updateTask(fixture.store, task.id, { addTags: ["urgent"] });
    updateTask(fixture.store, task.id, { removeTags: ["urgent"] });
    updateTask(fixture.store, task.id, { description: "more detail" });

    expect(types(task.id)).toEqual(["created"]);
  });

  it("records nothing when the lane is set to the one it already holds", () => {
    // A status-changed whose two lanes are equal describes nothing that
    // happened.
    const task = createTask(fixture.store, { title: "a task", lane: "Planned" });

    updateTask(fixture.store, task.id, { lane: "Planned" });

    expect(types(task.id)).toEqual(["created"]);
  });

  it("records exactly one event when a lane change accompanies other edits", () => {
    const task = createTask(fixture.store, { title: "a task" });

    updateTask(fixture.store, task.id, {
      lane: "Planned",
      title: "renamed",
      priority: 0,
      addTags: ["x"],
    });

    expect(types(task.id)).toEqual(["created", "status-changed"]);
  });

  it("records nothing when a task is reparented, keeping the old epic stamp on earlier events", () => {
    // Deliberate, and it will read as a bug to whoever finds it first: a
    // task's epic_id history splits at the move. `log <oldEpic>` keeps the
    // pre-move events, `log <newEpic>` never gets them, and neither is
    // complete. That is the spec's stated single-level tradeoff — pinned here
    // so nobody "fixes" it into something worse.
    const before = createTask(fixture.store, { title: "epic before", level: "epic" });
    const after = createTask(fixture.store, { title: "epic after", level: "epic" });
    const task = createTask(fixture.store, { title: "moves", parentId: before.id });

    updateTask(fixture.store, task.id, { parentId: after.id });
    updateTask(fixture.store, task.id, { lane: "Planned" });

    const stamps = events(task.id).map((e) => ({ type: e.type, epic: e.epic_id }));
    expect(stamps).toEqual([
      { type: "created", epic: before.id },
      { type: "status-changed", epic: after.id },
    ]);
  });
});

describe("close, cancel and reopen", () => {
  it("records closed, cancelled and reopened with their reasons", () => {
    const one = createTask(fixture.store, { title: "finished" });
    const two = createTask(fixture.store, { title: "abandoned" });

    closeTask(fixture.store, one.id, "shipped it");
    cancelTask(fixture.store, two.id, "wrong approach");
    reopenTask(fixture.store, one.id);

    expect(events(one.id)).toMatchObject([
      { type: "created" },
      { type: "closed", from_lane: "Defined", to_lane: "Done", reason: "shipped it" },
      // reopen carries no reason: reopenTask has no reason parameter, and
      // reopening is not a judgement that needs explaining.
      { type: "reopened", from_lane: "Done", to_lane: "Defined", reason: null },
    ]);
    expect(events(two.id)).toMatchObject([
      { type: "created" },
      { type: "cancelled", from_lane: "Defined", to_lane: "Cancelled", reason: "wrong approach" },
    ]);
  });

  it("records the lane a task came from, not only where it went", () => {
    // `closed` already implies the destination. Where it came from is the part
    // the stream would otherwise lose.
    const task = createTask(fixture.store, { title: "a task", lane: "In Review" });

    closeTask(fixture.store, task.id);

    expect(events(task.id)[1]).toMatchObject({ from_lane: "In Review", to_lane: "Done" });
  });

  it("distinguishes close from cancel rather than inferring from the lane", () => {
    const one = createTask(fixture.store, { title: "one" });
    const two = createTask(fixture.store, { title: "two" });

    closeTask(fixture.store, one.id);
    cancelTask(fixture.store, two.id);

    expect(types(one.id)).toEqual(["created", "closed"]);
    expect(types(two.id)).toEqual(["created", "cancelled"]);
  });

  it("records no event when a transition is refused", () => {
    const task = createTask(fixture.store, { title: "a task" });
    closeTask(fixture.store, task.id);

    expect(() => closeTask(fixture.store, task.id)).toThrowError(/already Done/);

    expect(types(task.id)).toEqual(["created", "closed"]);
  });
});

describe("delete", () => {
  it("records a deleted event carrying the task's title", () => {
    const task = createTask(fixture.store, { title: "a typo" });

    deleteTask(fixture.store, task.id);

    const last = events(task.id).at(-1);
    expect(last).toMatchObject({
      type: "deleted",
      entity_id: task.id,
      actor: ACTOR,
      title: "a typo",
    });
    // The title rides in its own column, never in reason — reason means "why"
    // everywhere else, and a generic renderer prints it as one.
    expect(last?.reason).toBeNull();
  });

  it("keeps the whole history of a task that no longer exists", () => {
    const task = createTask(fixture.store, { title: "a typo" });
    updateTask(fixture.store, task.id, { lane: "Planned" });

    deleteTask(fixture.store, task.id);

    expect(types(task.id)).toEqual(["created", "status-changed", "deleted"]);
    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM tasks").get()).toEqual({ c: 0 });
  });

  it("stamps the epic on a deleted child, which no lookup could recover", () => {
    // The row is gone by the time the event is appended, so `epicIdFor` had to
    // run against the task read before the DELETE. A lookup would return
    // nothing and the deleted event would lose its epic — breaking exactly the
    // epic-scoped history this stamping exists for.
    const epic = createTask(fixture.store, { title: "an epic", level: "epic" });
    const child = createTask(fixture.store, { title: "a child", parentId: epic.id });

    deleteTask(fixture.store, child.id);

    expect(events(child.id).at(-1)).toMatchObject({ type: "deleted", epic_id: epic.id });
  });

  it("records no event when a delete is refused", () => {
    const epic = createTask(fixture.store, { title: "an epic", level: "epic" });
    createTask(fixture.store, { title: "a child", parentId: epic.id });

    expect(() => deleteTask(fixture.store, epic.id)).toThrowError(/child/);

    expect(types(epic.id)).toEqual(["created"]);
  });
});

describe("the stream as a whole", () => {
  it("emits all seven declared event types from a real command path", () => {
    // Acceptance criterion: every type katra declares must be reachable. A
    // type in the CHECK constraint that no code path produces is either dead
    // or a missing feature, and only counting them together tells the two
    // apart.
    const epic = createTask(fixture.store, { title: "an epic", level: "epic" });
    const task = createTask(fixture.store, { title: "a task", parentId: epic.id });
    updateTask(fixture.store, task.id, { lane: "In Progress" });
    closeTask(fixture.store, task.id, "done");
    reopenTask(fixture.store, task.id);
    cancelTask(fixture.store, task.id, "changed our minds");
    deleteTask(fixture.store, task.id);

    const emitted = new Set(types());
    // note-added is the one type no task path produces — it belongs to notes.
    expect([...emitted].sort()).toEqual([...EVENT_TYPES].filter((t) => t !== "note-added").sort());
  });

  it("stamps every event with the store's actor", () => {
    const task = createTask(fixture.store, { title: "a task" });
    updateTask(fixture.store, task.id, { lane: "Planned" });
    closeTask(fixture.store, task.id);

    expect(events().every((e) => e.actor === ACTOR)).toBe(true);
  });

  it("gives every event of one command the same timestamp as its entity write", () => {
    const task = createTask(fixture.store, { title: "a task" });

    const row = fixture.store.db
      .prepare("SELECT created_at FROM tasks WHERE id = ?")
      .get(task.id) as { created_at: string };
    const event = fixture.store.db
      .prepare("SELECT created_at FROM events WHERE entity_id = ?")
      .get(task.id) as { created_at: string };

    expect(event.created_at).toBe(row.created_at);
  });
});
