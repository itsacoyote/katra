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
    // The blocked lead has to become claim-aware too: "no Planned task is
    // ready" reads as if none exists at all, when one does and is merely
    // held elsewhere.
    expect(result.stdout).not.toMatch(/no Planned task is ready/);
    expect(result.stdout).toContain("no unclaimed Planned task is ready");
  });

  it("drops the empty-lane claim when untriaged work coexists with a claim", async () => {
    // The same self-contradiction, on the untriaged lead: "nothing is in the
    // Planned lane" over a backlog that has a Planned task, merely claimed.
    await add(["never triaged"]); // stays Defined — untriaged, not blocked
    const claimed = await add(["ready but taken"]);
    await lane(claimed, "Planned");
    claimElsewhere(claimed);

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).not.toContain("nothing is in the Planned lane");
    expect(result.stdout).toContain("waiting to be planned");
    expect(result.stdout).toContain("claimed by another worktree");
  });

  it("surfaces claimedElsewhere on the none arm's --json payload", async () => {
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

describe("katra next and a hostile stored title", () => {
  // Built by codepoint, per claim.test.ts's convention — an invisible
  // literal in test source is unreviewable.
  const ESC = String.fromCharCode(0x1b);

  it("does not let an embedded newline forge an extra waits-on row", async () => {
    // The scan's scenario: `formatNext` was the one text renderer that never
    // sanitized a stored title, so an embedded newline in a blocked task's
    // own title rendered as a second physical line indistinguishable from a
    // genuine "waits on" row — the exact forgery katra's other renderers
    // (board.test.ts, brief.test.ts) are already guarded against.
    const blocker = await add(["the real blocker"]);
    const hostileTitle =
      `stuck task${ESC}[31mHACKED\n` +
      "    waits on kt-fake0000  Planned  a blocker that does not exist";
    const stuck = await add([hostileTitle, "--lane", "Planned"]);
    await runCli(["dep", stuck, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).not.toContain(ESC);
    // The readable remnant survives — sanitizing flattens the field, it does
    // not blank it.
    expect(result.stdout).toContain("stuck task");
    expect(result.stdout).toContain("HACKED");

    // Exactly one real "waits on" row — the genuine blocker's — never a
    // second one forged out of the hostile title's embedded newline.
    const waitsOnLines = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("    waits on "));
    expect(waitsOnLines).toHaveLength(1);
    expect(waitsOnLines[0]).toContain(blocker);
    expect(waitsOnLines[0]).not.toContain("kt-fake0000");
  });
});
