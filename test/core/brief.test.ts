import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKatraException } from "../../src/core/errors.js";
import { addDependency } from "../../src/core/graph/deps.js";
import { createNote } from "../../src/core/notes/repo.js";
import {
  BRIEF_CHILDREN_PER_LANE,
  BRIEF_HANDOFF_CHARS,
  briefEntity,
} from "../../src/core/tasks/brief.js";
import { seedEpic, seedEvent, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

const ACTOR = "feature/f3 @ /repo/wt-f3";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture({ actor: ACTOR });
});
afterEach(() => fixture.cleanup());

function events(): number {
  return (fixture.store.db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
}

describe("briefEntity on a task", () => {
  it("returns the latest handoff body in full", () => {
    // The whole point of the command: one call, no second read for the body.
    const task = seedTask(fixture.store, { title: "a task" });
    createNote(fixture.store, { taskId: task, body: "older", kind: "handoff" });
    createNote(fixture.store, { taskId: task, body: "what I actually need", kind: "handoff" });

    const brief = briefEntity(fixture.store, task);

    expect(brief.level).toBe("task");
    expect(brief.handoff?.note.body).toBe("what I actually need");
    expect(brief.handoff?.truncated).toBe(false);
  });

  it("truncates a handoff longer than the cap and reports it", () => {
    const task = seedTask(fixture.store);
    createNote(fixture.store, {
      taskId: task,
      body: "x".repeat(BRIEF_HANDOFF_CHARS + 100),
      kind: "handoff",
    });

    const brief = briefEntity(fixture.store, task);

    expect(brief.handoff?.truncated).toBe(true);
    expect([...(brief.handoff?.note.body ?? "")]).toHaveLength(BRIEF_HANDOFF_CHARS);
  });

  it("does not truncate under --full, however long the body is", () => {
    // Sized past any multiple of the default cap on purpose. An earlier version
    // multiplied the cap by twenty instead of removing it, and a body of
    // `cap + 100` passed for every multiplier ≥ 2 — so the test could not tell
    // a lifted bound from one that had merely moved. The spec's own edge case
    // is a 200 KB paste, which a ×20 cap still cuts.
    const task = seedTask(fixture.store);
    const body = "x".repeat(BRIEF_HANDOFF_CHARS * 50);
    createNote(fixture.store, { taskId: task, body, kind: "handoff" });

    const brief = briefEntity(fixture.store, task, { full: true });

    expect(brief.handoff?.truncated).toBe(false);
    expect(brief.handoff?.note.body).toBe(body);
  });

  it("caps a handoff on a code-point boundary", () => {
    // The cap runs over pasted transcripts, where a non-BMP character sitting
    // on the boundary is likely rather than exotic. A raw slice emits a lone
    // surrogate, which is not valid Unicode and breaks the --json contract.
    const task = seedTask(fixture.store);
    createNote(fixture.store, {
      taskId: task,
      body: "🜃".repeat(BRIEF_HANDOFF_CHARS + 10),
      kind: "handoff",
    });

    const body = briefEntity(fixture.store, task).handoff?.note.body ?? "";

    expect([...body]).toHaveLength(BRIEF_HANDOFF_CHARS);
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("counts remaining notes by kind", () => {
    const task = seedTask(fixture.store);
    createNote(fixture.store, { taskId: task, body: "h", kind: "handoff" });
    createNote(fixture.store, { taskId: task, body: "d1", kind: "decision" });
    createNote(fixture.store, { taskId: task, body: "d2", kind: "decision" });

    expect(briefEntity(fixture.store, task).noteCounts).toEqual({ handoff: 1, decision: 2 });
  });

  it("carries blockers and what the task blocks", () => {
    const task = seedTask(fixture.store, { title: "blocked" });
    const blocker = seedTask(fixture.store, { title: "the blocker" });
    const dependent = seedTask(fixture.store, { title: "waiting on it" });
    addDependency(fixture.store, task, blocker);
    addDependency(fixture.store, dependent, task);

    const brief = briefEntity(fixture.store, task);

    if (brief.level !== "task") throw new Error("unreachable");
    expect(brief.blockers.map((b) => b.title)).toEqual(["the blocker"]);
    expect(brief.blocking.map((b) => b.title)).toEqual(["waiting on it"]);
  });

  it("says nothing rather than inventing sections on a bare task", () => {
    const task = seedTask(fixture.store);

    const brief = briefEntity(fixture.store, task);

    expect(brief.handoff).toBeNull();
    expect(brief.noteCounts).toEqual({});
    expect(brief.activity).toEqual([]);
  });

  it("resolves a partial id", () => {
    const task = seedTask(fixture.store, { id: "kt-9f3k2a" });
    expect(briefEntity(fixture.store, "9f3").task.id).toBe(task);
  });

  it("refuses an id that no live task matches", () => {
    // `requireId`, not `requireEntityId`. The latter resolves the id of a
    // deleted task so `log` can still answer for it — accepting one here would
    // resolve successfully and then read back undefined.
    const task = seedTask(fixture.store, { id: "kt-9f3k2a" });
    fixture.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(task);

    try {
      briefEntity(fixture.store, "9f3");
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!isKatraException(error)) throw error;
      expect(error.detail.code).toBe("not_found");
    }
  });

  it("writes no event and opens no transaction", () => {
    const task = seedTask(fixture.store);
    createNote(fixture.store, { taskId: task, body: "h", kind: "handoff" });
    const before = events();

    briefEntity(fixture.store, task);

    expect(events()).toBe(before);
    expect(fixture.store.db.inTransaction).toBe(false);
  });
});

describe("briefEntity on an epic", () => {
  it("returns the epic arm with no children for a childless epic", () => {
    const epic = seedEpic(fixture.store, { title: "empty epic" });

    const brief = briefEntity(fixture.store, epic);

    expect(brief.level).toBe("epic");
    if (brief.level !== "epic") throw new Error("unreachable");
    expect(brief.children).toEqual([]);
  });

  it("groups an epic's children by lane, in lane order", () => {
    // Lane order, not priority order and not database order: the point of the
    // grouping is showing where work sits in the workflow.
    const epic = seedEpic(fixture.store);
    seedTask(fixture.store, { parentId: epic, lane: "Done", title: "finished" });
    seedTask(fixture.store, { parentId: epic, lane: "Defined", title: "fresh" });
    seedTask(fixture.store, { parentId: epic, lane: "In Progress", title: "underway" });

    const brief = briefEntity(fixture.store, epic);

    if (brief.level !== "epic") throw new Error("unreachable");
    expect(brief.children.map((group) => group.lane)).toEqual(["Defined", "In Progress", "Done"]);
    expect(brief.children[0]?.tasks.map((t) => t.title)).toEqual(["fresh"]);
  });

  it("omits lanes that hold no children", () => {
    const epic = seedEpic(fixture.store);
    seedTask(fixture.store, { parentId: epic, lane: "Planned" });

    const brief = briefEntity(fixture.store, epic);

    if (brief.level !== "epic") throw new Error("unreachable");
    expect(brief.children).toHaveLength(1);
  });

  it("surfaces a handoff written on a child, not only on the epic", () => {
    // `notes` has no `epic_id`; the scoping that `listEvents` gets from a
    // stamped column has to be a live join here. Asserted separately from the
    // activity case below because the two paths scope by different mechanisms —
    // passing one says nothing about the other.
    const epic = seedEpic(fixture.store);
    const child = seedTask(fixture.store, { parentId: epic });
    createNote(fixture.store, { taskId: child, body: "the child's handoff", kind: "handoff" });

    expect(briefEntity(fixture.store, epic).handoff?.note.body).toBe("the child's handoff");
  });

  it("includes a child's event in the epic's activity", () => {
    const epic = seedEpic(fixture.store);
    const child = seedTask(fixture.store, { parentId: epic });
    createNote(fixture.store, { taskId: child, body: "note", kind: "general" });

    const brief = briefEntity(fixture.store, epic);

    expect(brief.activity.some((event) => event.entityId === child)).toBe(true);
  });

  it("shows every occupied lane when children are lopsided across lanes", () => {
    // The failure a single global cap produces. `listTasks` orders by priority
    // and lane is not in that sort, so forty Done children would fill a global
    // cap of twenty and the three Planned ones — the only work left — would
    // never render.
    const epic = seedEpic(fixture.store);
    for (let i = 0; i < 40; i++) {
      seedTask(fixture.store, { parentId: epic, lane: "Done", priority: 0, title: `done ${i}` });
    }
    for (let i = 0; i < 3; i++) {
      seedTask(fixture.store, { parentId: epic, lane: "Planned", priority: 4, title: `todo ${i}` });
    }

    const brief = briefEntity(fixture.store, epic);

    if (brief.level !== "epic") throw new Error("unreachable");
    const planned = brief.children.find((group) => group.lane === "Planned");
    expect(planned?.tasks).toHaveLength(3);
    expect(planned?.truncated).toBe(false);
    const done = brief.children.find((group) => group.lane === "Done");
    expect(done?.truncated).toBe(true);
    // Exactly the cap, not just "truncated": the flag alone cannot tell a
    // per-lane cap from a shared budget that left this lane a remainder —
    // Planned renders first in lane order, so a shared budget shows here as a
    // count below the constant.
    expect(done?.tasks).toHaveLength(BRIEF_CHILDREN_PER_LANE);
  });

  it("raises the per-lane children cap under --full", () => {
    const epic = seedEpic(fixture.store);
    for (let i = 0; i < 40; i++) {
      seedTask(fixture.store, { parentId: epic, lane: "Done", title: `done ${i}` });
    }

    const brief = briefEntity(fixture.store, epic, { full: true });

    if (brief.level !== "epic") throw new Error("unreachable");
    expect(brief.children[0]?.truncated).toBe(false);
    expect(brief.children[0]?.tasks).toHaveLength(40);
  });
});

describe("the two shapes are different, not nested", () => {
  it("carries blockers on both shapes, and children only on the epic", () => {
    // The discriminated union, from the inside. One shape with optional fields
    // would leave a --json consumer unable to tell "does not apply" from
    // "nothing filled it in".
    const epic = seedEpic(fixture.store);
    const task = seedTask(fixture.store, { parentId: epic });

    const taskBrief = briefEntity(fixture.store, task) as unknown as Record<string, unknown>;
    const epicBrief = briefEntity(fixture.store, epic) as unknown as Record<string, unknown>;

    // `children` is the only real difference. Blockers are on both: an epic can
    // carry a dependency like anything else, and `brief`'s first question is
    // whether the thing can be picked up.
    expect(Object.hasOwn(taskBrief, "children")).toBe(false);
    expect(Object.hasOwn(epicBrief, "children")).toBe(true);
    expect(Object.hasOwn(taskBrief, "blockers")).toBe(true);
    expect(Object.hasOwn(epicBrief, "blockers")).toBe(true);
  });

  it("truncates an over-cap children list and reports it", () => {
    const epic = seedEpic(fixture.store);
    for (let i = 0; i < BRIEF_CHILDREN_PER_LANE + 3; i++) {
      seedTask(fixture.store, { parentId: epic, lane: "Planned", title: `child ${i}` });
    }

    const brief = briefEntity(fixture.store, epic);

    if (brief.level !== "epic") throw new Error("unreachable");
    expect(brief.children[0]?.tasks).toHaveLength(BRIEF_CHILDREN_PER_LANE);
    expect(brief.children[0]?.truncated).toBe(true);
    // The *true* count, not the shown one. `total: tasks.slice(0, cap).length`
    // would render "showing 8 of 8" and pass every other assertion here.
    expect(brief.children[0]?.total).toBe(BRIEF_CHILDREN_PER_LANE + 3);
  });

  it("reports a lane's true total even when it is not truncated", () => {
    const epic = seedEpic(fixture.store);
    seedTask(fixture.store, { parentId: epic, lane: "Planned" });
    seedTask(fixture.store, { parentId: epic, lane: "Planned" });

    const brief = briefEntity(fixture.store, epic);

    if (brief.level !== "epic") throw new Error("unreachable");
    expect(brief.children[0]?.total).toBe(2);
    expect(brief.children[0]?.truncated).toBe(false);
  });
});

describe("the notes line counts each handoff once", () => {
  it("does not say both '1 handoff' and '1 more handoff'", async () => {
    // The state a concurrent write produces: `briefEntity` reads the handoff
    // before the counts, so a note written between the two leaves `handoff`
    // null while `noteCounts.handoff` is 1. That skew is documented as safe —
    // it should degrade to one extra line, never to a contradiction.
    //
    // Constructed at the formatter, because the race cannot be staged through
    // the CLI: the two reads are microseconds apart.
    const { formatBrief } = await import("../../src/cli/format.js");
    const task = seedTask(fixture.store, { title: "a task" });
    const real = briefEntity(fixture.store, task);

    const skewed = { ...real, handoff: null, noteCounts: { handoff: 1 } };

    const line = formatBrief(skewed)
      .split("\n")
      .find((l) => l.startsWith("notes:"));

    // The defect is the kind being named twice — "1 handoff, 1 more handoff"
    // claims two notes where one exists. Counting occurrences catches it
    // whichever of the two mechanisms produced the duplicate.
    expect(line?.match(/handoff/g) ?? []).toHaveLength(1);
    expect(line).toContain("1 handoff");
  });

  it("says 'more' only when one was already shown above", async () => {
    const { formatBrief } = await import("../../src/cli/format.js");
    const task = seedTask(fixture.store);
    createNote(fixture.store, { taskId: task, body: "older", kind: "handoff" });
    createNote(fixture.store, { taskId: task, body: "newest", kind: "handoff" });

    const brief = briefEntity(fixture.store, task);
    const notesLine = (value: typeof brief) =>
      formatBrief(value)
        .split("\n")
        .find((line) => line.startsWith("notes:"));

    expect(brief.handoff?.note.body).toBe("newest");
    expect(notesLine(brief)).toContain("1 more handoff");

    // Nothing shown above: "more" would name a note the reader never saw.
    const nothingShown = notesLine({ ...brief, handoff: null });
    expect(nothingShown).toContain("2 handoff");
    expect(nothingShown).not.toContain("more");
  });
});

describe("activity and untrusted event fields", () => {
  it("one-lines a child event's entity id in an epic's activity", async () => {
    // The subject column renders only when the event names a different entity
    // than the one briefed — an epic's activity is where that path runs.
    // `events.entity_id` has no CHECK constraint; the seed helper writes what
    // production cannot yet. Built by codepoint so no invisible literal sits
    // in test source.
    const { formatBrief } = await import("../../src/cli/format.js");
    const NL = String.fromCharCode(0x0a);
    const epic = seedEpic(fixture.store, { title: "an epic" });
    seedEvent(fixture.store, { entityId: `kt-evil${NL}flush`, epicId: epic });

    const out = formatBrief(briefEntity(fixture.store, epic));

    // An embedded newline would give stored text its own flush-left line,
    // indistinguishable from a line brief itself printed.
    expect(out).toContain("flush");
    expect(out).not.toMatch(/^flush/m);
  });

  it("one-lines a child event's entity id in show's activity too", async () => {
    // `show` renders the identical subject column. F2 shipped a sanitizer that
    // covered one renderer and not another of the same string — this pins the
    // pair so they cannot diverge again.
    const { formatTaskView } = await import("../../src/cli/format.js");
    const { viewTask } = await import("../../src/core/tasks/view.js");
    const NL = String.fromCharCode(0x0a);
    const epic = seedEpic(fixture.store, { title: "an epic" });
    seedEvent(fixture.store, { entityId: `kt-evil${NL}flush`, epicId: epic });

    const out = formatTaskView(viewTask(fixture.store, epic));

    expect(out).toContain("flush");
    expect(out).not.toMatch(/^flush/m);
  });
});
