/**
 * F9's epic-level acceptance criteria (T5) — the five ACs no single T4 unit
 * test owns on its own, proven end to end through the real CLI, one store per
 * test. `test/cli/reconcile.test.ts` (T4) already pins each individual
 * behavior in isolation; this file's job is the epic's own AC wording,
 * following the fN-feature register (`f6-feature.test.ts`'s own module doc:
 * "several commands, several writes, one store, read back only through
 * runCli").
 *
 * AC1's no-state-change proof is targeted direct DB reads — tasks'
 * lane/closed_at/close_reason/updated_at, events count, claims, refs — never
 * a byte-compare or a writeTx spy: the presence heartbeat `openStore` bumps
 * on every command is the standing, documented exception (epic Goals), and
 * neither of those two techniques could tell it apart from a real write.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { ReconcileResult } from "../../src/core/contract.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { openStore } from "../../src/core/store.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo, setCachedStatus } from "../helpers/fixture.js";
import { seedClaim } from "../helpers/seed.js";

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => repo.cleanup());

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

function dbPath(): string {
  return `${repo.dir}/.git/${STORE_DIR_NAME}/${DB_FILE_NAME}`;
}

/** Reads one task row directly, bypassing every application read path. */
function readTaskRow(
  taskId: string,
): { lane: unknown; closed_at: unknown; close_reason: unknown; updated_at: unknown } | undefined {
  const { store } = openStore(repo.dir, {});
  try {
    return store.db
      .prepare("SELECT lane, closed_at, close_reason, updated_at FROM tasks WHERE id = ?")
      .get(taskId) as
      | { lane: unknown; closed_at: unknown; close_reason: unknown; updated_at: unknown }
      | undefined;
  } finally {
    store.close();
  }
}

function countRows(table: "events" | "claims" | "refs"): number {
  const { store } = openStore(repo.dir, {});
  try {
    return (store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  } finally {
    store.close();
  }
}

describe("F9 epic acceptance criteria", () => {
  it("AC1: bare reconcile previews moves with triggering refs and synced age and changes no task, event, claim, or ref state", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");

    const beforeTask = readTaskRow(task);
    const beforeEvents = countRows("events");
    const beforeClaims = countRows("claims");
    const beforeRefs = countRows("refs");

    const result = await runCli(["reconcile"], { cwd: repo.dir });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    expect(result.stdout).toContain(task);
    expect(result.stdout).toContain("-> Done");
    // The triggering ref's own line, with its cached status and a synced age
    // — not just the fact that something would advance.
    expect(result.stdout).toContain("github: acme/widgets#7");
    expect(result.stdout).toContain("merged");
    expect(result.stdout).toContain("synced");

    expect(readTaskRow(task)).toEqual(beforeTask);
    expect(countRows("events")).toBe(beforeEvents);
    expect(countRows("claims")).toBe(beforeClaims);
    expect(countRows("refs")).toBe(beforeRefs);
  });

  it("AC2: --apply advances with exactly one lane-change event and reruns quietly", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");

    const applied = await runCli(["reconcile", task, "--apply", "--json"], { cwd: repo.dir });
    expect(applied.exitCode, applied.stderr).toBe(EXIT.ok);
    expect((applied.json() as ReconcileResult).totals.advance).toBe(1);

    const log = await runCli(["log", task, "--json"], { cwd: repo.dir });
    const events = (log.json() as { events: ReadonlyArray<{ type: string }> }).events;
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1);
    const eventCountAfterFirst = events.length;

    // Immediately re-running is quiet: the task is terminal now, so it is not
    // a candidate any more — but it was named explicitly, so it is still
    // accounted for, reported under no-op rather than silently vanishing
    // (validate round-1 LOW-1).
    const second = await runCli(["reconcile", task, "--apply", "--json"], { cwd: repo.dir });
    expect(second.exitCode, second.stderr).toBe(EXIT.ok);
    const secondDoc = second.json() as ReconcileResult;
    expect(secondDoc.totals.tasks).toBe(1);
    expect(secondDoc.noOp.items).toEqual([expect.objectContaining({ taskId: task })]);
    expect(secondDoc.advance.count).toBe(0);

    const logAfter = await runCli(["log", task, "--json"], { cwd: repo.dir });
    expect((logAfter.json() as { events: unknown[] }).events).toHaveLength(eventCountAfterFirst);
  });

  it("AC3: the ALL rule holds back a partial merge and flags a Done-vs-Cancelled conflict", async () => {
    // Partial merge: one merged, one still open -> blocked-by-ref, naming the
    // ref that is not merged yet.
    const partial = await add(["partial merge"]);
    await runCli(["ref", "add", partial, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    await runCli(["ref", "add", partial, "https://github.com/acme/widgets/pull/8"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");
    setCachedStatus(dbPath(), "github", "acme/widgets#8", "open");

    // Conflict: one ref maps to Done, another to Cancelled — never auto-applied.
    const conflicted = await add(["conflicted"]);
    await runCli(["ref", "add", conflicted, "https://github.com/acme/widgets/pull/9"], {
      cwd: repo.dir,
    });
    await runCli(["ref", "add", conflicted, "ENG-451"], { cwd: repo.dir });
    setCachedStatus(dbPath(), "github", "acme/widgets#9", "merged");
    setCachedStatus(dbPath(), "linear", "ENG-451", "canceled");

    const result = await runCli(["reconcile", partial, conflicted, "--apply", "--json"], {
      cwd: repo.dir,
    });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as ReconcileResult;
    expect(doc.blockedByRef.items).toEqual([expect.objectContaining({ taskId: partial })]);
    expect(doc.conflict.items).toEqual([expect.objectContaining({ taskId: conflicted })]);
    // Neither the blocked task nor the conflicted one advanced, even under
    // --apply: the ALL rule and the conflict guard both hold under a real
    // commit, not just in preview.
    expect(doc.advance.count).toBe(0);
    expect(readTaskRow(partial)?.lane).not.toBe("Done");
    expect(readTaskRow(conflicted)?.lane).not.toBe("Done");
  });

  it("AC4: a foreign claim skips, a never-refreshed ref prevents advancement, a canceled ref cancels", async () => {
    // Foreign claim: would-advance task claimed by another worktree is
    // skipped and reported, even under --apply.
    const claimedElsewhere = await add(["claimed elsewhere"]);
    await runCli(["ref", "add", claimedElsewhere, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");
    const { store } = openStore(repo.dir, {});
    try {
      seedClaim(store, { taskId: claimedElsewhere, holder: "/elsewhere/worktree" });
    } finally {
      store.close();
    }

    // Never-refreshed ref: a second, mapped ref alone would advance the
    // task, but the unresolved one (cachedStatus stays null — no
    // setCachedStatus call) prevents it rather than being silently ignored.
    // A single unresolved ref with nothing else linked would read as no-op,
    // not blocked-by-ref — the engine's own precedence needs a mapped ref to
    // contrast against (`reconcile/engine.ts`'s module doc, rule 2).
    const neverRefreshed = await add(["never refreshed"]);
    await runCli(["ref", "add", neverRefreshed, "https://github.com/acme/widgets/pull/9"], {
      cwd: repo.dir,
    });
    await runCli(["ref", "add", neverRefreshed, "https://github.com/acme/widgets/pull/10"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#10", "merged");

    // Canceled linear ref: advances to Cancelled, not just Done.
    const toCancel = await add(["cancel me"]);
    await runCli(["ref", "add", toCancel, "ENG-900"], { cwd: repo.dir });
    setCachedStatus(dbPath(), "linear", "ENG-900", "canceled");

    const result = await runCli(
      ["reconcile", claimedElsewhere, neverRefreshed, toCancel, "--apply", "--json"],
      { cwd: repo.dir },
    );

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as ReconcileResult;
    expect(doc.skipClaimed.items).toEqual([
      expect.objectContaining({ taskId: claimedElsewhere, holder: "/elsewhere/worktree" }),
    ]);
    expect(doc.blockedByRef.items).toEqual([expect.objectContaining({ taskId: neverRefreshed })]);
    expect(doc.advance.items).toEqual([
      expect.objectContaining({ taskId: toCancel, target: "Cancelled" }),
    ]);

    expect(readTaskRow(claimedElsewhere)?.lane).not.toBe("Done");
    expect(readTaskRow(toCancel)?.lane).toBe("Cancelled");
  });

  it("AC5: --json parity for preview and apply", async () => {
    const previewTask = await add(["preview task"]);
    await runCli(["ref", "add", previewTask, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");

    const previewText = (await runCli(["reconcile", previewTask], { cwd: repo.dir })).stdout;
    const previewJson = (
      await runCli(["reconcile", previewTask, "--json"], { cwd: repo.dir })
    ).json() as ReconcileResult;
    expect(previewJson.applied).toBe(false);
    expect(previewJson.advance.items).toEqual([
      expect.objectContaining({ taskId: previewTask, target: "Done" }),
    ]);
    expect(previewText).toContain(previewTask);
    expect(previewText).toContain("Done");

    const applyTask = await add(["apply task"]);
    await runCli(["ref", "add", applyTask, "https://github.com/acme/widgets/pull/8"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#8", "merged");
    const applyText = (await runCli(["reconcile", applyTask, "--apply"], { cwd: repo.dir })).stdout;
    expect(applyText).toContain(applyTask);
    expect(applyText).toContain("Done");

    // A dedicated third task for the apply-json half: reusing previewTask
    // (already previewed above) would let `applied: true` alone stand in for
    // proof that a genuine advance happened, which it does not — an empty
    // advance.items with applied:true would pass that assertion too.
    const applyJsonTask = await add(["apply json task"]);
    await runCli(["ref", "add", applyJsonTask, "https://github.com/acme/widgets/pull/9"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#9", "merged");
    const applyJson = (
      await runCli(["reconcile", applyJsonTask, "--apply", "--json"], { cwd: repo.dir })
    ).json() as ReconcileResult;

    expect(applyJson.applied).toBe(true);
    expect(applyJson.advance.items).toEqual([
      expect.objectContaining({ taskId: applyJsonTask, target: "Done" }),
    ]);
  });
});
