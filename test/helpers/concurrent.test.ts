import { describe, expect, it } from "vitest";
import { runConcurrent } from "./concurrent.js";

describe("concurrent harness", () => {
  it("collects results from several concurrently spawned child processes", async () => {
    const outcomes = await runConcurrent<{ index: number; pid: number }>({
      count: 5,
      source: `report({ index: INDEX, pid: process.pid });`,
    });

    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => o.value?.index).sort()).toEqual([0, 1, 2, 3, 4]);

    // Distinct pids prove these are separate OS processes, not workers sharing
    // one — which is the entire reason this helper exists.
    const pids = new Set(outcomes.map((o) => o.value?.pid));
    expect(pids.size).toBe(5);
    expect(pids.has(process.pid)).toBe(false);
  });

  it("releases every process at the same instant so their work overlaps", async () => {
    // Without the barrier the first process routinely finishes before the last
    // has started, and no contention is ever produced.
    const outcomes = await runConcurrent<{ start: number; end: number }>({
      count: 4,
      source: `
        const start = Date.now();
        while (Date.now() - start < 150) { /* occupy the window */ }
        report({ start, end: Date.now() });
      `,
    });

    expect(outcomes.every((o) => o.ok)).toBe(true);
    const spans = outcomes.map((o) => o.value).filter((v) => v !== undefined);
    expect(spans).toHaveLength(4);

    const latestStart = Math.max(...spans.map((s) => s.start));
    const earliestEnd = Math.min(...spans.map((s) => s.end));
    expect(earliestEnd).toBeGreaterThan(latestStart);
  });

  it("can resolve the project's own dependencies from inside a worker", async () => {
    // Worker files live under node_modules precisely so this import works;
    // T3 and T4 depend on it to open real databases in real processes.
    const outcomes = await runConcurrent<{ hasDatabase: boolean }>({
      count: 2,
      source: `
        const { default: Database } = await import("better-sqlite3");
        report({ hasDatabase: typeof Database === "function" });
      `,
    });

    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => o.value?.hasDatabase)).toEqual([true, true]);
  });

  it("reports a failing process as an outcome rather than throwing", async () => {
    const outcomes = await runConcurrent<never>({
      count: 2,
      source: `if (INDEX === 1) { throw new Error("deliberate failure"); } report(null);`,
    });

    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]?.ok).toBe(false);
    expect(outcomes[1]?.exitCode).not.toBe(0);
    expect(outcomes[1]?.stderr).toContain("deliberate failure");
    expect(outcomes[1]?.value).toBeUndefined();
  });

  it("passes environment variables through to every process", async () => {
    const outcomes = await runConcurrent<string | undefined>({
      count: 2,
      source: `report(process.env.KATRA_TEST_VALUE);`,
      env: { KATRA_TEST_VALUE: "passed-through" },
    });

    expect(outcomes.map((o) => o.value)).toEqual(["passed-through", "passed-through"]);
  });
});
