import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { NextResult } from "../../src/core/contract.js";
import { openStore } from "../../src/core/store.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";
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

async function lane(id: string, to: string): Promise<void> {
  await runCli(["update", id, "--lane", to], { cwd: repo.dir });
}

/**
 * Claims `id` for a worktree other than this repo's own, directly — `katra
 * claim` does not exist yet (T9), so the fixture writes the row itself, the
 * same bypass `seedClaim` exists for.
 */
function claimElsewhere(id: string): void {
  const { store } = openStore(repo.dir, {});
  try {
    seedClaim(store, { taskId: id, holder: "/elsewhere/worktree" });
  } finally {
    store.close();
  }
}

describe("katra next", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("next");
  });

  it("names the claimed count instead of claiming the lane is empty", async () => {
    const task = await add(["ready but taken"]);
    await lane(task, "Planned");
    claimElsewhere(task);

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).not.toContain("nothing is in the Planned lane");
    expect(result.stdout).toContain("1 ready task is claimed by another worktree");
    expect(result.stdout).toContain("release <id> --force");
  });

  it("prints both the blocked list and the claimed count when both apply", async () => {
    // Iteration-3 addendum: the claimed count is an additional line, not a
    // fourth exclusive branch — blocked and claimed facts coexist.
    const blocker = await add(["the blocker"]);
    const blocked = await add(["cannot start"]);
    await lane(blocked, "Planned");
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });
    const claimed = await add(["ready but taken"]);
    await lane(claimed, "Planned");
    claimElsewhere(claimed);

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("blocked");
    expect(result.stdout).toContain("cannot start");
    expect(result.stdout).toContain("claimed by another worktree");
  });

  it("reports claimedElsewhere on the none arm's --json, distinct from empty", async () => {
    const empty = await runCli(["next", "--json"], { cwd: repo.dir });
    const emptyJson = empty.json() as NextResult;
    expect(emptyJson.status).toBe("none");
    if (emptyJson.status !== "none") throw new Error("unreachable");
    expect(emptyJson.claimedElsewhere).toBe(0);

    const task = await add(["ready but taken"]);
    await lane(task, "Planned");
    claimElsewhere(task);

    const result = await runCli(["next", "--json"], { cwd: repo.dir });
    const json = result.json() as NextResult;

    expect(json.status).toBe("none");
    if (json.status !== "none") throw new Error("unreachable");
    expect(json.claimedElsewhere).toBe(1);
  });
});
