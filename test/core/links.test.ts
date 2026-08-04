import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKatraException } from "../../src/core/errors.js";
import { isReady } from "../../src/core/graph/deps.js";
import { addLink, listLinks, removeLink } from "../../src/core/graph/links.js";
import { showTask } from "../../src/core/tasks/repo.js";
import { seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

const rowCount = (): number =>
  (fixture.store.db.prepare("SELECT COUNT(*) c FROM links").get() as { c: number }).c;

describe("addLink", () => {
  it("stores a single row regardless of the order the two ids are given", () => {
    // The table enforces a_id < b_id, so inserting in the order the user typed
    // fails about half the time unless the pair is sorted first.
    const late = seedTask(fixture.store, { id: "kt-zzzzzz" });
    const early = seedTask(fixture.store, { id: "kt-aaaaaa" });

    expect(addLink(fixture.store, late, early)).toEqual({ a: early, b: late });
    expect(fixture.store.db.prepare("SELECT a_id, b_id FROM links").get()).toEqual({
      a_id: early,
      b_id: late,
    });
  });

  it("treats re-linking the same pair as a no-op rather than an error", () => {
    const a = seedTask(fixture.store);
    const b = seedTask(fixture.store);

    addLink(fixture.store, a, b);
    expect(() => addLink(fixture.store, a, b)).not.toThrow();
    expect(rowCount()).toBe(1);
  });

  it("treats re-linking in the reverse direction as a no-op", () => {
    // Same SQLite error code as an id collision, opposite handling: there a
    // duplicate means try a new id, here it means the work is already done.
    const a = seedTask(fixture.store, { id: "kt-aaaaaa" });
    const b = seedTask(fixture.store, { id: "kt-bbbbbb" });

    addLink(fixture.store, a, b);
    expect(() => addLink(fixture.store, b, a)).not.toThrow();
    expect(rowCount()).toBe(1);
  });

  it("accepts partial ids on both sides", () => {
    const a = seedTask(fixture.store, { id: "kt-aa1111" });
    const b = seedTask(fixture.store, { id: "kt-bb2222" });

    expect(addLink(fixture.store, "aa1", "bb2")).toEqual({ a, b });
  });

  it("refuses to link a task to itself", () => {
    const id = seedTask(fixture.store);
    expect(() => addLink(fixture.store, id, id)).toThrowError(/cannot be linked to itself/);
  });

  it("reports an unknown id as not found", () => {
    const id = seedTask(fixture.store);
    expect(() => addLink(fixture.store, id, "kt-zzzzzz")).toThrowError(/no task matches/);
  });
});

describe("listLinks", () => {
  it("displays the link from both sides", () => {
    // One row serves both directions, so each end must see the other.
    const a = seedTask(fixture.store, { id: "kt-aaaaaa", title: "first" });
    const b = seedTask(fixture.store, { id: "kt-bbbbbb", title: "second" });
    addLink(fixture.store, a, b);

    expect(listLinks(fixture.store, a).map((t) => t.title)).toEqual(["second"]);
    expect(listLinks(fixture.store, b).map((t) => t.title)).toEqual(["first"]);
  });

  it("lists several links in priority order", () => {
    const hub = seedTask(fixture.store, { id: "kt-hub000" });
    const low = seedTask(fixture.store, { title: "low", priority: 4 });
    const high = seedTask(fixture.store, { title: "high", priority: 0 });
    addLink(fixture.store, hub, low);
    addLink(fixture.store, hub, high);

    expect(listLinks(fixture.store, hub).map((t) => t.title)).toEqual(["high", "low"]);
  });

  it("returns nothing for an unlinked task", () => {
    expect(listLinks(fixture.store, seedTask(fixture.store))).toEqual([]);
  });

  it("appears in show output for both ends", () => {
    const a = seedTask(fixture.store, { id: "kt-aaaaaa", title: "first" });
    const b = seedTask(fixture.store, { id: "kt-bbbbbb", title: "second" });
    addLink(fixture.store, a, b);

    expect(showTask(fixture.store, a).links.map((t) => t.id)).toEqual([b]);
    expect(showTask(fixture.store, b).links.map((t) => t.id)).toEqual([a]);
  });
});

describe("links and readiness", () => {
  it("does not affect readiness", () => {
    // A link says "related", not "waits for". Conflating them would make
    // katra's most important read wrong.
    const a = seedTask(fixture.store, { lane: "In Progress" });
    const b = seedTask(fixture.store);

    addLink(fixture.store, a, b);

    expect(isReady(fixture.store, a)).toBe(true);
    expect(isReady(fixture.store, b)).toBe(true);
  });
});

describe("removeLink", () => {
  it("removes a link given from either direction", () => {
    const a = seedTask(fixture.store, { id: "kt-aaaaaa" });
    const b = seedTask(fixture.store, { id: "kt-bbbbbb" });
    addLink(fixture.store, a, b);

    removeLink(fixture.store, b, a);

    expect(rowCount()).toBe(0);
    expect(listLinks(fixture.store, a)).toEqual([]);
  });

  it("reports a link that was never there", () => {
    const a = seedTask(fixture.store);
    const b = seedTask(fixture.store);

    try {
      removeLink(fixture.store, a, b);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("not_found");
      expect(error.message).toMatch(/are not linked/);
    }
  });
});

describe("cascade", () => {
  it("removes a task's links when the task is deleted", () => {
    const a = seedTask(fixture.store);
    const b = seedTask(fixture.store);
    addLink(fixture.store, a, b);

    fixture.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(a);

    expect(rowCount()).toBe(0);
  });
});
