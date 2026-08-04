import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LANES, TERMINAL_LANES } from "../../src/core/enums.js";
import { isKatraException } from "../../src/core/errors.js";
import {
  addDependency,
  isReady,
  listBlockers,
  listDependencies,
  listDependents,
  READINESS_VIEW,
  removeDependency,
} from "../../src/core/graph/deps.js";
import { runConcurrent } from "../helpers/concurrent.js";
import { seedDep, seedTask, seedTime } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

describe("isReady", () => {
  it("reports a task with no dependencies as ready", () => {
    expect(isReady(fixture.store, seedTask(fixture.store))).toBe(true);
  });

  it("reports a task as blocked while its dependency is in a non-terminal lane", () => {
    const blocker = seedTask(fixture.store, { lane: "In Progress" });
    const blocked = seedTask(fixture.store);
    seedDep(fixture.store, blocked, blocker);

    expect(isReady(fixture.store, blocked)).toBe(false);
  });

  it("reports the same task as ready once its dependency reaches Done", () => {
    const blocker = seedTask(fixture.store);
    const blocked = seedTask(fixture.store);
    seedDep(fixture.store, blocked, blocker);

    fixture.store.db
      .prepare("UPDATE tasks SET lane='Done', closed_at='2026-01-02T00:00:00.000Z' WHERE id=?")
      .run(blocker);

    expect(isReady(fixture.store, blocked)).toBe(true);
  });

  it("reports the same task as ready once its dependency is Cancelled", () => {
    // ADR-003: abandoning a blocker must release what it was blocking, or
    // dropping an approach strands everything behind it forever.
    const blocker = seedTask(fixture.store);
    const blocked = seedTask(fixture.store);
    seedDep(fixture.store, blocked, blocker);

    fixture.store.db
      .prepare("UPDATE tasks SET lane='Cancelled', closed_at='2026-01-02T00:00:00.000Z' WHERE id=?")
      .run(blocker);

    expect(isReady(fixture.store, blocked)).toBe(true);
  });

  it("stays blocked while any one of several dependencies is unfinished", () => {
    const blocked = seedTask(fixture.store);
    const done = seedTask(fixture.store, { lane: "Done" });
    const open = seedTask(fixture.store, { lane: "In Review" });
    seedDep(fixture.store, blocked, done);
    seedDep(fixture.store, blocked, open);

    expect(isReady(fixture.store, blocked)).toBe(false);
  });

  it("throws for a task that does not exist", () => {
    expect(() => isReady(fixture.store, "kt-absent")).toThrowError(/no task with id/);
  });

  it("agrees with the set-based query for every task across all seven lanes", () => {
    // Acceptance criterion 46. isReady reads one row from the view and the set
    // queries join it; this is what proves they are the same definition rather
    // than two that happen to agree today.
    const blockers = LANES.map((lane) =>
      seedTask(fixture.store, {
        lane,
        ...(TERMINAL_LANES.includes(lane as never) ? {} : {}),
        title: `blocker in ${lane}`,
      }),
    );
    const dependents = blockers.map((blocker) => {
      const dependent = seedTask(fixture.store, { title: `waits on ${blocker}` });
      seedDep(fixture.store, dependent, blocker);
      return dependent;
    });
    const independent = seedTask(fixture.store, { title: "no dependencies" });

    const fromSet = new Set(
      (
        fixture.store.db
          .prepare(`SELECT id FROM ${READINESS_VIEW} WHERE is_ready = 1`)
          .all() as Array<{ id: string }>
      ).map((row) => row.id),
    );

    for (const id of [...blockers, ...dependents, independent]) {
      expect(isReady(fixture.store, id)).toBe(fromSet.has(id));
    }

    // And the expected shape: exactly the two terminal-blocked dependents are
    // ready, alongside every blocker and the independent task.
    const readyDependents = dependents.filter((id) => isReady(fixture.store, id));
    expect(readyDependents).toHaveLength(TERMINAL_LANES.length);
  });
});

describe("listBlockers", () => {
  it("names only the unfinished dependencies", () => {
    const blocked = seedTask(fixture.store);
    const done = seedTask(fixture.store, { lane: "Done", title: "already done" });
    const cancelled = seedTask(fixture.store, { lane: "Cancelled", title: "abandoned" });
    const open = seedTask(fixture.store, { lane: "Planned", title: "still open" });
    for (const b of [done, cancelled, open]) seedDep(fixture.store, blocked, b);

    expect(listBlockers(fixture.store, blocked).map((b) => b.title)).toEqual(["still open"]);
  });

  it("orders blockers the way next ranks candidates", () => {
    const blocked = seedTask(fixture.store);
    const low = seedTask(fixture.store, { priority: 4, title: "low" });
    const high = seedTask(fixture.store, { priority: 0, title: "high" });
    seedDep(fixture.store, blocked, low);
    seedDep(fixture.store, blocked, high);

    expect(listBlockers(fixture.store, blocked).map((b) => b.title)).toEqual(["high", "low"]);
  });

  it("returns nothing for a ready task", () => {
    expect(listBlockers(fixture.store, seedTask(fixture.store))).toEqual([]);
  });
});

describe("addDependency", () => {
  it("records the edge and blocks the dependent", () => {
    const blocker = seedTask(fixture.store);
    const blocked = seedTask(fixture.store);

    addDependency(fixture.store, blocked, blocker);

    expect(isReady(fixture.store, blocked)).toBe(false);
    expect(listDependencies(fixture.store, blocked).map((d) => d.id)).toEqual([blocker]);
    expect(listDependents(fixture.store, blocker).map((d) => d.id)).toEqual([blocked]);
  });

  it("accepts partial ids on both sides", () => {
    const blocker = seedTask(fixture.store, { id: "kt-aa1111" });
    const blocked = seedTask(fixture.store, { id: "kt-bb2222" });

    expect(addDependency(fixture.store, "bb2", "aa1")).toEqual({
      taskId: blocked,
      dependsOnId: blocker,
    });
  });

  it("treats re-adding an existing edge as a no-op", () => {
    const blocker = seedTask(fixture.store);
    const blocked = seedTask(fixture.store);

    addDependency(fixture.store, blocked, blocker);
    expect(() => addDependency(fixture.store, blocked, blocker)).not.toThrow();
    expect(listDependencies(fixture.store, blocked)).toHaveLength(1);
  });

  it("rejects a self-dependency", () => {
    const id = seedTask(fixture.store);
    expect(() => addDependency(fixture.store, id, id)).toThrowError(/cannot depend on itself/);
  });

  it("rejects a dependency that would close a cycle", () => {
    const a = seedTask(fixture.store, { id: "kt-aaaaaa" });
    const b = seedTask(fixture.store, { id: "kt-bbbbbb" });
    addDependency(fixture.store, a, b);

    expect(() => addDependency(fixture.store, b, a)).toThrowError(/dependency cycle/);
  });

  it("names the full cycle path when rejecting", () => {
    // A refusal that only says "cycle" leaves the reader to find it themselves.
    const a = seedTask(fixture.store, { id: "kt-aaaaaa" });
    const b = seedTask(fixture.store, { id: "kt-bbbbbb" });
    const c = seedTask(fixture.store, { id: "kt-cccccc" });
    addDependency(fixture.store, a, b);
    addDependency(fixture.store, b, c);

    try {
      addDependency(fixture.store, c, a);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("cycle");
      if (error.detail.code !== "cycle") throw new Error("unreachable");
      expect(error.detail.path).toEqual(["kt-cccccc", "kt-aaaaaa", "kt-bbbbbb", "kt-cccccc"]);
    }
  });

  it("leaves the edge unrecorded when the cycle check rejects it", () => {
    const a = seedTask(fixture.store, { id: "kt-aaaaaa" });
    const b = seedTask(fixture.store, { id: "kt-bbbbbb" });
    addDependency(fixture.store, a, b);

    expect(() => addDependency(fixture.store, b, a)).toThrow();
    expect(listDependencies(fixture.store, b)).toEqual([]);
  });

  it("detects a cycle across a long chain without timing out", () => {
    const ids = Array.from({ length: 400 }, (_u, i) =>
      seedTask(fixture.store, { id: `kt-c${String(i).padStart(5, "0")}` }),
    );
    for (let i = 0; i < ids.length - 1; i++) {
      seedDep(fixture.store, ids[i] as string, ids[i + 1] as string);
    }

    const started = Date.now();
    expect(() => addDependency(fixture.store, ids.at(-1) as string, ids[0] as string)).toThrowError(
      /dependency cycle/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports an unknown id as not found", () => {
    const id = seedTask(fixture.store);
    expect(() => addDependency(fixture.store, id, "kt-zzzzzz")).toThrowError(/no task matches/);
  });
});

describe("removeDependency", () => {
  it("removes the edge and releases the dependent", () => {
    const blocker = seedTask(fixture.store);
    const blocked = seedTask(fixture.store);
    addDependency(fixture.store, blocked, blocker);

    removeDependency(fixture.store, blocked, blocker);

    expect(isReady(fixture.store, blocked)).toBe(true);
  });

  it("reports an edge that was not there", () => {
    const a = seedTask(fixture.store);
    const b = seedTask(fixture.store);
    expect(() => removeDependency(fixture.store, a, b)).toThrowError(/does not depend on/);
  });
});

describe("concurrent writers", () => {
  it("allows only one of two processes adding opposite edges", { timeout: 60_000 }, async () => {
    // Verified before this code existed: run as separate check-then-insert
    // steps, both processes pass their own cycle check against a graph that
    // lacks the other's edge, and a real cycle is committed. One immediate
    // transaction is what prevents it.
    const a = seedTask(fixture.store, { id: "kt-aaaaaa" });
    const b = seedTask(fixture.store, { id: "kt-bbbbbb" });
    const modules = {
      store: fileURLToPath(new URL("../../src/core/store.ts", import.meta.url)),
      deps: fileURLToPath(new URL("../../src/core/graph/deps.ts", import.meta.url)),
    };

    const outcomes = await runConcurrent<{ ok: boolean; cycle: boolean }>({
      count: 2,
      source: `
        const { openStore } = await import(${JSON.stringify(modules.store)});
        const { addDependency } = await import(${JSON.stringify(modules.deps)});
        const { store } = openStore(${JSON.stringify(fixture.repo.dir)}, {});
        const [from, to] = INDEX === 0
          ? [${JSON.stringify(a)}, ${JSON.stringify(b)}]
          : [${JSON.stringify(b)}, ${JSON.stringify(a)}];
        barrier();
        let ok = false, cycle = false;
        try { addDependency(store, from, to); ok = true; }
        catch (e) { cycle = /cycle/i.test(String(e && e.message)); }
        store.close();
        report({ ok, cycle });
      `,
    });

    const results = outcomes.map((o) => o.value).filter((v) => v !== undefined);
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.cycle)).toHaveLength(1);

    // The decisive check: whatever the timing, no cycle may exist afterwards.
    const edges = fixture.store.db.prepare("SELECT COUNT(*) c FROM deps").get();
    expect(edges).toEqual({ c: 1 });
  });
});

describe("tie-breaking on the join-driven queries", () => {
  // These queries sort rows drawn from `deps`, not from `tasks`, so the
  // sorter's input order is whatever the deps index yields — not the tasks
  // rowid order. That makes the `tasks` rowid tie-break genuinely observable
  // here, unlike in `list` and `next` where SQLite's incidental scan order
  // already matches it (see docs/f1-traceability.md).
  //
  // Two things are deliberately opposed to insertion order, because either one
  // alone is satisfied by an incidental plan: the **ids** descend, so an index
  // walk gives the reverse answer, and the **dep rows** are written back to
  // front. Only a tasks-rowid tie-break yields task insertion order.
  function tiedTrio(): { hub: string; first: string; second: string } {
    const stamp = seedTime(500);
    const hub = seedTask(fixture.store, { id: "kt-hub000", title: "hub", createdAt: stamp });
    const first = seedTask(fixture.store, { id: "kt-zzzzzz", title: "first", createdAt: stamp });
    const second = seedTask(fixture.store, { id: "kt-aaaaaa", title: "second", createdAt: stamp });
    return { hub, first, second };
  }

  it("breaks a created_at tie among dependents by task insertion order", () => {
    const { hub, first, second } = tiedTrio();
    seedDep(fixture.store, second, hub);
    seedDep(fixture.store, first, hub);

    expect(listDependents(fixture.store, hub).map((t) => t.title)).toEqual(["first", "second"]);
  });

  it("breaks a created_at tie among dependencies by task insertion order", () => {
    const { hub, first, second } = tiedTrio();
    seedDep(fixture.store, hub, second);
    seedDep(fixture.store, hub, first);

    expect(listDependencies(fixture.store, hub).map((t) => t.title)).toEqual(["first", "second"]);
  });

  it("breaks a created_at tie among blockers by task insertion order", () => {
    const { hub, first, second } = tiedTrio();
    seedDep(fixture.store, hub, second);
    seedDep(fixture.store, hub, first);

    expect(listBlockers(fixture.store, hub).map((t) => t.title)).toEqual(["first", "second"]);
  });
});
