import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKatraException } from "../../src/core/errors.js";
import { createTask, getTask, showTask } from "../../src/core/tasks/repo.js";
import { seedEpic, seedTask } from "../helpers/seed.js";
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

  it("refuses a parent that is not an epic", () => {
    const other = seedTask(fixture.store, { id: "kt-tk1234" });

    expect(() => createTask(fixture.store, { title: "child", parentId: other })).toThrowError(
      /must reference an epic/,
    );
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
