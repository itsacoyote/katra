/**
 * Is `board` cheap enough to run constantly?
 *
 * ADR-009 argues an agent should run it at every workflow checkpoint, and an
 * earlier draft of that ADR justified this by claiming the board's cost was
 * bounded by its shape. That is true of the *output* and false of the *cost*:
 *
 * - `ready` and `blocked` join `task_readiness`, a correlated `NOT EXISTS`
 *   evaluated for every row in `tasks` (`0001-init.ts:170-177`) **before** any
 *   `LIMIT` applies. Board is O(tasks), not O(output).
 * - `--digest` filters `notes` by `kind` with no `task_id`, and the only notes
 *   index is `notes(task_id, created_at)` — a scan plus a temp-btree sort.
 *
 * So the claim was replaced by a measurement, and this is it. The threshold is
 * stated so the test can fail; "record a number" cannot. If it fails, migration
 * `0003` adds the index — that is a deliberate decision and its own task, not
 * something to absorb here.
 *
 * A slow CI runner under load is a real risk for a wall-clock assertion. The
 * budget is deliberately generous against the measured figure for that reason,
 * and the seed is built to be *hostile* rather than representative: dependencies
 * are what make the readiness view expensive, so a store of ten thousand
 * isolated rows would measure fast and prove nothing.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readBoard } from "../../src/core/board.js";
import { latestHandoff } from "../../src/core/notes/repo.js";
import type { OpenStore } from "../../src/core/store.js";
import { openStore } from "../../src/core/store.js";
import { createGitRepo } from "../helpers/fixture.js";

const TASKS = 10_000;
const NOTES = 5_000;

/** What `board` must stay under on the seeded store. */
const BUDGET_MS = 250;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * A store shaped to be expensive: every fifth task carries a dependency.
 *
 * Written with raw inserts in one transaction rather than through `createTask`.
 * Ten thousand real writes would take minutes and would be measuring the write
 * path, which is not what this test is about.
 */
function seedLargeStore(): OpenStore {
  const repo = createGitRepo();
  cleanups.push(() => repo.cleanup());
  const { store } = openStore(repo.dir, { createIfMissing: true, actor: () => "perf @ /perf" });
  cleanups.push(() => store.close());

  const lanes = ["Defined", "Researching", "Planned", "In Progress", "In Review", "Done"];
  // Six base36 characters, which is what the schema's id CHECK enforces — the
  // constraint caught a seven-character seed id on the first run of this test.
  const taskId = (n: number): string => `kt-${n.toString(36).padStart(6, "0")}`;
  const noteId = (n: number): string => `nt-${n.toString(36).padStart(6, "0")}`;
  const stamp = "2026-01-01T00:00:00.000Z";
  const task = store.db.prepare(
    "INSERT INTO tasks (id,level,kind,title,lane,priority,created_at,updated_at,closed_at) VALUES (?,'task','feat',?,?,?,?,?,?)",
  );
  const dep = store.db.prepare(
    "INSERT INTO deps (task_id, depends_on_id, created_at) VALUES (?,?,?)",
  );
  const note = store.db.prepare(
    "INSERT INTO notes (id,task_id,kind,body,actor,created_at) VALUES (?,?,?,?,?,?)",
  );

  store.db.transaction(() => {
    for (let i = 0; i < TASKS; i++) {
      const lane = lanes[i % lanes.length] as string;
      task.run(
        taskId(i),
        `task number ${i}`,
        lane,
        i % 5,
        stamp,
        stamp,
        lane === "Done" ? stamp : null,
      );
    }
    // Dependencies are what make `task_readiness` expensive — a store of
    // isolated rows would measure fast and prove nothing.
    for (let i = 5; i < TASKS; i += 5) {
      dep.run(taskId(i), taskId(i - 5), stamp);
    }
    for (let i = 0; i < NOTES; i++) {
      note.run(
        noteId(i),
        taskId(i),
        // Mostly not handoffs, so the digest's kind filter has to discriminate
        // rather than matching the first row it meets.
        i % 10 === 0 ? "handoff" : "general",
        `body ${i}`,
        "perf @ /perf",
        stamp,
      );
    }
  })();

  return store;
}

/** Median of several runs — one cold measurement is mostly page-cache noise. */
function medianMs(run: () => void, iterations = 5): number {
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    run();
    timings.push(performance.now() - started);
  }
  return timings.sort((a, b) => a - b)[Math.floor(iterations / 2)] as number;
}

describe("board stays cheap enough to run constantly", { timeout: 120_000 }, () => {
  it(`answers board under ${BUDGET_MS}ms on ten thousand tasks`, () => {
    const store = seedLargeStore();

    const elapsed = medianMs(() => readBoard(store));

    // Reported either way: a passing run is the number this ADR's claim now
    // rests on, and a failing one has to say by how much.
    console.log(`board: ${elapsed.toFixed(1)}ms over ${TASKS} tasks`);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it(`answers the digest read under ${BUDGET_MS}ms on five thousand notes`, () => {
    // The unindexed one: `kind` filtered, unscoped, sorted by `created_at`.
    const store = seedLargeStore();

    const elapsed = medianMs(() => latestHandoff(store));

    console.log(`digest: ${elapsed.toFixed(1)}ms over ${NOTES} notes`);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
