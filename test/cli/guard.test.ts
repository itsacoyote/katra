/**
 * `katra guard` — the before-edit takeover check, exercised through the real
 * CLI end to end (F11 T2, ADR-019).
 *
 * The core tenure rule (K+1 bounded reads, liveness, re-coordination) is
 * covered by `test/core/guard.test.ts`; these tests are about the CLI's own
 * contract — the exit code, the sanitized stderr reason, `--liveness`
 * parsing, and fail-open behavior on every failure — not about re-proving
 * `guardCheck`'s tenure logic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { GuardResult } from "../../src/core/contract.js";
import { openStore } from "../../src/core/store.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";
import { seedClaim, seedPresence } from "../helpers/seed.js";

/** Deny's exit code — shares the numeric value 2 with commander's own usage
 * path by protocol necessity (ADR-019's amendment), not by coincidence with
 * this suite's own constant, so it is asserted as a literal here rather than
 * imported from the module under test. */
const GUARD_DENY_EXIT = 2;

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => repo.cleanup());

async function add(title: string): Promise<string> {
  return (await runCli(["add", title], { cwd: repo.dir })).stdout.trim();
}

/**
 * Force-takes `taskId` for the worktree at `rivalCwd` — the same
 * release --force + claim sequence `test/core/guard.test.ts`'s own `takeOver`
 * helper uses, run through the real CLI so the event history (and the
 * rival's real presence heartbeat) are exactly what a live agent would
 * produce.
 */
async function takeOverViaCli(taskId: string, rivalCwd: string): Promise<void> {
  await runCli(["release", taskId, "--force"], { cwd: rivalCwd });
  await runCli(["claim", taskId], { cwd: rivalCwd });
}

describe("katra guard", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("guard");
  });

  it("exits 0 and reports allow when the worktree holds its task", async () => {
    const task = await add("do the thing");
    await runCli(["claim", task], { cwd: repo.dir });

    const result = await runCli(["guard"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("allow");
    expect(result.stderr).toBe("");
  });

  it("exits 2 on a live takeover with the sanitized reason on stderr", async () => {
    const task = await add("contested");
    await runCli(["claim", task], { cwd: repo.dir });
    const rival = repo.addWorktree("feature/rival");
    await takeOverViaCli(task, rival);

    const result = await runCli(["guard"], { cwd: repo.dir });

    expect(result.exitCode).toBe(GUARD_DENY_EXIT);
    expect(result.stderr).toContain(task);
    expect(result.stderr).toContain("feature/rival");
    // Exactly one non-empty stderr line: the sanitized reason, nothing else.
    const lines = result.stderr.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
  });

  it("mirrors the text verdict in --json", async () => {
    const task = await add("contested");
    await runCli(["claim", task], { cwd: repo.dir });
    const rival = repo.addWorktree("feature/rival");
    await takeOverViaCli(task, rival);

    const jsonRun = await runCli(["guard", "--json"], { cwd: repo.dir });
    expect(jsonRun.exitCode).toBe(GUARD_DENY_EXIT);
    const document = jsonRun.json() as GuardResult;
    expect(document.verdict).toBe("deny");
    if (document.verdict !== "deny") return;

    const textRun = await runCli(["guard"], { cwd: repo.dir });
    expect(textRun.exitCode).toBe(GUARD_DENY_EXIT);
    expect(textRun.stdout).toContain("deny");
    expect(textRun.stdout).toContain(document.taskId);
    expect(textRun.stdout).toContain(document.actor);
  });

  it("exits 0 with a warning and no deny when katra was never initialized", async () => {
    // A fresh repository with no `katra init` at all — distinct from the
    // outer `repo`, whose beforeEach already initializes it.
    const uninit = createGitRepo();
    try {
      const result = await runCli(["guard"], { cwd: uninit.dir });

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.stderr).not.toBe("");
      expect(result.stdout).not.toContain("deny");
    } finally {
      uninit.cleanup();
    }
  });

  it("strips a hostile stored actor's control characters from the deny reason", async () => {
    // Built by codepoint, per `test/cli/claim.test.ts`'s convention — an
    // invisible literal in test source is unreviewable.
    const ESC = String.fromCharCode(0x1b);

    const worktreeB = repo.addWorktree("feature/hostile");
    const task = await add("contested");
    const claimed = await runCli(["claim", task, "--json"], { cwd: repo.dir });
    const mineActor = (claimed.json() as { claim: { actor: string } }).claim.actor;

    const hostileActor = `feature/hostile ${ESC}[31mHACKED${ESC}[0m\nsecond line @ ${worktreeB}`;
    const now = new Date().toISOString();

    const { store } = openStore(repo.dir, {});
    try {
      // Replaces the real claim with a directly-seeded takeover recorded
      // under a hostile stored actor — the exact vector `oneLine` sanitizes
      // (T2's security-scan concern): `claims.actor` and `events.actor` are
      // free text (no CHECK on their shape), so a corrupted or tampered row
      // can carry anything, and it is fed straight into agent-visible stderr.
      store.db.prepare("DELETE FROM claims WHERE task_id = ?").run(task);
      store.db
        .prepare(
          `INSERT INTO events
             (type, entity_id, epic_id, actor, from_lane, to_lane, ref, reason, title, prior_actor, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run("released", task, null, hostileActor, null, null, null, null, null, mineActor, now);
      seedClaim(store, { taskId: task, holder: worktreeB, actor: hostileActor });
      seedPresence(store, { worktree: worktreeB, lastSeen: now });
    } finally {
      store.close();
    }

    const result = await runCli(["guard"], { cwd: repo.dir });

    expect(result.exitCode).toBe(GUARD_DENY_EXIT);
    expect(result.stderr).not.toContain(ESC);
    const lines = result.stderr.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
  });

  it("ends the deny reason with the release --force unblock hint", async () => {
    const task = await add("contested");
    await runCli(["claim", task], { cwd: repo.dir });
    const rival = repo.addWorktree("feature/rival");
    await takeOverViaCli(task, rival);

    const result = await runCli(["guard"], { cwd: repo.dir });

    expect(result.stderr.trim().endsWith(`katra release --force ${task}`)).toBe(true);
  });

  it("honors --liveness overriding the default window", async () => {
    const task = await add("contested");
    await runCli(["claim", task], { cwd: repo.dir });
    const rival = repo.addWorktree("feature/rival");
    await takeOverViaCli(task, rival);

    // 90 minutes stale on both signals — outside the default 60-minute
    // window, the same shape `test/core/guard.test.ts`'s own liveness tests
    // use, applied here through the CLI's own store.
    const ninetyMinutesAgo = new Date(Date.now() - 90 * 60_000).toISOString();
    const { store } = openStore(repo.dir, {});
    try {
      store.db
        .prepare("UPDATE claims SET claimed_at = ? WHERE task_id = ?")
        .run(ninetyMinutesAgo, task);
      store.db
        .prepare("UPDATE presence SET last_seen = ? WHERE worktree = ?")
        .run(ninetyMinutesAgo, rival);
    } finally {
      store.close();
    }

    const defaultWindow = await runCli(["guard"], { cwd: repo.dir });
    expect(defaultWindow.exitCode).toBe(EXIT.ok);

    // A caller-supplied floor reaching back further reads the same rival as
    // live — the option is honored, not merely accepted and ignored.
    const extended = await runCli(["guard", "--liveness", "120m"], { cwd: repo.dir });
    expect(extended.exitCode).toBe(GUARD_DENY_EXIT);
  });

  it("exits 0 with a warning when the --liveness value is malformed", async () => {
    const task = await add("do the thing");
    await runCli(["claim", task], { cwd: repo.dir });

    const result = await runCli(["guard", "--liveness", "not-a-real-value"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stderr).not.toBe("");
    expect(result.stdout).not.toContain("deny");
  });

  it("prints no verdict on stdout when the invocation is malformed", async () => {
    // Never reaches the handler at all — commander's own usage path, which
    // also happens to exit 2 (the documented loud-block known limit).
    const result = await runCli(["guard", "--nonsense"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stdout).toBe("");
  });
});
