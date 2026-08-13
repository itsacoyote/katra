import { describe, expect, it } from "vitest";
import type { BeadsExtract } from "../../src/core/beads/extract.js";
import { planMigration } from "../../src/core/beads/transform.js";
import type { BeadsDependency, BeadsIssue } from "../../src/core/beads/types.js";

const FALLBACK = "1970-01-01T00:00:00.000Z";
const IDENTITY = "migrator@katra";

/**
 * The minimal bd issue: every required {@link BeadsIssue} field, nothing
 * optional. A factory, not a shared constant — several tests spread and
 * override fields, and a shared object would let one test's mutation leak
 * into another's (same reasoning as `beads-extract.test.ts`'s `minimalIssue`).
 */
function makeIssue(overrides: Partial<BeadsIssue> & { readonly id: string }): BeadsIssue {
  return {
    title: `Issue ${overrides.id}`,
    description: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: "",
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "",
    updated_at: "2026-01-01T00:00:00.000Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    ...overrides,
  };
}

function makeExtract(issues: readonly BeadsIssue[]): BeadsExtract {
  return { issues, skippedRecords: { count: 0, byType: [], truncated: false } };
}

function edge(
  issueId: string,
  dependsOnId: string,
  type: string,
  createdAt = "2026-01-01T00:00:00.000Z",
): BeadsDependency {
  return { issue_id: issueId, depends_on_id: dependsOnId, type, created_at: createdAt };
}

describe("planMigration", () => {
  it("builds ancestry from parent-child edges with issue_id as child, not from id shape", () => {
    // Ids deliberately do not look hierarchical — "zzz-standalone" is the
    // epic, "aaa-nested" the child — so a bug that infers ancestry from
    // id-dot-shape rather than the edge would misparent or orphan this.
    const epic = makeIssue({ id: "zzz-standalone", issue_type: "epic", title: "Epic" });
    const task = makeIssue({
      id: "aaa-nested",
      issue_type: "task",
      title: "Task",
      dependencies: [edge("aaa-nested", "zzz-standalone", "parent-child")],
    });

    const { plan } = planMigration(makeExtract([epic, task]), IDENTITY, FALLBACK);

    const taskItem = plan.items.find((item) => item.oldId === "aaa-nested");
    expect(taskItem?.parentOldId).toBe("zzz-standalone");
  });

  it("flattens a three-deep chain onto the nearest epic and reports the reparenting", () => {
    const epic = makeIssue({ id: "E", issue_type: "epic", title: "Epic" });
    const a = makeIssue({
      id: "A",
      title: "A",
      dependencies: [edge("A", "E", "parent-child")],
    });
    const b = makeIssue({
      id: "B",
      title: "B",
      dependencies: [edge("B", "A", "parent-child")],
    });
    const c = makeIssue({
      id: "C",
      title: "C",
      dependencies: [edge("C", "B", "parent-child")],
    });

    const { plan, report } = planMigration(makeExtract([epic, a, b, c]), IDENTITY, FALLBACK);

    expect(plan.items.find((item) => item.oldId === "A")?.parentOldId).toBe("E");
    expect(plan.items.find((item) => item.oldId === "B")?.parentOldId).toBe("E");
    expect(plan.items.find((item) => item.oldId === "C")?.parentOldId).toBe("E");

    // A's direct parent is already the epic — not a reparenting.
    expect(report.reparented.items.some((r) => r.oldId === "A")).toBe(false);
    expect(report.reparented.count).toBe(2);
    expect(report.reparented.items).toEqual(
      expect.arrayContaining([
        { oldId: "B", title: "B", newParentOldId: "E" },
        { oldId: "C", title: "C", newParentOldId: "E" },
      ]),
    );
  });

  it("resolves a long chain onto its epic correctly (memoized ancestry walk)", () => {
    const epic = makeIssue({ id: "Epic", issue_type: "epic", title: "Epic" });
    const depth = 8;
    const chain = Array.from({ length: depth }, (_, i) => {
      const id = `T${String(i + 1)}`;
      const parentId = i === 0 ? "Epic" : `T${String(i)}`;
      return makeIssue({ id, title: id, dependencies: [edge(id, parentId, "parent-child")] });
    });

    // Reverse order: the deepest item (T8) is processed first by the outer
    // loop, forcing a full walk that every shallower item's resolution must
    // then reuse from the shared cache.
    const issues = [epic, ...[...chain].reverse()];

    const { plan, report } = planMigration(makeExtract(issues), IDENTITY, FALLBACK);

    for (let i = 1; i <= depth; i++) {
      expect(plan.items.find((item) => item.oldId === `T${String(i)}`)?.parentOldId).toBe("Epic");
    }

    // T1's direct parent already is the epic — not reparented; every other
    // level skipped at least one task-level ancestor.
    expect(report.reparented.items.some((r) => r.oldId === "T1")).toBe(false);
    expect(report.reparented.count).toBe(depth - 1);
  });

  it("drops and reports epic-to-epic parent edges", () => {
    const parentEpic = makeIssue({ id: "E-parent", issue_type: "epic", title: "Parent epic" });
    const childEpic = makeIssue({
      id: "E-child",
      issue_type: "epic",
      title: "Child epic",
      dependencies: [edge("E-child", "E-parent", "parent-child")],
    });

    const { plan, report } = planMigration(
      makeExtract([parentEpic, childEpic]),
      IDENTITY,
      FALLBACK,
    );

    expect(plan.items.find((item) => item.oldId === "E-child")?.parentOldId).toBeNull();
    expect(report.epicEdgesDropped.items).toEqual([
      { fromOldId: "E-child", toOldId: "E-parent", type: "parent-child" },
    ]);
  });

  it("reports a parent chain with no epic anywhere and leaves the items parentless", () => {
    // Two task-typed issues, A <- B, no epic/milestone anywhere on the
    // chain — reachable in any beads project that never used those types.
    // Previously this dropped silently; now it widens epicEdgesDropped
    // rather than adding a new category.
    const a = makeIssue({ id: "A", title: "A" });
    const b = makeIssue({
      id: "B",
      title: "B",
      dependencies: [edge("B", "A", "parent-child")],
    });

    const { plan, report } = planMigration(makeExtract([a, b]), IDENTITY, FALLBACK);

    expect(plan.items.find((item) => item.oldId === "A")?.parentOldId).toBeNull();
    expect(plan.items.find((item) => item.oldId === "B")?.parentOldId).toBeNull();
    expect(report.epicEdgesDropped.items).toEqual([
      { fromOldId: "B", toOldId: "A", type: "parent-child" },
    ]);
  });

  it("breaks and reports a parent cycle, leaving the item parentless", () => {
    const a = makeIssue({ id: "A", title: "A", dependencies: [edge("A", "B", "parent-child")] });
    const b = makeIssue({ id: "B", title: "B", dependencies: [edge("B", "A", "parent-child")] });

    const { plan, report } = planMigration(makeExtract([a, b]), IDENTITY, FALLBACK);

    expect(plan.items.find((item) => item.oldId === "A")?.parentOldId).toBeNull();
    expect(plan.items.find((item) => item.oldId === "B")?.parentOldId).toBeNull();
    // Each task's ancestry walk is independent, so a 2-node cycle produces
    // one CycleBreak per task in it.
    expect(report.parentCycles.count).toBe(2);
    expect(report.parentCycles.items.map((c) => c.oldId).sort()).toEqual(["A", "B"]);
  });

  it("maps blocks edges as issue_id-depends-on-depends_on_id and related/discovered-from as links", () => {
    const x = makeIssue({
      id: "X",
      dependencies: [
        edge("X", "Y", "blocks"),
        edge("X", "Z", "related"),
        edge("X", "W", "discovered-from"),
      ],
    });
    const y = makeIssue({ id: "Y" });
    const z = makeIssue({ id: "Z" });
    const w = makeIssue({ id: "W" });

    const { plan } = planMigration(makeExtract([x, y, z, w]), IDENTITY, FALLBACK);

    const dependency = plan.edges.find((e) => e.kind === "dependency");
    expect(dependency).toMatchObject({ kind: "dependency", taskOldId: "X", dependsOnOldId: "Y" });

    const links = plan.edges.filter((e) => e.kind === "link");
    expect(links).toHaveLength(2);
    const pairs = links.map((l) => (l.kind === "link" ? new Set([l.aOldId, l.bOldId]) : new Set()));
    expect(pairs.some((pair) => pair.has("X") && pair.has("Z"))).toBe(true);
    expect(pairs.some((pair) => pair.has("X") && pair.has("W"))).toBe(true);
  });

  it("collapses link pairs regardless of type or direction, reporting the losers as duplicates", () => {
    // related(X,Y), discovered-from(X,Y) and related(Y,X) are the same
    // symmetric relationship declared three times — classifyGenericEdges's
    // (issue_id, depends_on_id, type) key treats all three as distinct
    // (different type, or reversed direction), so this collapse has to
    // happen after routeEdgesByType, on the unordered pair alone.
    const x = makeIssue({
      id: "X",
      dependencies: [
        edge("X", "Y", "related"),
        edge("X", "Y", "discovered-from"),
        edge("Y", "X", "related"),
      ],
    });
    const y = makeIssue({ id: "Y" });

    const { plan, report } = planMigration(makeExtract([x, y]), IDENTITY, FALLBACK);

    const links = plan.edges.filter((e) => e.kind === "link");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "link", aOldId: "X", bOldId: "Y" });

    expect(report.duplicateEdges.count).toBe(2);
    expect(report.duplicateEdges.items).toEqual([
      { fromOldId: "X", toOldId: "Y", type: "discovered-from" },
      { fromOldId: "Y", toOldId: "X", type: "related" },
    ]);
  });

  it("reports and skips dangling, duplicate and self edges", () => {
    const a = makeIssue({
      id: "A",
      dependencies: [
        edge("A", "GHOST", "blocks"),
        edge("A", "B", "related"),
        edge("A", "B", "related"),
        edge("A", "A", "blocks"),
      ],
    });
    const b = makeIssue({ id: "B" });

    const { plan, report } = planMigration(makeExtract([a, b]), IDENTITY, FALLBACK);

    expect(report.danglingEdges.items).toEqual([
      { fromOldId: "A", toOldId: "GHOST", type: "blocks" },
    ]);
    expect(report.duplicateEdges.count).toBe(2);
    expect(report.duplicateEdges.items).toEqual(
      expect.arrayContaining([
        { fromOldId: "A", toOldId: "B", type: "related" },
        { fromOldId: "A", toOldId: "A", type: "blocks" },
      ]),
    );

    // The first A-B "related" edge survives as a link; GHOST and the A-A
    // self-edge never become a PlannedEdge at all.
    expect(plan.edges.filter((e) => e.kind === "link")).toHaveLength(1);
    expect(plan.edges.filter((e) => e.kind === "dependency")).toHaveLength(0);
  });

  it("detects and deterministically breaks a blocks cycle, reporting the dropped edge", () => {
    // Sorted by (issue_id, depends_on_id): (a-task,b-task) < (b-task,c-task)
    // < (c-task,a-task) — processed in that order, so a-task->b-task and
    // b-task->c-task are accepted first, and c-task->a-task is the one that
    // would close the loop.
    const a = makeIssue({ id: "a-task", dependencies: [edge("a-task", "b-task", "blocks")] });
    const b = makeIssue({ id: "b-task", dependencies: [edge("b-task", "c-task", "blocks")] });
    const c = makeIssue({ id: "c-task", dependencies: [edge("c-task", "a-task", "blocks")] });

    const { plan, report } = planMigration(makeExtract([a, b, c]), IDENTITY, FALLBACK);

    expect(report.blocksCycles.count).toBe(1);
    expect(report.blocksCycles.items[0]).toMatchObject({
      fromOldId: "c-task",
      toOldId: "a-task",
      type: "blocks",
    });

    const deps = plan.edges.filter((e) => e.kind === "dependency");
    expect(deps).toHaveLength(2);
    expect(deps.some((d) => d.kind === "dependency" && d.taskOldId === "c-task")).toBe(false);
  });

  it("skips and reports items with empty-after-trim titles and notes with blank bodies", () => {
    const blank = makeIssue({ id: "BLANK", title: "   " });
    const withBlankNote = makeIssue({ id: "HAS-NOTE", title: "Real title", notes: "   " });

    const { plan, report } = planMigration(makeExtract([blank, withBlankNote]), IDENTITY, FALLBACK);

    expect(plan.items.some((item) => item.oldId === "BLANK")).toBe(false);
    expect(report.invalidItems.items).toEqual([
      { oldId: "BLANK", rawTitle: "   ", reason: "empty title" },
    ]);

    expect(plan.items.some((item) => item.oldId === "HAS-NOTE")).toBe(true);
    expect(report.invalidNotes.items).toEqual([
      { oldId: "HAS-NOTE", title: "Real title", noteKind: "general" },
    ]);
  });

  it("routes an issue with a non-string owner to invalidItems instead of throwing", () => {
    // extract.ts only guarantees id/title are strings — a hostile record like
    // {"_type":"issue","id":"x","title":"t",...,"owner":123} reaches
    // transform.ts exactly like this. mapIssue calls .trim() on owner, so an
    // unchecked non-string here would throw a TypeError out of planMigration
    // instead of being pre-classified. Cast around makeIssue's BeadsIssue
    // typing since the whole point is a value the type system would forbid.
    const hostile = { ...makeIssue({ id: "HOSTILE" }), owner: 123 } as unknown as BeadsIssue;

    expect(() => planMigration(makeExtract([hostile]), IDENTITY, FALLBACK)).not.toThrow();

    const { plan, report } = planMigration(makeExtract([hostile]), IDENTITY, FALLBACK);
    expect(plan.items.some((item) => item.oldId === "HOSTILE")).toBe(false);
    expect(report.invalidItems.items).toEqual([
      { oldId: "HOSTILE", rawTitle: "Issue HOSTILE", reason: "unusable field type" },
    ]);
  });

  it("routes an issue with a non-string description to invalidItems instead of a bad SQL bind", () => {
    // load.ts binds description straight into an INSERT (tasks/repo.ts's
    // createTaskWithin); better-sqlite3 only accepts numbers, strings,
    // bigints, buffers, and null there. A boolean throws out of the bind
    // call after a clean preview claimed the migration was safe; a
    // single-element array like ["SHIFTED"] is worse — better-sqlite3
    // flattens it into its own positional parameter and writes it as the
    // description silently. A SQL bind is exactly as type-sensitive as the
    // .trim() calls above, so this is a shape-gate failure too.
    const hostile = { ...makeIssue({ id: "BAD-DESC" }), description: 42 } as unknown as BeadsIssue;

    expect(() => planMigration(makeExtract([hostile]), IDENTITY, FALLBACK)).not.toThrow();

    const { plan, report } = planMigration(makeExtract([hostile]), IDENTITY, FALLBACK);
    expect(plan.items.some((item) => item.oldId === "BAD-DESC")).toBe(false);
    expect(report.invalidItems.items).toEqual([
      { oldId: "BAD-DESC", rawTitle: "Issue BAD-DESC", reason: "unusable field type" },
    ]);
  });

  it("clamps and reports out-of-range priorities", () => {
    const issue = makeIssue({ id: "P", priority: 99 });

    const { plan, report } = planMigration(makeExtract([issue]), IDENTITY, FALLBACK);

    expect(plan.items[0]?.priority).toBe(4);
    expect(report.clampedValues.items).toEqual([
      { oldId: "P", title: "Issue P", field: "priority", raw: 99, clamped: 4 },
    ]);
  });

  it("reports a bad issue-level created_at exactly once, not once per note source", () => {
    // mapIssue normalizes issue.created_at once for the PlannedItem itself,
    // then threads that already-normalized value into assembleNotes for the
    // issue-level notes' shared createdAt. A `notes` field is included so
    // assembleNotes actually runs its issue-level-note path; before the fix,
    // assembleNotes silently re-normalized the same raw value, doubling this
    // entry to 2 (katra-9aw.49.10).
    const issue = makeIssue({
      id: "BAD-TIME",
      created_at: "not-a-date",
      notes: "General remark",
    });

    const { report } = planMigration(makeExtract([issue]), IDENTITY, FALLBACK);

    const createdAtEntries = report.invalidTimestamps.items.filter(
      (entry) => entry.oldId === "BAD-TIME" && entry.field === "created_at",
    );
    expect(createdAtEntries).toEqual([
      {
        oldId: "BAD-TIME",
        title: "Issue BAD-TIME",
        field: "created_at",
        raw: "not-a-date",
        fallback: FALLBACK,
      },
    ]);
  });

  it("orders the event plan by time, old id, then type, including note-added events", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    const aItem = makeIssue({
      id: "A-item",
      title: "A",
      created_at: t0,
      updated_at: t0,
      status: "closed",
      closed_at: t0,
    });
    const bItem = makeIssue({ id: "B-item", title: "B", created_at: t0, updated_at: t0 });
    const cItem = makeIssue({
      id: "C-item",
      title: "C",
      created_at: t0,
      updated_at: t0,
      notes: "General note",
    });

    const { plan } = planMigration(makeExtract([aItem, bItem, cItem]), IDENTITY, FALLBACK);

    expect(plan.events).toEqual([
      { type: "created", itemOldId: "A-item", at: t0, title: "A" },
      { type: "closed", itemOldId: "A-item", at: t0, reason: null },
      { type: "created", itemOldId: "B-item", at: t0, title: "B" },
      { type: "created", itemOldId: "C-item", at: t0, title: "C" },
      {
        type: "note-added",
        itemOldId: "C-item",
        at: t0,
        noteRef: expect.any(String) as unknown as string,
        actor: IDENTITY,
      },
    ]);
  });

  it("produces identical output for identical input", () => {
    const issues = [
      makeIssue({ id: "E", issue_type: "epic", title: "Epic" }),
      makeIssue({
        id: "T1",
        title: "T1",
        dependencies: [edge("T1", "E", "parent-child"), edge("T1", "T2", "blocks")],
        comments: [
          {
            id: "c1",
            issue_id: "T1",
            author: "bob",
            text: "hi",
            created_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      }),
      makeIssue({ id: "T2", title: "T2" }),
    ];

    const first = planMigration(makeExtract(issues), IDENTITY, FALLBACK);
    const second = planMigration(makeExtract(issues), IDENTITY, FALLBACK);

    expect(first).toEqual(second);
  });
});
