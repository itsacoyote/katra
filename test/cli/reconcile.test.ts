/**
 * `katra reconcile` (F9 T4) — preview, `--apply`, `--json`, through the real
 * CLI. Every scenario here runs against cached ref status seeded directly
 * (`setCachedStatus`, F9 T3) — `reconcile` reads the cache only, never the
 * network, so there is no provider to stub.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { ReconcileResult } from "../../src/core/contract.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { KatraException } from "../../src/core/errors.js";
import { openStore } from "../../src/core/store.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo, setCachedStatus } from "../helpers/fixture.js";

// --- closeTask/cancelTask mock (for the in-tx race-path test only) --------
// A hook object, toggled per test, wrapping the real implementation for
// every other test — the same technique test/core/providers.test.ts's own
// runGh mock uses, so reconcile's real apply path stays exercised by every
// scenario that does not explicitly arrange a race.

const lifecycleHook = vi.hoisted(() => ({
  closeThrows: null as KatraException | null,
  cancelThrows: null as KatraException | null,
}));
vi.mock("../../src/core/tasks/lifecycle.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/tasks/lifecycle.js")>();
  return {
    ...original,
    closeTask: (...args: Parameters<typeof original.closeTask>) => {
      if (lifecycleHook.closeThrows !== null) throw lifecycleHook.closeThrows;
      return original.closeTask(...args);
    },
    cancelTask: (...args: Parameters<typeof original.cancelTask>) => {
      if (lifecycleHook.cancelThrows !== null) throw lifecycleHook.cancelThrows;
      return original.cancelTask(...args);
    },
  };
});

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
  lifecycleHook.closeThrows = null;
  lifecycleHook.cancelThrows = null;
});
afterEach(() => repo.cleanup());

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

/** The store fixture's own SQLite file — `setCachedStatus`'s `dbPath`. */
function dbPath(): string {
  return join(repo.dir, ".git", STORE_DIR_NAME, DB_FILE_NAME);
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

/** Reads one ref row directly, by external id. */
function readRefRow(
  externalId: string,
): { cached_status: unknown; cached_title: unknown; synced_at: unknown } | undefined {
  const { store } = openStore(repo.dir, {});
  try {
    return store.db
      .prepare("SELECT cached_status, cached_title, synced_at FROM refs WHERE external_id = ?")
      .get(externalId) as
      | { cached_status: unknown; cached_title: unknown; synced_at: unknown }
      | undefined;
  } finally {
    store.close();
  }
}

function countRows(table: "events" | "claims"): number {
  const { store } = openStore(repo.dir, {});
  try {
    return (store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  } finally {
    store.close();
  }
}

describe("katra reconcile", () => {
  it("bare reconcile previews an advance and changes no task, event, claim, or ref state", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");

    const beforeTask = readTaskRow(task);
    const beforeRef = readRefRow("acme/widgets#7");
    const beforeEvents = countRows("events");
    const beforeClaims = countRows("claims");

    const result = await runCli(["reconcile", "--json"], { cwd: repo.dir });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as ReconcileResult;
    expect(doc.applied).toBe(false);
    expect(doc.advance.items).toEqual([expect.objectContaining({ taskId: task, target: "Done" })]);

    // Targeted direct reads, not a byte-compare or a writeTx spy — the
    // presence heartbeat openStore bumps on every command is the standing,
    // documented exception, and neither of those two techniques could tell
    // it apart from an actual task-state write.
    expect(readTaskRow(task)).toEqual(beforeTask);
    expect(readRefRow("acme/widgets#7")).toEqual(beforeRef);
    expect(countRows("events")).toBe(beforeEvents);
    expect(countRows("claims")).toBe(beforeClaims);
  });

  it("reconcile --apply closes the task with actor reconcile and the pinned reason wording", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");

    const result = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as ReconcileResult;
    expect(doc.applied).toBe(true);
    expect(doc.advance.items).toEqual([
      {
        taskId: task,
        title: "a task",
        target: "Done",
        triggeringRefs: [expect.objectContaining({ externalId: "acme/widgets#7" })],
        reason: "merged — github:acme/widgets#7",
      },
    ]);

    expect(readTaskRow(task)?.lane).toBe("Done");

    const log = await runCli(["log", task, "--json"], { cwd: repo.dir });
    const events = (
      log.json() as {
        events: ReadonlyArray<{ type: string; actor: string; reason: string | null }>;
      }
    ).events;
    const closed = events.filter((event) => event.type === "closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.actor).toBe("reconcile");
    expect(closed[0]?.reason).toBe("merged — github:acme/widgets#7");
  });

  it("a second --apply run is a zero-change zero-event no-op", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");

    const first = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });
    expect((first.json() as ReconcileResult).advance.count).toBe(1);
    const afterFirstEvents = countRows("events");

    const second = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });

    expect(second.exitCode, second.stderr).toBe(EXIT.ok);
    const doc = second.json() as ReconcileResult;
    // The task is terminal now, so gatherCandidates no longer returns it at
    // all — zero candidates, not a "no-op" verdict for a still-eligible one.
    expect(doc.totals.tasks).toBe(0);
    expect(countRows("events")).toBe(afterFirstEvents);
  });

  it("an all-blocked run exits 0 and names the refs that prevent advancement", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/8"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");
    setCachedStatus(dbPath(), "github", "acme/widgets#8", "open");

    const result = await runCli(["reconcile"], { cwd: repo.dir });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    expect(result.stdout).toContain("acme/widgets#8");
  });

  it("a task claimed by another worktree is skipped and reported under --apply", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");

    const { seedClaim } = await import("../helpers/seed.js");
    const { store } = openStore(repo.dir, {});
    try {
      seedClaim(store, { taskId: task, holder: "/elsewhere/worktree" });
    } finally {
      store.close();
    }

    const result = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as ReconcileResult;
    expect(doc.skipClaimed.items).toEqual([
      { taskId: task, title: "a task", holder: "/elsewhere/worktree" },
    ]);
    expect(doc.advance.count).toBe(0);
    expect(readTaskRow(task)?.lane).not.toBe("Done");
  });

  it("a caught claimed_elsewhere refusal renders identically to the skip-claimed verdict in text and json", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");

    // Stubbed, not a genuine race: the engine planned "advance" (the ref's
    // holder was unclaimed at gather time), and the write itself is made to
    // fail as if another worktree claimed it in the gap — the shape T1's
    // real in-tx guard produces, which is what plan-review LOW-2 says this
    // test does not need to reproduce for real.
    lifecycleHook.closeThrows = new KatraException({
      code: "claimed_elsewhere",
      message: `${task} is held by someone else`,
      holder: "/elsewhere/worktree",
    });

    const jsonResult = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });
    expect(jsonResult.exitCode, jsonResult.stderr).toBe(EXIT.ok);
    const doc = jsonResult.json() as ReconcileResult;
    // The identical shape a precomputed skip-claimed verdict produces — see
    // the "claimed by another worktree" test above for that path's own
    // proof of the same section/item shape; both render through the one
    // section-rendering function, so "identical" follows from there being
    // only one such function, not a second comparison here.
    expect(doc.skipClaimed.items).toEqual([
      { taskId: task, title: "a task", holder: "/elsewhere/worktree" },
    ]);
    expect(doc.advance.count).toBe(0);

    const textResult = await runCli(["reconcile", "--apply"], { cwd: repo.dir });
    expect(textResult.exitCode, textResult.stderr).toBe(EXIT.ok);
    expect(textResult.stdout).toContain(task);
    expect(textResult.stdout).toContain("/elsewhere/worktree");

    expect(readTaskRow(task)?.lane).not.toBe("Done");
  });

  it("applying to a self-claimed task emits released and closed both stamped reconcile", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");
    await runCli(["claim", task], { cwd: repo.dir });

    const result = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as ReconcileResult;
    expect(doc.advance.items).toEqual([expect.objectContaining({ taskId: task, target: "Done" })]);

    const log = await runCli(["log", task, "--json"], { cwd: repo.dir });
    const events = (log.json() as { events: ReadonlyArray<{ type: string; actor: string }> })
      .events;
    const released = events.filter((event) => event.type === "released");
    const closed = events.filter((event) => event.type === "closed");
    expect(released).toHaveLength(1);
    expect(released[0]?.actor).toBe("reconcile");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.actor).toBe("reconcile");
  });

  it("a hostile external id renders one-lined in preview and in the applied reason", async () => {
    // RLO via fromCharCode: bidi/zero-width characters ride through storage
    // by design (refs/parse.ts's own control-character refusal covers only
    // C0/DEL/C1/line separators) — render sanitization is the defense, the
    // same technique test/cli/ref.test.ts's own hostile-id test uses.
    const task = await add(["a task"]);
    const rlo = String.fromCharCode(0x202e);
    const externalId = `evil${rlo}id`;
    await runCli(["ref", "add", task, "--provider", "github", "--id", externalId], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", externalId, "merged");

    const preview = await runCli(["reconcile"], { cwd: repo.dir });
    expect(preview.exitCode, preview.stderr).toBe(EXIT.ok);
    expect(preview.stdout).not.toContain(rlo);

    const applied = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });
    expect(applied.exitCode, applied.stderr).toBe(EXIT.ok);

    // Stored raw — events store raw, sinks sanitize (contract.ts's own
    // ReconcileAdvanceItem docs) — read back verbatim via log --json.
    const log = await runCli(["log", task, "--json"], { cwd: repo.dir });
    const events = (
      log.json() as { events: ReadonlyArray<{ type: string; reason: string | null }> }
    ).events;
    const closedReason = events.find((event) => event.type === "closed")?.reason;
    expect(closedReason).toBe(`merged — github:${externalId}`);

    // But rendering that same event neutralizes it — describeEvent's own
    // oneLine, already proven in format.ts's own suite; this is the
    // end-to-end proof that reconcile's stored reason actually reaches it.
    const logText = await runCli(["log", task], { cwd: repo.dir });
    expect(logText.stdout).not.toContain(rlo);
  });

  it("a multi-ref advance joins every triggering ref in the pinned reason wording", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    await runCli(["ref", "add", task, "ENG-451"], { cwd: repo.dir });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");
    setCachedStatus(dbPath(), "linear", "ENG-451", "completed");

    const result = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as ReconcileResult;
    expect(doc.advance.items[0]?.reason).toBe(
      "merged — github:acme/widgets#7, completed — linear:ENG-451",
    );
  });

  it("a multi-ref advance neutralizes every hostile id in the joined reason and stores both raw", async () => {
    // Built by codepoint, not typed as literals: RLO and ALM are ordinary
    // printable codepoints that reorder text without being visible, the same
    // technique this file's own single-ref hostile-id test above uses.
    const rlo = String.fromCharCode(0x202e);
    const alm = String.fromCharCode(0x061c);
    const githubId = `evil${rlo}gh`;
    const linearId = `EVIL${alm}LN`;

    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "--provider", "github", "--id", githubId], {
      cwd: repo.dir,
    });
    await runCli(["ref", "add", task, "--provider", "linear", "--id", linearId], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", githubId, "merged");
    setCachedStatus(dbPath(), "linear", linearId, "completed");

    const preview = await runCli(["reconcile"], { cwd: repo.dir });
    expect(preview.exitCode, preview.stderr).toBe(EXIT.ok);
    expect(preview.stdout).not.toContain(rlo);
    expect(preview.stdout).not.toContain(alm);

    const applied = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });
    expect(applied.exitCode, applied.stderr).toBe(EXIT.ok);

    // Stored raw — events store raw, sinks sanitize — read back verbatim via
    // log --json, carrying both hostile ids intact.
    const log = await runCli(["log", task, "--json"], { cwd: repo.dir });
    const events = (
      log.json() as { events: ReadonlyArray<{ type: string; reason: string | null }> }
    ).events;
    const closedReason = events.find((event) => event.type === "closed")?.reason;
    expect(closedReason).toBe(`merged — github:${githubId}, completed — linear:${linearId}`);

    // But rendering that stored reason neutralizes it, end to end.
    const logText = await runCli(["log", task], { cwd: repo.dir });
    expect(logText.stdout).not.toContain(rlo);
    expect(logText.stdout).not.toContain(alm);
  });

  it("--json mirrors the text verdicts for preview and apply", async () => {
    const previewTask = await add(["preview task"]);
    await runCli(["ref", "add", previewTask, "https://github.com/acme/widgets/pull/7"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#7", "merged");

    const previewJson = (
      await runCli(["reconcile", previewTask, "--json"], { cwd: repo.dir })
    ).json() as ReconcileResult;
    const previewText = (await runCli(["reconcile", previewTask], { cwd: repo.dir })).stdout;
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
    const applyJson = (
      await runCli(["reconcile", applyTask, "--apply", "--json"], { cwd: repo.dir })
    ).json() as ReconcileResult;
    expect(applyJson.applied).toBe(true);
    expect(applyJson.advance.items).toEqual([
      expect.objectContaining({ taskId: applyTask, target: "Done" }),
    ]);

    const applyTextTask = await add(["apply text task"]);
    await runCli(["ref", "add", applyTextTask, "https://github.com/acme/widgets/pull/9"], {
      cwd: repo.dir,
    });
    setCachedStatus(dbPath(), "github", "acme/widgets#9", "merged");
    const applyText = (await runCli(["reconcile", applyTextTask, "--apply"], { cwd: repo.dir }))
      .stdout;
    expect(applyText).toContain(applyTextTask);
    expect(applyText).toContain("Done");
  });

  it("a canceled linear ref cancels the task on apply", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "ENG-451"], { cwd: repo.dir });
    setCachedStatus(dbPath(), "linear", "ENG-451", "canceled");

    const result = await runCli(["reconcile", "--apply", "--json"], { cwd: repo.dir });

    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const doc = result.json() as ReconcileResult;
    expect(doc.advance.items).toEqual([
      expect.objectContaining({ taskId: task, target: "Cancelled" }),
    ]);
    expect(readTaskRow(task)?.lane).toBe("Cancelled");
  });
});
