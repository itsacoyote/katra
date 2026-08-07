import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_SECTION_LIMIT, readBoard } from "../../src/core/board.js";
import { addDependency } from "../../src/core/graph/deps.js";
import { createNote } from "../../src/core/notes/repo.js";
import { BRIEF_HANDOFF_CHARS } from "../../src/core/tasks/brief.js";
import { nextTask } from "../../src/core/tasks/next.js";
import { seedDep, seedEpic, seedEvent, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture({ actor: "feature/f3 @ /repo/wt-f3" });
});
afterEach(() => fixture.cleanup());

describe("the counts partition open", () => {
  it("makes the five counts sum to open", () => {
    // The arithmetic the first draft of this design got wrong. `in flight`
    // takes two lanes, `ready` takes startable Planned work, `blocked` takes
    // what cannot start — and startable Defined/Researching tasks fall through
    // all three. Without the fifth count, 2 + 6 + 3 never equalled 14.
    seedTask(fixture.store, { lane: "In Progress" });
    seedTask(fixture.store, { lane: "In Review" });
    seedTask(fixture.store, { lane: "Planned" });
    seedTask(fixture.store, { lane: "Defined" });
    seedTask(fixture.store, { lane: "Researching" });
    const blocker = seedTask(fixture.store, { lane: "Planned" });
    const stuck = seedTask(fixture.store, { lane: "Planned" });
    seedDep(fixture.store, stuck, blocker);
    // Terminal work is not open at all.
    seedTask(fixture.store, { lane: "Done" });
    seedTask(fixture.store, { lane: "Cancelled" });

    const { counts } = readBoard(fixture.store);

    expect(counts.inFlight + counts.ready + counts.blocked + counts.untriaged).toBe(counts.open);
    expect(counts.open).toBe(7);
  });

  it("counts open as non-terminal tasks, excluding Done, Cancelled and epics", () => {
    seedEpic(fixture.store, { lane: "Planned" });
    seedTask(fixture.store, { lane: "Planned" });
    seedTask(fixture.store, { lane: "Done" });
    seedTask(fixture.store, { lane: "Cancelled" });

    expect(readBoard(fixture.store).counts.open).toBe(1);
  });

  it("counts a startable Defined task as untriaged, not as ready", () => {
    // `add` writes into Defined, so this is the ordinary state of new work —
    // and calling it ready would have the board offer something `next` will
    // not.
    seedTask(fixture.store, { lane: "Defined" });

    const { counts } = readBoard(fixture.store);

    expect(counts.untriaged).toBe(1);
    expect(counts.ready).toBe(0);
  });

  it("reports a different untriaged count than next for the same store", () => {
    // The names collide on purpose and the meanings do not. `next` counts
    // everything outside Planned regardless of readiness, including work in
    // progress; the board counts only startable work nobody has planned.
    seedTask(fixture.store, { lane: "In Progress" });
    seedTask(fixture.store, { lane: "Defined" });

    const board = readBoard(fixture.store).counts.untriaged;
    const result = nextTask(fixture.store);

    if (result.status !== "none") throw new Error("unreachable");
    expect(board).toBe(1);
    expect(result.untriaged).toBe(2);
  });

  it("reports the true ready total when the section is capped", () => {
    // A header that shrank to match the cap would state a backlog size that is
    // not true — the one thing an orientation view must never do.
    for (let i = 0; i < BOARD_SECTION_LIMIT + 5; i++) {
      seedTask(fixture.store, { lane: "Planned", title: `task ${i}` });
    }

    const board = readBoard(fixture.store, { limit: 2 });

    expect(board.counts.ready).toBe(BOARD_SECTION_LIMIT + 5);
    expect(board.ready.tasks).toHaveLength(2);
    expect(board.ready.truncated).toBe(true);
  });
});

describe("sections", () => {
  it("puts an In Progress task under in flight and a blocked task under blocked", () => {
    const started = seedTask(fixture.store, { lane: "In Progress", title: "underway" });
    const blocker = seedTask(fixture.store, { lane: "Planned", title: "the blocker" });
    const stuck = seedTask(fixture.store, { lane: "Planned", title: "stuck" });
    addDependency(fixture.store, stuck, blocker);

    const board = readBoard(fixture.store);

    expect(board.inFlight.tasks.map((t) => t.id)).toEqual([started]);
    expect(board.blocked.tasks.map((t) => t.id)).toEqual([stuck]);
    expect(board.blocked.tasks[0]?.blockers.map((b) => b.title)).toEqual(["the blocker"]);
  });

  it("leads ready with the task next returns", () => {
    // Asserted against `next` itself, never a hard-coded id: a literal would
    // still pass when the two queries drifted apart, which is the entire
    // failure this pins.
    seedTask(fixture.store, { lane: "Planned", priority: 3, title: "later" });
    seedTask(fixture.store, { lane: "Planned", priority: 0, title: "first" });
    seedTask(fixture.store, { lane: "Planned", priority: 1, title: "second" });

    const board = readBoard(fixture.store);
    const next = nextTask(fixture.store);

    if (next.status !== "found") throw new Error("unreachable");
    expect(board.ready.tasks[0]?.id).toBe(next.task.id);
  });

  it("shows a blocked in-flight task once, under in flight, marked blocked", () => {
    // Lane and readiness are independent conditions, and `addDependency` has no
    // lane restriction — so a task somebody is part-way through can acquire a
    // blocker and satisfy both definitions.
    const blocker = seedTask(fixture.store, { lane: "Planned" });
    const started = seedTask(fixture.store, { lane: "In Progress", title: "underway" });
    addDependency(fixture.store, started, blocker);

    const board = readBoard(fixture.store);

    expect(board.inFlight.tasks.map((t) => t.id)).toEqual([started]);
    expect(board.inFlight.tasks[0]?.blocked).toBe(true);
    expect(board.blocked.tasks.map((t) => t.id)).not.toContain(started);
  });

  it("keeps blocked in-flight tasks out of blocked even past the in-flight cap", () => {
    // The case a post-filter over rendered rows gets wrong. With more blocked
    // in-flight tasks than the cap, filtering `blocked` against what in-flight
    // *displayed* lets the overflow reappear — while the uncapped counts still
    // book them as in flight, so the header stops reconciling.
    const blocker = seedTask(fixture.store, { lane: "Planned" });
    const started: string[] = [];
    for (let i = 0; i < BOARD_SECTION_LIMIT + 4; i++) {
      const id = seedTask(fixture.store, { lane: "In Progress", title: `underway ${i}` });
      addDependency(fixture.store, id, blocker);
      started.push(id);
    }

    const board = readBoard(fixture.store, { limit: 2 });

    expect(board.inFlight.tasks).toHaveLength(2);
    expect(board.inFlight.truncated).toBe(true);
    for (const id of started) {
      expect(board.blocked.tasks.map((t) => t.id)).not.toContain(id);
    }
    expect(board.counts.blocked).toBe(0);
    expect(board.counts.inFlight).toBe(BOARD_SECTION_LIMIT + 4);
  });

  it("omits an In Progress epic and a blocked epic from every section", () => {
    // Excluding epics from `ready` alone would give a board that refuses to
    // offer an epic as work while showing it as work in progress.
    const running = seedEpic(fixture.store, { lane: "In Progress" });
    const blocker = seedTask(fixture.store, { lane: "Planned" });
    const stuckEpic = seedEpic(fixture.store, { lane: "Planned" });
    seedDep(fixture.store, stuckEpic, blocker);

    const board = readBoard(fixture.store);
    const ids = [...board.inFlight.tasks, ...board.ready.tasks, ...board.blocked.tasks].map(
      (t) => t.id,
    );

    expect(ids).not.toContain(running);
    expect(ids).not.toContain(stuckEpic);
    expect(board.counts.inFlight).toBe(0);
    expect(board.counts.blocked).toBe(0);
  });

  it("reports truncation per section", () => {
    for (let i = 0; i < 4; i++) {
      seedTask(fixture.store, { lane: "In Progress", title: `flight ${i}` });
      seedTask(fixture.store, { lane: "Planned", title: `ready ${i}` });
    }

    const board = readBoard(fixture.store, { limit: 2 });

    expect(board.inFlight.truncated).toBe(true);
    expect(board.ready.truncated).toBe(true);
    expect(board.blocked.truncated).toBe(false);
  });

  it("returns empty sections rather than absent ones on an empty store", () => {
    // Fixed shape: a consumer can rely on the top-level keys existing whatever
    // the store holds.
    const board = readBoard(fixture.store);

    expect(board.inFlight.tasks).toEqual([]);
    expect(board.ready.tasks).toEqual([]);
    expect(board.blocked.tasks).toEqual([]);
    expect(board.recent).toEqual([]);
    expect(board.digest).toBeNull();
    expect(board.pointer).toBeNull();
    expect(board.counts.open).toBe(0);
  });
});

describe("the pointer", () => {
  it("carries the pointer when everything sits in Defined", () => {
    for (let i = 0; i < 12; i++) seedTask(fixture.store, { lane: "Defined" });

    const board = readBoard(fixture.store);

    expect(board.pointer).toContain("12 tasks");
    expect(board.pointer).toContain("Planned");
  });

  it("does not carry the pointer merely because --limit 0 emptied the sections", () => {
    // The trigger is the counts, never the rendered rows: sections are capped,
    // and a cap of zero empties all three while the backlog is untouched.
    seedTask(fixture.store, { lane: "Planned" });
    seedTask(fixture.store, { lane: "Defined" });

    const board = readBoard(fixture.store, { limit: 0 });

    expect(board.ready.tasks).toEqual([]);
    expect(board.pointer).toBeNull();
  });

  it("stays silent when there is startable planned work", () => {
    seedTask(fixture.store, { lane: "Planned" });
    seedTask(fixture.store, { lane: "Defined" });

    expect(readBoard(fixture.store).pointer).toBeNull();
  });
});

describe("board writes nothing", () => {
  it("leaves the event count unchanged and opens no write transaction", () => {
    seedTask(fixture.store, { lane: "Planned" });
    const before = fixture.store.db.prepare("SELECT COUNT(*) c FROM events").get();

    readBoard(fixture.store);

    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual(before);
    expect(fixture.store.db.inTransaction).toBe(false);
  });
});

describe("recent is a section like any other", () => {
  it("bounds recent with the same limit as the task sections", () => {
    // It was hard-wired to its own constant, so `--limit 0` emptied the three
    // task sections and still printed eight activity rows — a section both the
    // spec and ADR-009 say `--limit` bounds.
    for (let i = 0; i < 6; i++) seedTask(fixture.store, { lane: "Planned" });
    const task = seedTask(fixture.store, { lane: "Planned" });
    for (let i = 0; i < 6; i++) {
      seedEvent(fixture.store, { type: "created", entityId: task });
    }

    const board = readBoard(fixture.store, { limit: 2 });

    expect(board.recent).toHaveLength(2);
    expect(board.recentTruncated).toBe(true);
  });

  it("returns no activity at all under --limit 0", () => {
    const task = seedTask(fixture.store);
    seedEvent(fixture.store, { type: "created", entityId: task });

    expect(readBoard(fixture.store, { limit: 0 }).recent).toEqual([]);
  });
});

describe("the digest reads inside the same snapshot", () => {
  it("carries the handoff and its task's lane when asked", () => {
    const task = seedTask(fixture.store, { title: "the task", lane: "In Review" });
    createNote(fixture.store, { taskId: task, body: "a handoff", kind: "handoff" });

    const board = readBoard(fixture.store, { digest: true });

    expect(board.digest).toMatchObject({
      taskId: task,
      taskTitle: "the task",
      taskLane: "In Review",
      truncated: false,
    });
    expect(board.digest?.note.body).toBe("a handoff");
  });

  it("stays null when the flag is not passed", () => {
    const task = seedTask(fixture.store);
    createNote(fixture.store, { taskId: task, body: "a handoff", kind: "handoff" });

    expect(readBoard(fixture.store).digest).toBeNull();
  });

  it("caps the digest body at the same bound brief uses, and reports it", () => {
    // The real cap, not an injected one: an option nothing ships would only be
    // exercised here, which is the shape of a bound nobody actually gets.
    const task = seedTask(fixture.store);
    createNote(fixture.store, {
      taskId: task,
      body: "x".repeat(BRIEF_HANDOFF_CHARS + 50),
      kind: "handoff",
    });

    const board = readBoard(fixture.store, { digest: true });

    expect(board.digest?.truncated).toBe(true);
    expect(board.digest?.note.body).toHaveLength(BRIEF_HANDOFF_CHARS);
  });
});
