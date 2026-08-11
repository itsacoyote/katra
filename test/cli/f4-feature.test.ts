/**
 * F4's whole coordination story, through the real CLI.
 *
 * Every scenario here runs across **two real, linked worktrees** of one
 * repository (`fixture.addWorktree` / `repo.addWorktree`) sharing one store —
 * never two calls from the same directory. Same-directory "workers" resolve
 * to one git identity and are a single holder: they cannot exercise a
 * contended claim, and they would pass even if the compare-and-set held no
 * lock at all. `test/core/claims.test.ts`'s own race test documents the same
 * reasoning at the core level; this file re-proves the story through command
 * dispatch, exit codes and rendered text, which a core-level call cannot
 * cover.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { EventLog, NextResult } from "../../src/core/contract.js";
import type { TaskView } from "../../src/core/tasks/types.js";
import { runCli } from "../helpers/cli.js";
import { runConcurrent } from "../helpers/concurrent.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";

let repo: GitFixture;
let worktreeB: string;

beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
  worktreeB = repo.addWorktree("feature/other");
});
afterEach(() => repo.cleanup());

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

describe("F4 coordination story", () => {
  it("claims, refuses a contended claim, and releases across two real worktrees", async () => {
    const task = await add(["shared work", "--lane", "Planned"]);

    const claimed = await runCli(["claim", task], { cwd: repo.dir });
    expect(claimed.exitCode).toBe(EXIT.ok);
    expect(claimed.stdout).toContain(task);
    expect(claimed.stdout).toContain("claimed by main");

    // The second worktree is a genuinely different git identity — its own
    // branch, its own resolved worktree path — so this is the real
    // compare-and-set the module docs describe, not a synthetic seed.
    const contended = await runCli(["claim", task], { cwd: worktreeB });
    expect(contended.exitCode).toBe(EXIT.conflict);
    expect(contended.stderr).toContain("main");
    expect(contended.stderr).toContain("last seen");
    expect(contended.stderr).toContain("release --force");

    // Refused: neither the claim nor the event stream moved.
    const log = (await runCli(["log", task, "--json"], { cwd: repo.dir })).json() as EventLog;
    expect(log.events.map((event) => event.type)).toEqual(["claimed", "created"]);

    const released = await runCli(["release", task], { cwd: repo.dir });
    expect(released.exitCode).toBe(EXIT.ok);
    expect(released.stdout).toContain(task);
    expect(released.stdout).toContain("released");

    // Genuinely free, not merely reported as such: the other worktree can now
    // take it.
    const reclaimed = await runCli(["claim", task], { cwd: worktreeB });
    expect(reclaimed.exitCode).toBe(EXIT.ok);
  });

  it("next and board steer around another worktree's claim in both directions", async () => {
    // Default priority (P2), still Planned, claimed by this worktree.
    const own = await add(["mine, still planned", "--lane", "Planned"]);
    // Higher priority (P0) and never claimed by anyone.
    const unclaimed = await add([
      "higher priority, unclaimed",
      "--lane",
      "Planned",
      "--priority",
      "0",
    ]);

    const claimedOwn = await runCli(["claim", own], { cwd: repo.dir });
    expect(claimedOwn.exitCode).toBe(EXIT.ok);

    // Resumes own: from the holder's own worktree, `next` returns the task it
    // already holds ahead of a higher-priority unclaimed one (ADR-012).
    const nextOwn = (await runCli(["next", "--json"], { cwd: repo.dir })).json() as NextResult;
    if (nextOwn.status !== "found") throw new Error("expected next to find the own claim");
    expect(nextOwn.task.id).toBe(own);

    // Skips other's: from the other worktree, `next` never offers a task
    // this worktree holds and instead returns the highest-priority
    // unclaimed candidate.
    const nextOther = (await runCli(["next", "--json"], { cwd: worktreeB })).json() as NextResult;
    if (nextOther.status !== "found") throw new Error("expected next to find the unclaimed task");
    expect(nextOther.task.id).toBe(unclaimed);

    // The board mirrors the same asymmetry. From the other worktree, the
    // held row carries the marker naming the holder.
    const boardOther = await runCli(["board"], { cwd: worktreeB });
    const otherRow = boardOther.stdout.split("\n").find((line) => line.includes(own)) ?? "";
    expect(otherRow).toContain("claimed by main");
    expect(otherRow).toContain("last seen");

    // From the holding worktree itself, the same row carries no marker —
    // ADR-012: claimed-by-me is deliberately invisible on the board.
    const boardOwn = await runCli(["board"], { cwd: repo.dir });
    const ownRow = boardOwn.stdout.split("\n").find((line) => line.includes(own)) ?? "";
    expect(ownRow).not.toBe("");
    expect(ownRow).not.toContain("claimed by");

    // The "skips other's" assertion above passes even with the exclusion
    // deleted, because `unclaimed` also outranks `own` on plain priority —
    // priority alone would produce the same answer. Claiming it too removes
    // that ambiguity: with every Planned task now held by repo.dir, the only
    // way worktreeB's `next` can still answer "nothing" is the exclusion
    // itself doing its job, and `claimedElsewhere` counts both of them.
    const claimedUnclaimed = await runCli(["claim", unclaimed], { cwd: repo.dir });
    expect(claimedUnclaimed.exitCode).toBe(EXIT.ok);

    const nextOtherAllClaimed = (
      await runCli(["next", "--json"], { cwd: worktreeB })
    ).json() as NextResult;
    expect(nextOtherAllClaimed.status).toBe("none");
    if (nextOtherAllClaimed.status !== "none") throw new Error("unreachable");
    expect(nextOtherAllClaimed.claimedElsewhere).toBe(2);
  });

  it("force-release displaces a live holder, and the takeover is visible in the log", async () => {
    const task = await add(["taken", "--lane", "Planned"]);

    const claimed = await runCli(["claim", task, "--json"], { cwd: worktreeB });
    expect(claimed.exitCode).toBe(EXIT.ok);
    const claimedPayload = claimed.json() as { claim: { actor: string } };
    const holderActor = claimedPayload.claim.actor;

    const refused = await runCli(["release", task], { cwd: repo.dir });
    expect(refused.exitCode).toBe(EXIT.conflict);
    expect(refused.stderr).toContain(holderActor);
    expect(refused.stderr).toContain("release --force");

    const forced = await runCli(["release", task, "--force"], { cwd: repo.dir });
    expect(forced.exitCode).toBe(EXIT.ok);
    expect(forced.stdout).toContain(holderActor);

    // The takeover reads straight off the event: `released`'s `priorActor`
    // names exactly who was displaced.
    const log = await runCli(["log", task], { cwd: repo.dir });
    const releasedLine = log.stdout.split("\n").find((line) => line.includes("released")) ?? "";
    expect(releasedLine).toContain(`from ${holderActor}`);
  });

  it("closing a claimed task releases it in the same transaction", async () => {
    const task = await add(["auto released", "--lane", "Planned"]);

    const claimed = await runCli(["claim", task], { cwd: repo.dir });
    expect(claimed.exitCode).toBe(EXIT.ok);

    const closed = await runCli(["close", task], { cwd: repo.dir });
    expect(closed.exitCode).toBe(EXIT.ok);

    // The events land together or not at all (spec req 5): `released` sits
    // between `closed` and `claimed`, newest first.
    const log = (await runCli(["log", task, "--json"], { cwd: repo.dir })).json() as EventLog;
    expect(log.events.map((event) => event.type)).toEqual([
      "closed",
      "released",
      "claimed",
      "created",
    ]);

    // Genuinely released, not merely logged as such.
    const view = (await runCli(["show", task, "--json"], { cwd: repo.dir })).json() as TaskView;
    expect(view.claim).toBeNull();
  });
});

describe("F4 two-process claim race", () => {
  it("lets exactly one of two real CLI processes across two worktrees win a contested claim", {
    timeout: 60_000,
  }, async () => {
    const task = await add(["contested across processes", "--lane", "Planned"]);

    // Through the real CLI dispatch — `run`, the exact function
    // `src/cli.ts` hands `process.argv` to — rather than the compiled
    // `dist/cli.js` binary: this suite runs directly against `src/`, and
    // spawning the build would require a `pnpm build` this test cannot
    // assume just ran, the same reason `concurrent.ts`'s resolve hook
    // exists at all (see its module docs). `run` *is* the CLI: parsing,
    // dispatch and formatting, minus only the `process.exit` call
    // `cli.ts` itself adds on top.
    const programUrl = new URL("../../src/cli/program.ts", import.meta.url).href;

    const outcomes = await runConcurrent<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>({
      count: 2,
      // runConcurrent's `cwd` is one string shared by every process, but
      // this race needs each process running from a genuinely different
      // worktree — so each path rides over `env`, keyed by the in-scope
      // `INDEX` binding the worker template exposes (T4's own race test is
      // the template for this).
      env: {
        KATRA_WORKTREE_0: repo.dir,
        KATRA_WORKTREE_1: worktreeB,
      },
      source: `
          const { run } = await import(${JSON.stringify(programUrl)});
          const cwd = process.env["KATRA_WORKTREE_" + INDEX];
          barrier();
          let stdout = "", stderr = "";
          const exitCode = await run(["claim", ${JSON.stringify(task)}], {
            cwd,
            streams: {
              out: (text) => { stdout += text; },
              err: (text) => { stderr += text; },
            },
          });
          report({ exitCode, stdout, stderr });
        `,
    });

    expect(
      outcomes.every((outcome) => outcome.ok),
      outcomes.map((outcome) => outcome.stderr).join("\n"),
    ).toBe(true);

    const results = outcomes.map((outcome) => outcome.value).filter((value) => value !== undefined);
    expect(results).toHaveLength(2);

    const winners = results.filter((result) => result.exitCode === EXIT.ok);
    const losers = results.filter((result) => result.exitCode === EXIT.conflict);
    // The decisive check: whatever the timing, exactly one process won and
    // the other reports it, never both and never neither.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.stderr).toContain("release --force");
    expect(winners[0]?.stdout).toContain("claimed by");

    const view = (await runCli(["show", task, "--json"], { cwd: repo.dir })).json() as TaskView;
    expect(view.claim).not.toBeNull();
    // Whoever the log says won is who the store actually recorded — the
    // winner's own stdout names its actor, and that actor is the one the
    // store now holds.
    expect(winners[0]?.stdout).toContain(view.claim?.actor ?? " impossible ");

    const log = (await runCli(["log", task, "--json"], { cwd: repo.dir })).json() as EventLog;
    expect(log.events.map((event) => event.type)).toEqual(["claimed", "created"]);
  });
});
