import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_SECTION_LIMIT, readBoard } from "../../src/core/board.js";
import { addDependency, ID_CHUNK } from "../../src/core/graph/deps.js";
import { createNote } from "../../src/core/notes/repo.js";
import { BRIEF_HANDOFF_CHARS } from "../../src/core/tasks/brief.js";
import { nextTask } from "../../src/core/tasks/next.js";
import {
  seedClaim,
  seedDep,
  seedEpic,
  seedEvent,
  seedPresence,
  seedTask,
} from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

/** A worktree distinct from the fixture's own identity, for contended claims. */
const OTHER_WORKTREE = "/repo/elsewhere";

/**
 * A pass-through count of `readTx` calls, for the snapshot test below. The
 * wrapper delegates to the real implementation, so every other test in this
 * file runs against genuine transactions.
 */
const readTxSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/core/db/connection.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/db/connection.js")>();
  const readTx: typeof original.readTx = (db, read) => {
    readTxSpy.calls += 1;
    return original.readTx(db, read);
  };
  return { ...original, readTx };
});

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
    const inProgress = seedTask(fixture.store, { lane: "In Progress" });
    seedTask(fixture.store, { lane: "In Review" });
    const planned = seedTask(fixture.store, { lane: "Planned" });
    const defined = seedTask(fixture.store, { lane: "Defined" });
    seedTask(fixture.store, { lane: "Researching" });
    const blocker = seedTask(fixture.store, { lane: "Planned" });
    const stuck = seedTask(fixture.store, { lane: "Planned" });
    seedDep(fixture.store, stuck, blocker);
    // Terminal work is not open at all.
    seedTask(fixture.store, { lane: "Done" });
    seedTask(fixture.store, { lane: "Cancelled" });

    // F4 (spec AC10): a claim moves no task between buckets. One claimed row
    // in flight, ready, blocked and untriaged each, so a claim that quietly
    // shifted a task's bucket would break this same equality.
    seedClaim(fixture.store, { taskId: inProgress, holder: OTHER_WORKTREE });
    seedClaim(fixture.store, { taskId: planned, holder: OTHER_WORKTREE });
    seedClaim(fixture.store, { taskId: stuck, holder: OTHER_WORKTREE });
    seedClaim(fixture.store, { taskId: defined, holder: OTHER_WORKTREE });

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

describe("claims annotate and order the ready section (F4 T7, ADR-012)", () => {
  it("orders other-claimed ready rows after unclaimed ones", () => {
    // The claimed row outranks both on raw priority — a single-claimed-task
    // fixture would pass by luck (iter-2 advisory 10); this seeds two
    // unclaimed rows so their *relative* order (unchanged) is also provable.
    const claimedTop = seedTask(fixture.store, {
      lane: "Planned",
      priority: 0,
      title: "claimed, highest priority",
    });
    seedClaim(fixture.store, { taskId: claimedTop, holder: OTHER_WORKTREE });
    const firstUnclaimed = seedTask(fixture.store, {
      lane: "Planned",
      priority: 1,
      title: "unclaimed, first",
    });
    const secondUnclaimed = seedTask(fixture.store, {
      lane: "Planned",
      priority: 2,
      title: "unclaimed, second",
    });

    const board = readBoard(fixture.store);

    expect(board.ready.tasks.map((t) => t.id)).toEqual([
      firstUnclaimed,
      secondUnclaimed,
      claimedTop,
    ]);
    expect(board.ready.tasks[2]?.claimedElsewhere).toBe(true);
    expect(board.ready.tasks[2]?.claim?.holder).toBe(OTHER_WORKTREE);
    expect(board.ready.tasks[0]?.claimedElsewhere).toBe(false);
    expect(board.ready.tasks[0]?.claim).toBeNull();
  });

  it("keeps every count identical when claims exist", () => {
    // The same fixture "makes the five counts sum to open" uses, so a claim
    // moving a task between buckets would be caught the same way.
    const inProgress = seedTask(fixture.store, { lane: "In Progress" });
    seedTask(fixture.store, { lane: "In Review" });
    const planned = seedTask(fixture.store, { lane: "Planned" });
    seedTask(fixture.store, { lane: "Defined" });
    seedTask(fixture.store, { lane: "Researching" });
    const blocker = seedTask(fixture.store, { lane: "Planned" });
    const stuck = seedTask(fixture.store, { lane: "Planned" });
    seedDep(fixture.store, stuck, blocker);
    seedTask(fixture.store, { lane: "Done" });
    seedTask(fixture.store, { lane: "Cancelled" });

    const before = readBoard(fixture.store).counts;

    seedClaim(fixture.store, { taskId: inProgress, holder: OTHER_WORKTREE });
    seedClaim(fixture.store, { taskId: planned, holder: OTHER_WORKTREE });
    seedClaim(fixture.store, { taskId: stuck, holder: OTHER_WORKTREE });

    const after = readBoard(fixture.store).counts;

    expect(after).toEqual(before);
    expect(after.inFlight + after.ready + after.blocked + after.untriaged).toBe(after.open);
  });

  it("leads ready with next's answer past a higher-ranked claimed task", () => {
    // The unqualified half of the agreement invariant (ADR-012): a task
    // claimed by *another* worktree is excluded from next's candidates
    // outright, so the two commands still agree on the first row even when
    // the claimed task outranks everything else on priority.
    const claimedTop = seedTask(fixture.store, {
      lane: "Planned",
      priority: 0,
      title: "claimed elsewhere, top priority",
    });
    seedClaim(fixture.store, { taskId: claimedTop, holder: OTHER_WORKTREE });
    seedTask(fixture.store, { lane: "Planned", priority: 1, title: "free to take" });

    const board = readBoard(fixture.store);
    const next = nextTask(fixture.store);

    if (next.status !== "found") throw new Error("unreachable");
    expect(board.ready.tasks[0]?.id).toBe(next.task.id);
    expect(board.ready.tasks[0]?.id).not.toBe(claimedTop);
  });

  it("resumes an own claim next offers but the board does not lead with", () => {
    // The pinned, deliberate divergence ADR-012 carves out: next ranks an
    // own Planned claim first among candidates so a session that loses
    // context resumes it; the board applies no such promotion, so it leads
    // with the top-priority unclaimed row instead. A single command
    // asserting agreement would never catch the two silently disagreeing —
    // this test calls both to prove they intentionally do not.
    const own = fixture.store.identity().worktree;
    const resumed = seedTask(fixture.store, {
      lane: "Planned",
      priority: 4,
      title: "resume this",
    });
    seedClaim(fixture.store, { taskId: resumed, holder: own });
    const topOfBacklog = seedTask(fixture.store, {
      lane: "Planned",
      priority: 0,
      title: "top of the backlog, unclaimed",
    });

    const next = nextTask(fixture.store);
    const board = readBoard(fixture.store);

    if (next.status !== "found") throw new Error("unreachable");
    expect(next.task.id).toBe(resumed);
    expect(board.ready.tasks[0]?.id).toBe(topOfBacklog);
    expect(board.ready.tasks[0]?.id).not.toBe(next.task.id);
    // Not excluded, and not tiered with "elsewhere" claims either — an own
    // claim is unclaimed as far as the board's ordering is concerned, simply
    // out-ranked here on plain priority within that tier.
    const resumedRow = board.ready.tasks.find((t) => t.id === resumed);
    expect(resumedRow?.claimedElsewhere).toBe(false);
    expect(resumedRow?.claim?.holder).toBe(own);
  });

  it("carries claim data on in-flight and blocked rows too", () => {
    // Display is uniform: only the ready section orders by claim data, but
    // every section carries it (ADR-012).
    const started = seedTask(fixture.store, { lane: "In Progress", title: "underway" });
    seedClaim(fixture.store, { taskId: started, holder: OTHER_WORKTREE });
    seedPresence(fixture.store, { worktree: OTHER_WORKTREE, branch: "feature/other" });

    const blocker = seedTask(fixture.store, { lane: "Planned", title: "the blocker" });
    const stuck = seedTask(fixture.store, { lane: "Planned", title: "stuck" });
    addDependency(fixture.store, stuck, blocker);
    seedClaim(fixture.store, { taskId: stuck, holder: OTHER_WORKTREE });

    const board = readBoard(fixture.store);

    const inFlightRow = board.inFlight.tasks.find((t) => t.id === started);
    expect(inFlightRow?.claim?.holder).toBe(OTHER_WORKTREE);
    expect(inFlightRow?.claim?.branch).toBe("feature/other");
    expect(inFlightRow?.claimedElsewhere).toBe(true);

    const blockedRow = board.blocked.tasks.find((t) => t.id === stuck);
    expect(blockedRow?.claim?.holder).toBe(OTHER_WORKTREE);
    expect(blockedRow?.claimedElsewhere).toBe(true);
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
    // The fixture's own `createStoreFixture` call already bumped presence once
    // — every `openStore` does (ADR-011) — so a bare zero-row assertion below
    // would fail on line one and prove nothing about `readBoard` itself
    // (plan-review iter-2 advisory 5). Delete that row so the table starts
    // empty, then call the core function directly: `readBoard` is
    // heartbeat-free — the bump lives in `openStore`, not here — so the table
    // must stay empty through the call.
    fixture.store.db.prepare("DELETE FROM presence").run();
    const before = fixture.store.db.prepare("SELECT COUNT(*) c FROM events").get();

    readBoard(fixture.store);

    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual(before);
    expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM presence").get()).toEqual({ c: 0 });
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

describe("each blocked task gets its own blockers", () => {
  it("does not hand every blocked task the union of all blockers", () => {
    // The bug a per-row-to-batched rewrite introduces, and the only part of the
    // batching that a single-blocked-task fixture cannot see: one shared query
    // grouped by the wrong key gives every row everyone else's blockers.
    const firstBlocker = seedTask(fixture.store, { lane: "Planned", title: "blocks the first" });
    const secondBlocker = seedTask(fixture.store, { lane: "Planned", title: "blocks the second" });
    const first = seedTask(fixture.store, { lane: "Planned", title: "first" });
    const second = seedTask(fixture.store, { lane: "Planned", title: "second" });
    addDependency(fixture.store, first, firstBlocker);
    addDependency(fixture.store, second, secondBlocker);

    const blocked = readBoard(fixture.store).blocked.tasks;

    expect(blocked).toHaveLength(2);
    for (const task of blocked) {
      expect(task.blockers).toHaveLength(1);
    }
    const byId = new Map(blocked.map((task) => [task.id, task.blockers[0]?.id]));
    expect(byId.get(first)).toBe(firstBlocker);
    expect(byId.get(second)).toBe(secondBlocker);
  });

  it("gives a task with several blockers all of them, ranked", () => {
    const high = seedTask(fixture.store, { lane: "Planned", priority: 0, title: "high" });
    const low = seedTask(fixture.store, { lane: "Planned", priority: 4, title: "low" });
    const stuck = seedTask(fixture.store, { lane: "Planned", title: "stuck" });
    addDependency(fixture.store, stuck, low);
    addDependency(fixture.store, stuck, high);

    const found = readBoard(fixture.store).blocked.tasks.find((task) => task.id === stuck);

    expect(found?.blockers.map((blocker) => blocker.id)).toEqual([high, low]);
  });

  it("gives each row its own blockers past the chunk boundary", () => {
    // One pair past ID_CHUNK, so the batched read must cross a chunk boundary.
    // Seeded in one transaction: a thousand auto-commit inserts would measure
    // the write path, which is not what this test is about.
    const pairs = new Map<string, string>();
    fixture.store.db.transaction(() => {
      for (let i = 0; i < ID_CHUNK + 1; i++) {
        const blocker = seedTask(fixture.store, { lane: "Planned", title: `blocks ${i}` });
        const stuck = seedTask(fixture.store, { lane: "Planned", title: `stuck ${i}` });
        seedDep(fixture.store, stuck, blocker);
        pairs.set(stuck, blocker);
      }
    })();

    const blocked = readBoard(fixture.store, { limit: ID_CHUNK + 1 }).blocked.tasks;

    expect(blocked).toHaveLength(ID_CHUNK + 1);
    // Every row, not a sample: a read that stops at the first chunk leaves the
    // tail marked blocked with an empty blocker list.
    for (const row of blocked) {
      expect(row.blockers.map((blocker) => blocker.id)).toEqual([pairs.get(row.id)]);
    }
  });
});

describe("the board reads inside one snapshot", () => {
  it("opens exactly one read transaction per board call, digest included", () => {
    // Requirement 7d's mechanism. A single-threaded suite cannot stage a torn
    // read — five auto-commit reads return the same answer when nobody writes
    // between them — so the test pins the transaction count instead. Zero
    // means `readTx` was dropped; two means the digest read outside the
    // snapshot, which is the bug the command layer shipped once.
    const task = seedTask(fixture.store, { lane: "In Review" });
    createNote(fixture.store, { taskId: task, body: "a handoff", kind: "handoff" });

    readTxSpy.calls = 0;
    readBoard(fixture.store);
    expect(readTxSpy.calls).toBe(1);

    readTxSpy.calls = 0;
    readBoard(fixture.store, { digest: true, limit: 3 });
    expect(readTxSpy.calls).toBe(1);
  });
});

describe("recent and untrusted event fields", () => {
  it("one-lines a hostile ref and entity id", async () => {
    // `events.ref` and `events.entity_id` have no CHECK constraint — today only
    // generated ids reach them, but F5 routes external refs through `ref`, and
    // the seed helper writes what production cannot yet. Built by codepoint so
    // no invisible literal sits in test source.
    const { formatBoard } = await import("../../src/cli/format.js");
    const ESC = String.fromCharCode(0x1b);
    const NL = String.fromCharCode(0x0a);
    seedEvent(fixture.store, {
      entityId: `kt-evil${ESC}[31m${NL}flush`,
      ref: `nt-x${NL}cut`,
    });

    const out = formatBoard(readBoard(fixture.store));

    expect(out).not.toContain(ESC);
    // An embedded newline would give stored text its own flush-left line,
    // indistinguishable from a line the board itself printed.
    expect(out).not.toMatch(/^flush/m);
    expect(out).not.toMatch(/^cut/m);
  });

  it("aligns the event-type column the same whether or not a ref-status-changed row is present (F8 T6)", async () => {
    // `ref-status-changed` (18 characters) overflowed the old hardcoded
    // `padTo(event.type, 14)`: `padTo` never truncates, so nothing was cut,
    // but every row after that one shifted its trailing columns four
    // characters right of every shorter-typed row.
    //
    // Both events share one entityId and no title so the type column is the
    // only thing that can vary in width between the two rows — entityId and
    // title are rendered unpadded here, unlike formatEventLog's own columns,
    // so a differing entityId length would otherwise confound the offset
    // comparison below.
    const { formatBoard } = await import("../../src/cli/format.js");
    const ENTITY = "kt-000001";
    seedEvent(fixture.store, { type: "created", entityId: ENTITY, reason: "reason-a" });
    seedEvent(fixture.store, {
      type: "ref-status-changed",
      entityId: ENTITY,
      reason: "open -> merged",
    });

    const out = formatBoard(readBoard(fixture.store));

    const createdRow = out.split("\n").find((line) => line.includes("reason-a"));
    const refRow = out.split("\n").find((line) => line.includes("open -> merged"));
    expect(createdRow).toBeDefined();
    expect(refRow).toBeDefined();
    expect(createdRow?.indexOf("reason-a")).toBe(refRow?.indexOf("open -> merged"));
  });
});
