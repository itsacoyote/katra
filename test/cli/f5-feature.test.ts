/**
 * F5's whole-story proof: `test/fixtures/beads-full.jsonl`, a synthetic bd
 * export planting one record per T2 report category (see the sibling
 * `test/fixtures/beads-full.md` for the record-to-category map), migrated
 * through the real CLI — preview, then `--apply`, then read back through
 * `show`/`list`/`log`, never direct SQL.
 *
 * `test/cli/migrate.test.ts` already covers the CLI's own contract in
 * isolation: exit codes, store-free preview, the two sanitization channels,
 * a single-issue apply. This file does not re-prove any of that — its job is
 * the fixture's *complete* category coverage (every `MigrationReport` section
 * asserted at its exact planted count, never `>0` — a category the pipeline
 * silently stopped populating reads `0` here and fails the test) and
 * post-apply behavior through real commands: a closed task's history, a
 * beads-blocked item's computed readiness, a `beads:<oldId>` tag lookup, and
 * chronological ordering in `log`, both across items and within one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { EventLog, MigrationReport, TaskList } from "../../src/core/contract.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import type { TaskView } from "../../src/core/tasks/types.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";

const FIXTURE_TEXT = readFileSync(
  fileURLToPath(new URL("../fixtures/beads-full.jsonl", import.meta.url)),
  "utf8",
);

function storeDbPath(dir: string): string {
  return join(dir, ".git", STORE_DIR_NAME, DB_FILE_NAME);
}

function writeFixtureExport(dir: string): void {
  mkdirSync(join(dir, ".beads"), { recursive: true });
  writeFileSync(join(dir, ".beads", "issues.jsonl"), FIXTURE_TEXT);
}

/** The migrated id for a beads old id, or a loud failure — never `undefined`. */
function idFor(report: MigrationReport, oldId: string): string {
  const entry = report.idMap.find((e) => e.oldId === oldId);
  if (entry === undefined || entry.newId === null) {
    throw new Error(`no migrated id for beads old id "${oldId}" — check the fixture and idMap`);
  }
  return entry.newId;
}

/** `katra init` then `migrate beads --apply --json`, asserting success. */
async function applyFixture(dir: string): Promise<MigrationReport> {
  const initResult = await runCli(["init"], { cwd: dir });
  expect(initResult.exitCode).toBe(EXIT.ok);

  const result = await runCli(["migrate", "beads", "--apply", "--json"], { cwd: dir });
  expect(result.exitCode).toBe(EXIT.ok);
  return result.json() as MigrationReport;
}

let repo: GitFixture;
beforeEach(() => {
  repo = createGitRepo();
  writeFixtureExport(repo.dir);
});
afterEach(() => repo.cleanup());

describe("F5 full-coverage fixture — preview", () => {
  it("previews the full-coverage fixture reporting every category with its planted count and writes nothing", async () => {
    // Deliberately no `katra init` — preview must work, and must touch
    // nothing, whether or not a store has ever existed here.
    const result = await runCli(["migrate", "beads", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const report = result.json() as MigrationReport;

    expect(report.applied).toBe(false);

    // The six dropped-field categories: all planted on bf-kitchen-sink alone
    // except commentAuthor (bf-comments-edge's authorless comment).
    expect(report.droppedFields.owner.count).toBe(1);
    expect(report.droppedFields.owner.items).toEqual([
      { oldId: "bf-kitchen-sink", title: expect.stringContaining("feat(migration)") },
    ]);
    expect(report.droppedFields.createdBy.count).toBe(1);
    expect(report.droppedFields.estimatedMinutes.count).toBe(1);
    expect(report.droppedFields.externalRef.count).toBe(1);
    expect(report.droppedFields.startedAt.count).toBe(1);
    expect(report.droppedFields.commentAuthor.count).toBe(1);
    expect(report.droppedFields.commentAuthor.items).toEqual([
      { oldId: "bf-comments-edge", title: expect.any(String), commentId: "cec-noauth" },
    ]);

    expect(report.reparented.count).toBe(1);
    expect(report.reparented.items).toEqual([
      {
        oldId: "bf-flatten-leaf",
        title: expect.any(String),
        newParentOldId: "bf-flatten-epic",
      },
    ]);

    expect(report.epicEdgesDropped.count).toBe(1);
    expect(report.epicEdgesDropped.items).toEqual([
      { fromOldId: "bf-mid-epic", toOldId: "bf-top-epic", type: "parent-child" },
    ]);

    // Three comments become notes: bf-kitchen-sink's, bf-comments-edge's
    // authorless-but-non-blank one, and bf-order-q's — its blank sibling
    // (cec-blank) does not count.
    expect(report.commentsConverted.count).toBe(3);
    expect(report.commentsConverted.items.map((c) => c.oldId).sort()).toEqual([
      "bf-comments-edge",
      "bf-kitchen-sink",
      "bf-order-q",
    ]);

    expect(report.unmappedStatuses.count).toBe(1);
    expect(report.unmappedStatuses.items).toEqual([
      { oldId: "bf-status-ctor", title: expect.any(String), raw: "constructor" },
    ]);

    expect(report.unmappedTypes.count).toBe(1);
    expect(report.unmappedTypes.items).toEqual([
      { oldId: "bf-unmapped-type", title: expect.any(String), raw: "gizmo" },
    ]);

    expect(report.skippedRecords).toEqual({
      count: 1,
      byType: [{ type: "wisp", count: 1 }],
      truncated: false,
    });

    expect(report.danglingEdges.count).toBe(1);
    expect(report.danglingEdges.items).toEqual([
      { fromOldId: "bf-dangling-source", toOldId: "bf-ghost-nonexistent", type: "blocks" },
    ]);

    // A self-edge (bf-self-edge) plus one genuine duplicate (bf-dup-edge-a's
    // repeated "related" edge to bf-dup-edge-b).
    expect(report.duplicateEdges.count).toBe(2);
    expect(report.duplicateEdges.items).toEqual(
      expect.arrayContaining([
        { fromOldId: "bf-self-edge", toOldId: "bf-self-edge", type: "blocks" },
        { fromOldId: "bf-dup-edge-a", toOldId: "bf-dup-edge-b", type: "related" },
      ]),
    );

    // bf-cycle-a <-> bf-cycle-b: each side's own ancestry walk discovers the
    // cycle independently, so it reports twice.
    expect(report.parentCycles.count).toBe(2);
    expect(report.parentCycles.items.map((c) => c.oldId).sort()).toEqual([
      "bf-cycle-a",
      "bf-cycle-b",
    ]);

    expect(report.blocksCycles.count).toBe(1);
    expect(report.blocksCycles.items).toEqual([
      {
        fromOldId: "bf-bc-c",
        toOldId: "bf-bc-a",
        type: "blocks",
        path: ["bf-bc-c", "bf-bc-a", "bf-bc-b", "bf-bc-c"],
      },
    ]);

    // Two entries from one planted bad value: mapIssue normalizes created_at
    // directly, and assembleNotes independently re-normalizes the same raw
    // created_at for note timestamps — both against the identical invalid
    // string, so bf-bad-timestamp's single degradation surfaces as two
    // report rows (see beads-full.md).
    expect(report.invalidTimestamps.count).toBe(2);
    expect(
      report.invalidTimestamps.items.every(
        (t) =>
          t.oldId === "bf-bad-timestamp" && t.field === "created_at" && t.raw === "not-a-real-date",
      ),
    ).toBe(true);

    // Empty title, the duplicate id's second occurrence, and the
    // non-string-status shape violation.
    expect(report.invalidItems.count).toBe(3);
    expect(report.invalidItems.items.map((i) => i.oldId).sort()).toEqual([
      "bf-dup-id",
      "bf-empty-title",
      "bf-status-nonstring",
    ]);

    expect(report.invalidNotes.count).toBe(1);
    expect(report.invalidNotes.items).toEqual([
      {
        oldId: "bf-comments-edge",
        title: expect.any(String),
        noteKind: "general",
        commentId: "cec-blank",
      },
    ]);

    expect(report.clampedValues.count).toBe(1);
    expect(report.clampedValues.items).toEqual([
      {
        oldId: "bf-bad-priority",
        title: expect.any(String),
        field: "priority",
        raw: 99,
        clamped: 4,
      },
    ]);

    expect(report.emptyLabels.count).toBe(1);
    expect(report.emptyLabels.items).toEqual([
      { oldId: "bf-blank-label", title: expect.any(String) },
    ]);

    // Every planted issue but the three invalidItems becomes a planned item:
    // 40 issue records - 3 invalid = 37, none of them the wisp record.
    expect(report.idMap).toHaveLength(37);
    expect(report.imported.byLevel).toEqual({ epic: 3, task: 34 });
    // The duplicate id's dropped second occurrence, and the shape-invalid and
    // empty-title records, never appear in the id map at all.
    expect(report.idMap.map((e) => e.oldId)).not.toContain("bf-status-nonstring");
    expect(report.idMap.map((e) => e.oldId)).not.toContain("bf-empty-title");
    expect(report.idMap.every((e) => e.newId === null)).toBe(true);

    // The prototype-shaped id survives the whole pipeline as ordinary data.
    expect(report.idMap.some((e) => e.oldId === "__proto__")).toBe(true);

    // Store-untouched: no store file, no store directory at all.
    expect(existsSync(storeDbPath(repo.dir))).toBe(false);
    expect(existsSync(join(repo.dir, ".git", STORE_DIR_NAME))).toBe(false);
  });

  it("renders hostile titles harmlessly in the report and in show after apply", async () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const rlo = String.fromCharCode(0x202e);

    // bf-hostile-title carries no degradation of its own (that is the point
    // — a hostile title alone must not need a second, unrelated category to
    // prove sanitisation), so the human preview report never names it: only
    // degraded items get a line (see formatMigrationReport). This is still a
    // useful coarse check — nothing anywhere in the whole report leaks a raw
    // control/bidi byte — but the real, targeted proof is `show` after
    // apply, below, where the title is guaranteed to render.
    const preview = await runCli(["migrate", "beads"], { cwd: repo.dir });
    expect(preview.exitCode).toBe(EXIT.ok);
    expect(preview.stdout.includes(esc)).toBe(false);
    expect(preview.stdout.includes(bel)).toBe(false);
    expect(preview.stdout.includes(rlo)).toBe(false);

    const applied = await applyFixture(repo.dir);
    const hostileId = idFor(applied, "bf-hostile-title");

    const shown = await runCli(["show", hostileId], { cwd: repo.dir });
    expect(shown.exitCode).toBe(EXIT.ok);
    expect(shown.stdout.includes(esc)).toBe(false);
    expect(shown.stdout.includes(bel)).toBe(false);
    expect(shown.stdout.includes(rlo)).toBe(false);
    expect(shown.stdout).toContain("Evil");
    expect(shown.stdout).toContain("reversed");
  });
});

describe("F5 full-coverage fixture — apply and post-apply behavior", () => {
  it("applies the fixture and shows a migrated closed task as Done with its historical closed event", async () => {
    const report = await applyFixture(repo.dir);
    const closedId = idFor(report, "bf-closed-prereq");

    const shown = await runCli(["show", closedId, "--json"], { cwd: repo.dir });
    expect(shown.exitCode).toBe(EXIT.ok);
    const view = shown.json() as TaskView;

    expect(view.task.lane).toBe("Done");
    expect(view.task.closedAt).not.toBeNull();
    expect(view.task.closeReason).toContain("shipped in v1");

    const closedEvent = view.activity.find((e) => e.type === "closed");
    expect(closedEvent).toBeDefined();
    expect(closedEvent?.reason).toContain("shipped in v1");
    // The historical closed_at the fixture planted (2024-03-08), not the
    // migration's own run time.
    expect(new Date(closedEvent?.createdAt ?? "").getUTCFullYear()).toBe(2024);
    expect(new Date(closedEvent?.createdAt ?? "").getUTCMonth()).toBe(2); // March, 0-indexed
    expect(new Date(closedEvent?.createdAt ?? "").getUTCDate()).toBe(8);

    const createdEvent = view.activity.find((e) => e.type === "created");
    expect(createdEvent).toBeDefined();
  });

  it("reads migrated history in chronological order via log", async () => {
    const report = await applyFixture(repo.dir);
    const closedId = idFor(report, "bf-closed-prereq");

    // Scoped log, newest first: exactly two events, closed then created.
    const log = await runCli(["log", closedId, "--json"], { cwd: repo.dir });
    expect(log.exitCode).toBe(EXIT.ok);
    const events = (log.json() as EventLog).events;

    expect(events.map((e) => e.type)).toEqual(["closed", "created"]);
    expect(Date.parse(events[0]?.createdAt ?? "")).toBeGreaterThan(
      Date.parse(events[1]?.createdAt ?? ""),
    );
  });

  it("interleaves created, note-added and closed events chronologically across items in log", async () => {
    const report = await applyFixture(repo.dir);
    const qId = idFor(report, "bf-order-q");
    const rId = idFor(report, "bf-order-r");
    const pId = idFor(report, "bf-order-p");

    // Large enough to hold every event this fixture writes (well under 50 in
    // practice, but pinned generously so this test never silently truncates).
    const log = await runCli(["log", "--json", "--limit", "500"], { cwd: repo.dir });
    expect(log.exitCode).toBe(EXIT.ok);
    const parsed = log.json() as EventLog;
    expect(parsed.truncated).toBe(false);

    // log is newest-first; reverse to read true chronological order, then
    // keep only the three deliberately-interleaved items. Expected order,
    // from the fixture's own planted timestamps (beads-full.md "R" group):
    // q created 2024-01-01 < r created 2024-01-05 < p created 2024-01-10 <
    // q's own comment note-added 2024-01-15 — q's *own* history is not
    // contiguous, proving the ordering is across items, not per-item.
    const chronological = [...parsed.events].reverse();
    const relevant = chronological
      .filter((e) => e.entityId === qId || e.entityId === rId || e.entityId === pId)
      .map((e) => ({ entityId: e.entityId, type: e.type }));

    expect(relevant).toEqual([
      { entityId: qId, type: "created" },
      { entityId: rId, type: "created" },
      { entityId: pId, type: "created" },
      { entityId: qId, type: "note-added" },
    ]);
  });

  it("previews cleanly then applies successfully — a clean preview predicts the apply", async () => {
    const preview = await runCli(["migrate", "beads", "--json"], { cwd: repo.dir });
    expect(preview.exitCode).toBe(EXIT.ok);
    const previewReport = preview.json() as MigrationReport;

    const appliedReport = await applyFixture(repo.dir);

    // Strip the fields a second, later invocation is allowed to differ on:
    // `applied`, each idMap row's `newId` (unminted in preview), and
    // invalidTimestamps' `fallback` — bf-bad-timestamp's substituted value is
    // `nowIso()` captured fresh per CLI invocation (migrate.ts's own
    // `fallbackTimestamp`), so preview and apply legitimately stamp two
    // different instants a few milliseconds apart. Everything else — every
    // degradation category's count *and* items, the imported tallies — must
    // match exactly between preview and apply.
    const strip = (report: MigrationReport): unknown => ({
      ...report,
      applied: undefined,
      idMap: report.idMap.map((e) => e.oldId).sort(),
      invalidTimestamps: {
        ...report.invalidTimestamps,
        items: report.invalidTimestamps.items.map((t) => ({ ...t, fallback: undefined })),
      },
    });

    expect(strip(appliedReport)).toEqual(strip(previewReport));
    expect(previewReport.applied).toBe(false);
    expect(appliedReport.applied).toBe(true);
  });

  it("computes blocked-ness of a migrated blocked item from its edges, not a lane", async () => {
    const report = await applyFixture(repo.dir);
    const blockedId = idFor(report, "bf-blocked-status");
    const prereqId = idFor(report, "bf-in-progress");
    const openDependentId = idFor(report, "bf-open-dependent");
    const closedPrereqId = idFor(report, "bf-closed-prereq");

    // Every migrated beads status (open/in_progress/blocked/deferred/pinned)
    // lands in the same lane, Defined — so partitioning these two correctly
    // proves the computation reads dependency edges, not the lane column.
    const readyList = await runCli(["list", "--ready", "--json"], { cwd: repo.dir });
    const blockedList = await runCli(["list", "--blocked", "--json"], { cwd: repo.dir });
    const readyIds = (readyList.json() as TaskList).tasks.map((t) => t.id);
    const blockedIds = (blockedList.json() as TaskList).tasks.map((t) => t.id);

    expect(blockedIds).toContain(blockedId);
    expect(readyIds).not.toContain(blockedId);

    // Direction asymmetry (mirrors reality — a real completed dependency):
    // bf-open-dependent depends on the already-closed bf-closed-prereq, so
    // it is ready despite carrying a real dependency edge. A flipped edge
    // direction would make this fail loudly, either by making
    // bf-open-dependent block on nothing real or by making the closed task
    // itself appear to depend on something unfinished.
    expect(readyIds).toContain(openDependentId);
    expect(blockedIds).not.toContain(openDependentId);

    const shownBlocked = await runCli(["show", blockedId, "--json"], { cwd: repo.dir });
    const blockedView = (shownBlocked.json() as TaskView).blockers;
    expect(blockedView.map((b) => b.id)).toEqual([prereqId]);

    const shownDependent = await runCli(["show", openDependentId, "--json"], { cwd: repo.dir });
    const dependentView = shownDependent.json() as TaskView;
    expect(dependentView.blockers).toEqual([]);
    void closedPrereqId;
  });

  it("finds migrated items by their beads:<oldId> tag", async () => {
    const report = await applyFixture(repo.dir);
    // The prototype-shaped id doubles here: it also proves the tag built
    // from it ("beads:__proto__") round-trips as ordinary tag text.
    const protoId = idFor(report, "__proto__");

    const found = await runCli(["list", "--tag", "beads:__proto__", "--json"], { cwd: repo.dir });
    expect(found.exitCode).toBe(EXIT.ok);
    const tasks = (found.json() as TaskList).tasks;
    expect(tasks.map((t) => t.id)).toEqual([protoId]);
  });

  it("refuses a second apply with exit 3", async () => {
    await applyFixture(repo.dir);

    const second = await runCli(["migrate", "beads", "--apply"], { cwd: repo.dir });
    expect(second.exitCode).toBe(EXIT.conflict);
  });

  it("resolves every id map entry to a real minted id after --json apply", async () => {
    const report = await applyFixture(repo.dir);

    expect(report.applied).toBe(true);
    expect(report.idMap.length).toBeGreaterThan(0);
    for (const entry of report.idMap) {
      expect(entry.newId).toMatch(/^kt-/);
    }
    // Round-trips through a real command, not just shape-checked in memory.
    const anyId = idFor(report, "bf-kitchen-sink");
    const shown = await runCli(["show", anyId], { cwd: repo.dir });
    expect(shown.exitCode).toBe(EXIT.ok);
  });
});
