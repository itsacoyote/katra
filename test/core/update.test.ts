import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TERMINAL_LANES } from "../../src/core/enums.js";
import { isKatraException } from "../../src/core/errors.js";
import { getTask } from "../../src/core/tasks/repo.js";
import { updateTask } from "../../src/core/tasks/update.js";
import { seedEpic, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

describe("updateTask", () => {
  it("changes a field and bumps updated_at", () => {
    const id = seedTask(fixture.store, { title: "before" });
    const before = getTask(fixture.store, id);

    const after = updateTask(fixture.store, id, { title: "after" });

    expect(after.task.title).toBe("after");
    expect(after.task.updatedAt).not.toBe(before?.updatedAt);
    expect(after.task.createdAt).toBe(before?.createdAt);
  });

  it("leaves unspecified fields untouched", () => {
    const id = seedTask(fixture.store, {
      title: "keep",
      kind: "fix",
      priority: 1,
      assignee: "ada",
      tags: ["x"],
    });

    const after = updateTask(fixture.store, id, { lane: "Planned" });

    expect(after.task).toMatchObject({
      title: "keep",
      kind: "fix",
      priority: 1,
      assignee: "ada",
      tags: ["x"],
      lane: "Planned",
    });
  });

  it("refuses to set a terminal lane and names close or cancel", () => {
    // Requirement 51. Without this, `update --lane Done` produces a task that
    // is terminal for readiness — silently releasing its dependents — with no
    // closed_at, no reason and no unblock report.
    const id = seedTask(fixture.store);

    for (const lane of TERMINAL_LANES) {
      try {
        updateTask(fixture.store, id, { lane });
        expect.unreachable(`should have refused ${lane}`);
      } catch (error) {
        if (!isKatraException(error)) throw error;
        expect(error.message).toMatch(/katra close/);
        expect(error.message).toMatch(/katra cancel/);
      }
    }
  });

  it("leaves the task untouched when it refuses a terminal lane", () => {
    const id = seedTask(fixture.store, { lane: "In Progress" });

    expect(() => updateTask(fixture.store, id, { lane: "Done" })).toThrow();

    expect(getTask(fixture.store, id)).toMatchObject({ lane: "In Progress", closedAt: null });
  });

  it("refuses to change the lane of an already-terminal task", () => {
    const id = seedTask(fixture.store, { lane: "Done" });

    try {
      updateTask(fixture.store, id, { lane: "Planned" });
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("conflict");
      expect(error.message).toMatch(/katra reopen/);
    }
  });

  it("moves a task through every non-terminal lane", () => {
    const id = seedTask(fixture.store);

    for (const lane of ["Researching", "Planned", "In Progress", "In Review", "Defined"] as const) {
      expect(updateTask(fixture.store, id, { lane }).task.lane).toBe(lane);
    }
  });

  it("reparents a task onto a different epic without changing its id", () => {
    // ADR-001: an id written into a commit message must stay valid, which is
    // the entire reason ids are flat.
    const first = seedEpic(fixture.store, { title: "first epic" });
    const second = seedEpic(fixture.store, { title: "second epic" });
    const id = seedTask(fixture.store, { parentId: first });

    const after = updateTask(fixture.store, id, { parentId: second });

    expect(after.task.id).toBe(id);
    expect(after.task.parentId).toBe(second);
    // The detail resolves the epic by name, so the printed answer never shows a
    // bare id where `show` would show a title.
    expect(after.parent?.title).toBe("second epic");
  });

  it("detaches a task from its epic", () => {
    const epic = seedEpic(fixture.store);
    const id = seedTask(fixture.store, { parentId: epic });

    expect(updateTask(fixture.store, id, { parentId: null }).task.parentId).toBeNull();
  });

  it("clears closed_at whenever it sets a lane", () => {
    // The schema enforces terminal ⇒ closed_at, never the converse, so an
    // active lane carrying a close timestamp is a state nothing else catches.
    // It is reachable by a lost update: another worktree closes the task
    // between this one's guard and its write. Setting the columns
    // unconditionally makes the invariant structural instead of timing-
    // dependent.
    const id = seedTask(fixture.store);
    fixture.store.db
      .prepare("UPDATE tasks SET closed_at = ?, close_reason = ? WHERE id = ?")
      .run("2026-01-02T00:00:00.000Z", "stale", id);

    const updated = updateTask(fixture.store, id, { lane: "Planned" });

    expect(updated.task.lane).toBe("Planned");
    expect(updated.task.closedAt).toBeNull();
    expect(updated.task.closeReason).toBeNull();
  });

  it("refuses to reparent onto a task rather than an epic", () => {
    const other = seedTask(fixture.store);
    const id = seedTask(fixture.store);

    try {
      updateTask(fixture.store, id, { parentId: other });
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("validation");
      expect(error.message).toContain("is a task, not an epic");
    }
  });

  it("accepts a partial id for both the task and its new parent", () => {
    const epic = seedEpic(fixture.store, { id: "kt-ep0001" });
    seedTask(fixture.store, { id: "kt-tk0001" });

    expect(updateTask(fixture.store, "tk0", { parentId: "ep0" }).task.parentId).toBe(epic);
  });

  it("adds and removes tags", () => {
    const id = seedTask(fixture.store, { tags: ["keep", "drop"] });

    const after = updateTask(fixture.store, id, { addTags: ["new"], removeTags: ["drop"] });

    expect(after.task.tags).toEqual(["keep", "new"]);
  });

  it("bumps updated_at for a tag-only edit", () => {
    // Tags live in their own table, so this used to leave updated_at alone —
    // and `show` hides the "updated" line when it equals created_at, so both
    // output modes claimed a task that had just been edited never was.
    const id = seedTask(fixture.store, { tags: ["old"] });
    const before = getTask(fixture.store, id);

    const after = updateTask(fixture.store, id, { addTags: ["fresh"] });

    expect(after.task.updatedAt).not.toBe(before?.updatedAt);
    expect(after.task.updatedAt).not.toBe(after.task.createdAt);
  });

  it.each([
    ["adding a tag it already has", { addTags: ["already"] }],
    ["removing a tag it never had", { removeTags: ["never-had-this"] }],
  ])("leaves updated_at alone when %s", (_name, patch) => {
    const id = seedTask(fixture.store, { tags: ["already"] });
    const before = getTask(fixture.store, id);

    const after = updateTask(fixture.store, id, patch);

    expect(after.task.updatedAt).toBe(before?.updatedAt);
  });

  it("rejects a priority outside the allowed range", () => {
    const id = seedTask(fixture.store);
    expect(() => updateTask(fixture.store, id, { priority: 9 as never })).toThrow();
  });

  it("refuses an empty title", () => {
    const id = seedTask(fixture.store);
    expect(() => updateTask(fixture.store, id, { title: "   " })).toThrowError(/needs a title/);
  });

  it("reports an unknown id as not found", () => {
    expect(() => updateTask(fixture.store, "zzzz", { title: "x" })).toThrowError(/no task matches/);
  });
});
