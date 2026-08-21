/**
 * The pure reconcile policy engine (F9 T2): `planReconcile`'s pinned
 * precedence, `DEFAULT_POLICY`'s mapping, and the structural "no store
 * import" discipline `core/providers/types.ts` set the precedent for. Plus
 * `gatherCandidates` (F9 T3, `reconcile/repo.ts`) — the store-touching
 * counterpart that turns real tasks/refs/claims into the engine's own input.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { planReconcile } from "../../src/core/reconcile/engine.js";
import { DEFAULT_POLICY } from "../../src/core/reconcile/policy.js";
import { gatherCandidates } from "../../src/core/reconcile/repo.js";
import type { Candidate, PolicyTable } from "../../src/core/reconcile/types.js";
import { linkRef } from "../../src/core/refs/repo.js";
import { setCachedStatus } from "../helpers/fixture.js";
import { buildRef } from "../helpers/refs.js";
import { seedClaim, seedEpic, seedTask } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let candidateCounter = 0;

function candidate(overrides: Partial<Candidate> & Pick<Candidate, "refs">): Candidate {
  candidateCounter += 1;
  return {
    id: `kt-${String(candidateCounter).padStart(6, "0")}`,
    title: "a task",
    lane: "In Review",
    level: "task",
    claimHolder: null,
    ...overrides,
  };
}

describe("planReconcile: precedence", () => {
  it("a task whose every ref maps to Done yields advance citing every ref", () => {
    const refA = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "merged" });
    const refB = buildRef({ provider: "github", externalId: "acme/app#2", cachedStatus: "merged" });
    const c = candidate({ refs: [refA, refB] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({
      kind: "advance",
      target: "Done",
      triggeringRefs: [refA, refB],
    });
  });

  it("one merged and one open PR yields blocked-by-ref naming the open ref", () => {
    const merged = buildRef({
      provider: "github",
      externalId: "acme/app#1",
      cachedStatus: "merged",
    });
    const open = buildRef({ provider: "github", externalId: "acme/app#2", cachedStatus: "open" });
    const c = candidate({ refs: [merged, open] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({ kind: "blocked-by-ref", blockingRefs: [open] });
  });

  it("a merged PR plus a never-refreshed ref yields blocked-by-ref", () => {
    const merged = buildRef({
      provider: "github",
      externalId: "acme/app#1",
      cachedStatus: "merged",
    });
    const neverRefreshed = buildRef({
      provider: "github",
      externalId: "acme/app#2",
      cachedStatus: null,
    });
    const c = candidate({ refs: [merged, neverRefreshed] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({ kind: "blocked-by-ref", blockingRefs: [neverRefreshed] });
  });

  it("a task whose refs are all unmapped yields no-op, not blocked-by-ref", () => {
    const open = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "open" });
    const c = candidate({ refs: [open] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({ kind: "no-op" });
  });

  it("refs mapping to Done and Cancelled yield conflict naming both targets", () => {
    const done = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "merged" });
    const cancelled = buildRef({
      provider: "linear",
      externalId: "ENG-1",
      cachedStatus: "canceled",
    });
    const c = candidate({ refs: [done, cancelled] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({
      kind: "conflict",
      targets: [
        { target: "Done", refs: [done] },
        { target: "Cancelled", refs: [cancelled] },
      ],
    });
  });

  it("conflict wins over blocked-by-ref when both apply", () => {
    // Three refs on one task: one -> Done, one -> Cancelled (the conflict),
    // and one unmapped (open, which alone would make the task blocked-by-ref).
    // Precedence pins conflict first regardless.
    const done = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "merged" });
    const cancelled = buildRef({
      provider: "linear",
      externalId: "ENG-1",
      cachedStatus: "canceled",
    });
    const blocking = buildRef({
      provider: "github",
      externalId: "acme/app#2",
      cachedStatus: "open",
    });
    const c = candidate({ refs: [done, cancelled, blocking] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict.kind).toBe("conflict");
  });
});

describe("planReconcile: claim safety", () => {
  it("a would-advance task claimed by another worktree yields skip-claimed", () => {
    const merged = buildRef({
      provider: "github",
      externalId: "acme/app#1",
      cachedStatus: "merged",
    });
    const c = candidate({ refs: [merged], claimHolder: "feature/other @ /repo/wt-other" });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({
      kind: "skip-claimed",
      holder: "feature/other @ /repo/wt-other",
    });
  });

  it("a blocked task claimed by another worktree stays blocked-by-ref", () => {
    const merged = buildRef({
      provider: "github",
      externalId: "acme/app#1",
      cachedStatus: "merged",
    });
    const open = buildRef({ provider: "github", externalId: "acme/app#2", cachedStatus: "open" });
    const c = candidate({ refs: [merged, open], claimHolder: "feature/other @ /repo/wt-other" });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({ kind: "blocked-by-ref", blockingRefs: [open] });
  });
});

describe("planReconcile: policy", () => {
  it("a single canceled linear ref yields advance to Cancelled", () => {
    const cancelled = buildRef({
      provider: "linear",
      externalId: "ENG-1",
      cachedStatus: "canceled",
    });
    const c = candidate({ refs: [cancelled] });

    const [result] = planReconcile([c], DEFAULT_POLICY);

    expect(result?.verdict).toEqual({
      kind: "advance",
      target: "Cancelled",
      triggeringRefs: [cancelled],
    });
  });

  it("an injected non-default policy changes the verdicts", () => {
    // Proves ADR-016's own point: the policy is data the engine consults,
    // never a hardcoded branch — an "open" -> Cancelled table the default
    // policy does not have produces a different verdict for the identical
    // candidate.
    const open = buildRef({ provider: "github", externalId: "acme/app#1", cachedStatus: "open" });
    const c = candidate({ refs: [open] });
    const customPolicy: PolicyTable = { github: { open: "Cancelled" } };

    const defaultResult = planReconcile([c], DEFAULT_POLICY);
    const customResult = planReconcile([c], customPolicy);

    expect(defaultResult[0]?.verdict).toEqual({ kind: "no-op" });
    expect(customResult[0]?.verdict).toEqual({
      kind: "advance",
      target: "Cancelled",
      triggeringRefs: [open],
    });
  });
});

describe("gatherCandidates", () => {
  let fixture: StoreFixture;
  beforeEach(() => {
    fixture = createStoreFixture();
  });
  afterEach(() => fixture.cleanup());

  /** The store fixture's own SQLite file — `setCachedStatus`'s `dbPath`. */
  function dbPath(): string {
    return join(fixture.repo.dir, ".git", STORE_DIR_NAME, DB_FILE_NAME);
  }

  it("gatherCandidates excludes terminal tasks and tasks with zero refs", () => {
    const open = seedTask(fixture.store, { title: "open, with a ref" });
    linkRef(fixture.store, open, { provider: "github", externalId: "acme/app#1", url: null });

    const done = seedTask(fixture.store, { title: "done, with a ref", lane: "Done" });
    linkRef(fixture.store, done, { provider: "github", externalId: "acme/app#2", url: null });

    seedTask(fixture.store, { title: "open, no refs" });

    const candidates = gatherCandidates(fixture.store);

    expect(candidates.map((c) => c.id)).toEqual([open]);
  });

  it("gatherCandidates excludes an epic holding its own ref", () => {
    const epic = seedEpic(fixture.store, { title: "an epic" });
    linkRef(fixture.store, epic, { provider: "github", externalId: "acme/app#1", url: null });

    const task = seedTask(fixture.store, { title: "a child task", parentId: epic });
    linkRef(fixture.store, task, { provider: "github", externalId: "acme/app#2", url: null });

    const candidates = gatherCandidates(fixture.store);

    expect(candidates.map((c) => c.id)).toEqual([task]);
  });

  it("gatherCandidates scoped to ids returns only those candidates", () => {
    const taskA = seedTask(fixture.store, { title: "task a" });
    linkRef(fixture.store, taskA, { provider: "github", externalId: "acme/app#1", url: null });

    const taskB = seedTask(fixture.store, { title: "task b" });
    linkRef(fixture.store, taskB, { provider: "github", externalId: "acme/app#2", url: null });

    const candidates = gatherCandidates(fixture.store, [taskA]);

    expect(candidates.map((c) => c.id)).toEqual([taskA]);
  });

  it("candidates carry the claim holder and every ref's cached status, cached title, and synced age", () => {
    const task = seedTask(fixture.store, { title: "a task" });
    linkRef(fixture.store, task, {
      provider: "github",
      externalId: "acme/app#1",
      url: "https://github.com/acme/app/pull/1",
    });
    seedClaim(fixture.store, { taskId: task, holder: "/repo/other-worktree" });
    setCachedStatus(dbPath(), "github", "acme/app#1", "merged", "2026-01-01T00:00:00.000Z");
    fixture.store.db
      .prepare("UPDATE refs SET cached_title = ? WHERE provider = ? AND external_id = ?")
      .run("Fix the bug", "github", "acme/app#1");

    const [result] = gatherCandidates(fixture.store);

    expect(result?.claimHolder).toBe("/repo/other-worktree");
    expect(result?.refs).toEqual([
      {
        provider: "github",
        externalId: "acme/app#1",
        url: "https://github.com/acme/app/pull/1",
        cachedStatus: "merged",
        cachedTitle: "Fix the bug",
        syncedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("a claim held by the invoking worktree renders as no claim, not someone else's", () => {
    // Not one of the bead's named tests, but load-bearing: T2's engine
    // contract (types.ts's own Candidate.claimHolder docs) says a non-null
    // value here always means someone else's claim — epic requirement 6
    // ("a claim held by the invoking worktree does not block") only holds
    // end to end if this repo resolves "is this mine" before a Candidate is
    // ever built, which is exactly what this pins.
    const task = seedTask(fixture.store, { title: "a task" });
    linkRef(fixture.store, task, { provider: "github", externalId: "acme/app#1", url: null });
    seedClaim(fixture.store, { taskId: task, holder: fixture.store.identity().worktree });

    const [result] = gatherCandidates(fixture.store);

    expect(result?.claimHolder).toBeNull();
  });
});

describe("structural: no store import", () => {
  /**
   * Strips block comments entirely, and strips a `//` line comment only
   * when `//` is the first non-whitespace content on its line — the same
   * technique `test/core/providers.test.ts`'s own structural env-injection
   * scan uses, reused here rather than re-derived: a naive strip-to-end-of-line
   * would treat the rest of any line holding a `https://...` literal (or any
   * other mid-line `//`) as a comment and hide real code from the scan below.
   */
  function stripComments(source: string): string {
    const withoutBlockComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
    return withoutBlockComments
      .split("\n")
      .map((line) => (/^\s*\/\//.test(line) ? "" : line))
      .join("\n");
  }

  /**
   * The pure files — `types.ts`, `policy.ts`, `engine.ts` — never globbed,
   * hand-triaged instead: a hardcoded list, not a glob minus one name, so a
   * *fifth* file added later has to be triaged into one bucket or the other
   * by whoever adds it, rather than silently inheriting "pure" by virtue of
   * not being named `repo.ts`.
   */
  const PURE_FILES = ["types.ts", "policy.ts", "engine.ts"];

  /**
   * `repo.ts` (F9 T3) — the deliberate store-touching exception:
   * `gatherCandidates` legitimately imports `OpenStore` and the refs/tasks
   * repos to read real rows, the identical split `refs/parse.ts` (pure) vs
   * `refs/repo.ts` (store-touching) already draws for F7's ref grammar.
   */
  const STORE_TOUCHING_FILES = ["repo.ts"];

  function reconcileRoot(): string {
    return fileURLToPath(new URL("../../src/core/reconcile", import.meta.url));
  }

  it("triages every file under reconcile/ into pure or store-touching, none left out", () => {
    // The cross-check the two hardcoded lists above need: a hardcoded list is
    // only as good as its own completeness, and nothing enforced that PURE_FILES
    // plus STORE_TOUCHING_FILES actually covers every real file on disk. A
    // sixth file added under reconcile/ without being added to either list
    // fails here, loudly, rather than silently missing the scan below.
    const onDisk = readdirSync(reconcileRoot(), { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
      )
      .map((entry) => entry.name);

    expect([...PURE_FILES, ...STORE_TOUCHING_FILES].sort()).toEqual([...onDisk].sort());
  });

  it("the engine imports no store module (structural)", () => {
    const root = reconcileRoot();

    // The npm package name directly, the `OpenStore` type doing the same job
    // `process` does in the providers.test.ts precedent, and the relative
    // import specifier every store-touching module in this codebase uses
    // (`refs/repo.ts`'s own `from "../store.js"`).
    const storeImport = /\bbetter-sqlite3\b|\bOpenStore\b|\bstore\.js\b/;
    for (const file of PURE_FILES) {
      const source = stripComments(readFileSync(join(root, file), "utf8"));
      expect(source, `${file} must not import a store module`).not.toMatch(storeImport);
    }
  });
});
