/**
 * Are `search`, `recent` and `stale` cheap enough at real scale, and do they
 * stay cheap under a shape built to punish exactly the mechanisms they lean
 * on? `board.perf.test.ts` is this file's register — median-of-5, every
 * measurement printed, a stated budget so the test can fail rather than just
 * "record a number".
 *
 * **Two runs, two different jobs (plan-review MEDIUM-8) — never conflate
 * them:**
 *
 * - **The req-11 receipt** (`"answers ... at the real ~150-task scale"`):
 *   requirement 11 pins the budget to "the current ~150-item store" and
 *   reuses the board's own 250ms read budget. This run seeds that exact
 *   shape and is the literal evidence for that sentence in the spec. A store
 *   this small can never discriminate a healthy read from a quadratic one —
 *   both finish under 250ms — so passing here proves the spec's own
 *   criterion and nothing more about the mechanism's *scaling* behaviour.
 * - **The discriminating gate** (`"stays inside budget on a hostile
 *   ten-thousand-task seed"`): a 150-row store can never fail this kind of
 *   test, which is the exact anti-pattern board.perf's own docstring warns
 *   against — record a number nothing can move. This run seeds at
 *   `board.perf.test.ts`'s own 10k-row register, shaped at the three places
 *   these reads actually spend time: every task carries the same indexed
 *   term (a long FTS5 posting list, not a needle-in-nothing lookup), a
 *   subset of tasks carry many notes each (the rollup's per-entity fan-in,
 *   `search.ts`'s `PARTITION BY entity_id` window functions), and every
 *   task carries several events, not one (`activity.ts`'s shared
 *   `GROUP BY entity_id` aggregate, the join `search`/`recent`/`stale` all
 *   three depend on). A quadratic regression in any of those three has real
 *   room to blow a 250ms budget here; a correct O(n log n)-ish mechanism
 *   does not.
 *
 * **Plus the write-path tax**: a single `createTask`/`createNote` against a
 * store whose FTS5 sync triggers are live (migration 0004, ADR-013) — not a
 * benchmark, a generous 100ms bound that discriminates "the trigger fires
 * once, cheaply" from "the trigger regressed to a per-row explosion or a
 * quadratic rebuild", the same F3/F4 CI-timing doctrine `presence.test.ts`'s
 * probe bound documents: tightening this number buys nothing but flakes on a
 * loaded runner, and a healthy insert measures in the sub-millisecond range,
 * nowhere near the bound.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readRecent, readStale } from "../../src/core/activity.js";
import { createNote } from "../../src/core/notes/repo.js";
import { readSearch } from "../../src/core/search.js";
import type { OpenStore } from "../../src/core/store.js";
import { openStore } from "../../src/core/store.js";
import { createTask } from "../../src/core/tasks/repo.js";
import { createGitRepo } from "../helpers/fixture.js";
import { createStoreFixture } from "../helpers/store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

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

const STAMP = "2026-01-01T00:00:00.000Z";
const STALE_CUTOFF = "2026-06-01T00:00:00.000Z";
const LANES = ["Defined", "Researching", "Planned", "In Progress", "In Review", "Done"];

// --- Run (a): the req-11 receipt --------------------------------------------

const REAL_TASKS = 150;
const REAL_NOTES = 80;
/** requirement 11's own budget — the board's read budget, reused verbatim. */
const REAL_BUDGET_MS = 250;
/** The word measured queries search for — present on roughly one task in six. */
const REAL_TERM = "widget";

/** A store shaped like the spec's own "~150 tasks, ~80 notes" receipt scale. */
function seedRealisticStore(): OpenStore {
  const repo = createGitRepo();
  cleanups.push(() => repo.cleanup());
  const { store } = openStore(repo.dir, { createIfMissing: true, actor: () => "perf @ /perf" });
  cleanups.push(() => store.close());

  const taskId = (n: number): string => `kt-${n.toString(36).padStart(6, "0")}`;
  const noteId = (n: number): string => `nt-${n.toString(36).padStart(6, "0")}`;
  const task = store.db.prepare(
    "INSERT INTO tasks (id,level,kind,title,description,lane,priority,created_at,updated_at,closed_at) VALUES (?,'task','feat',?,?,?,?,?,?,?)",
  );
  const note = store.db.prepare(
    "INSERT INTO notes (id,task_id,kind,body,actor,created_at) VALUES (?,?,?,?,?,?)",
  );
  const event = store.db.prepare(
    "INSERT INTO events (type,entity_id,actor,created_at) VALUES ('created',?,?,?)",
  );

  store.db.transaction(() => {
    for (let i = 0; i < REAL_TASKS; i++) {
      const lane = LANES[i % LANES.length] as string;
      const description =
        i % 6 === 0 ? `revisit the ${REAL_TERM} migration plan for area ${i}` : null;
      task.run(
        taskId(i),
        `task number ${i} covering some ordinary work`,
        description,
        lane,
        i % 5,
        STAMP,
        STAMP,
        lane === "Done" ? STAMP : null,
      );
      event.run(taskId(i), "perf @ /perf", STAMP);
    }
    for (let i = 0; i < REAL_NOTES; i++) {
      note.run(
        noteId(i),
        taskId(i % REAL_TASKS),
        i % 7 === 0 ? "handoff" : "general",
        i % 4 === 0 ? `${REAL_TERM} follow-up note ${i}` : `ordinary note body ${i}`,
        "perf @ /perf",
        STAMP,
      );
    }
  })();

  return store;
}

// --- Run (b): the discriminating gate ---------------------------------------

/** `board.perf.test.ts`'s own 10k-row register — reused, not reinvented. */
const HOSTILE_TASKS = 10_000;
/** Deep event history: several events per task, stressing the shared `GROUP BY entity_id` aggregate. */
const HOSTILE_EVENTS_PER_TASK = 5;
/** How many of the hostile tasks carry a pile of notes, for the rollup's fan-in. */
const HOSTILE_NOTE_TASKS = 200;
const HOSTILE_NOTES_PER_TASK = 25;
/** Reused across `board.perf.test.ts`'s own hostile-seed budget for a 10k-row store. */
const HOSTILE_BUDGET_MS = 250;
/**
 * A word invented for this test, present on every task and every seeded
 * note — a long, fully controlled FTS5 posting list a real query would have
 * to walk in full, not a needle a healthy index finds in a handful of steps.
 */
const SHARED_TERM = "gizmoport";

/** A store shaped at the three actual cost centers `search`/`recent`/`stale` share. */
function seedHostileStore(): OpenStore {
  const repo = createGitRepo();
  cleanups.push(() => repo.cleanup());
  const { store } = openStore(repo.dir, { createIfMissing: true, actor: () => "perf @ /perf" });
  cleanups.push(() => store.close());

  const taskId = (n: number): string => `kt-${n.toString(36).padStart(6, "0")}`;
  const noteId = (n: number): string => `nt-${n.toString(36).padStart(6, "0")}`;
  const task = store.db.prepare(
    "INSERT INTO tasks (id,level,kind,title,description,lane,priority,created_at,updated_at,closed_at) VALUES (?,'task','feat',?,?,?,?,?,?,?)",
  );
  const note = store.db.prepare(
    "INSERT INTO notes (id,task_id,kind,body,actor,created_at) VALUES (?,?,?,?,?,?)",
  );
  const event = store.db.prepare(
    "INSERT INTO events (type,entity_id,actor,created_at) VALUES ('created',?,?,?)",
  );

  store.db.transaction(() => {
    for (let i = 0; i < HOSTILE_TASKS; i++) {
      const lane = LANES[i % LANES.length] as string;
      task.run(
        taskId(i),
        `hostile task ${i}`,
        `${SHARED_TERM} candidate number ${i}`,
        lane,
        i % 5,
        STAMP,
        STAMP,
        lane === "Done" ? STAMP : null,
      );
      for (let e = 0; e < HOSTILE_EVENTS_PER_TASK; e++) {
        event.run(taskId(i), "perf @ /perf", STAMP);
      }
    }

    let noteSeq = 0;
    const noteStride = Math.floor(HOSTILE_TASKS / HOSTILE_NOTE_TASKS);
    for (let i = 0; i < HOSTILE_TASKS; i += noteStride) {
      for (let n = 0; n < HOSTILE_NOTES_PER_TASK; n++) {
        note.run(
          noteId(noteSeq),
          taskId(i),
          "general",
          `${SHARED_TERM} note ${noteSeq} on task ${i}`,
          "perf @ /perf",
          STAMP,
        );
        noteSeq++;
      }
    }
  })();

  return store;
}

describe("search/recent/stale stay cheap enough to run constantly", { timeout: 120_000 }, () => {
  it(`answers search, recent and stale under ${REAL_BUDGET_MS}ms at the real ~150-task, ~80-note scale (req 11 receipt)`, () => {
    const store = seedRealisticStore();

    const searchElapsed = medianMs(() => readSearch(store, { query: REAL_TERM }));
    console.log(`search "${REAL_TERM}": ${searchElapsed.toFixed(1)}ms over ${REAL_TASKS} tasks`);
    expect(searchElapsed).toBeLessThan(REAL_BUDGET_MS);

    const recentElapsed = medianMs(() => readRecent(store));
    console.log(`recent: ${recentElapsed.toFixed(1)}ms over ${REAL_TASKS} tasks`);
    expect(recentElapsed).toBeLessThan(REAL_BUDGET_MS);

    const staleElapsed = medianMs(() => readStale(store, { olderThan: STALE_CUTOFF }));
    console.log(`stale: ${staleElapsed.toFixed(1)}ms over ${REAL_TASKS} tasks`);
    expect(staleElapsed).toBeLessThan(REAL_BUDGET_MS);
  });

  it(`stays under ${HOSTILE_BUDGET_MS}ms on a ${HOSTILE_TASKS}-task hostile seed shaped at the rollup fan-in, the shared-term posting list and deep event history (discriminating gate)`, () => {
    const store = seedHostileStore();

    const searchElapsed = medianMs(() => readSearch(store, { query: SHARED_TERM }));
    console.log(
      `search "${SHARED_TERM}": ${searchElapsed.toFixed(1)}ms over ${HOSTILE_TASKS} tasks`,
    );
    expect(searchElapsed).toBeLessThan(HOSTILE_BUDGET_MS);

    const recentElapsed = medianMs(() => readRecent(store));
    console.log(
      `recent: ${recentElapsed.toFixed(1)}ms over ${HOSTILE_TASKS} tasks, ${HOSTILE_TASKS * HOSTILE_EVENTS_PER_TASK} events`,
    );
    expect(recentElapsed).toBeLessThan(HOSTILE_BUDGET_MS);

    const staleElapsed = medianMs(() => readStale(store, { olderThan: STALE_CUTOFF }));
    console.log(
      `stale: ${staleElapsed.toFixed(1)}ms over ${HOSTILE_TASKS} tasks, ${HOSTILE_TASKS * HOSTILE_EVENTS_PER_TASK} events`,
    );
    expect(staleElapsed).toBeLessThan(HOSTILE_BUDGET_MS);
  });

  // --- The write-path tax ---------------------------------------------------

  const WRITE_TAX_BUDGET_MS = 100;

  it(`keeps a single task-add and note-add under ${WRITE_TAX_BUDGET_MS}ms with the FTS5 sync triggers live`, () => {
    const fixture = createStoreFixture({ actor: "perf @ /perf" });
    cleanups.push(fixture.cleanup);
    const { store } = fixture;

    let taskCounter = 0;
    const taskElapsed = medianMs(() => {
      taskCounter += 1;
      createTask(store, {
        title: `write-tax task ${taskCounter}`,
        description: "measuring the tasks_fts_ai trigger's cost on an ordinary insert",
      });
    });
    console.log(`task-add: ${taskElapsed.toFixed(2)}ms with FTS triggers live`);
    // Not a benchmark: this discriminates "the trigger fires once, cheaply"
    // from "the trigger regressed to a per-row explosion or a quadratic
    // rebuild" — a healthy insert measures well under a millisecond, nowhere
    // near this bound. See this file's docstring.
    expect(taskElapsed).toBeLessThan(WRITE_TAX_BUDGET_MS);

    const noteTarget = createTask(store, { title: "note-add measurement target" }).id;
    const noteElapsed = medianMs(() => {
      createNote(store, {
        taskId: noteTarget,
        body: "measuring the notes_fts_ai trigger's cost on an ordinary insert",
      });
    });
    console.log(`note-add: ${noteElapsed.toFixed(2)}ms with FTS triggers live`);
    expect(noteElapsed).toBeLessThan(WRITE_TAX_BUDGET_MS);
  });
});
