import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
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

async function add(title: string): Promise<string> {
  return (await runCli(["add", title], { cwd: repo.dir })).stdout.trim();
}

/**
 * Claims `id` for a worktree other than this repo's own, directly — the same
 * bypass `test/cli/next.test.ts` and `test/cli/claim.test.ts` use.
 */
function claimElsewhere(id: string): void {
  const { store } = openStore(repo.dir, {});
  try {
    seedClaim(store, {
      taskId: id,
      holder: "/elsewhere/worktree",
      actor: "feature/other @ /elsewhere/worktree",
    });
  } finally {
    store.close();
  }
}

describe("katra release", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("release");
  });

  it("releases an owned claim", async () => {
    const task = await add("do the thing");
    const claimed = await runCli(["claim", task], { cwd: repo.dir });
    expect(claimed.exitCode).toBe(EXIT.ok);

    const result = await runCli(["release", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(task);
    expect(result.stdout).toContain("released");
    expect(result.stderr).toBe("");
  });

  it("refuses another worktree's claim without --force, exit 3", async () => {
    const task = await add("contested");
    claimElsewhere(task);

    const result = await runCli(["release", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.stderr).toContain("feature/other @ /elsewhere/worktree");
    expect(result.stderr).toContain("release --force");
  });

  it("force-releases another worktree's claim", async () => {
    const task = await add("contested");
    claimElsewhere(task);

    const result = await runCli(["release", task, "--force"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("feature/other @ /elsewhere/worktree");
  });

  it("exits 1 releasing an unclaimed task", async () => {
    const task = await add("never claimed");

    const result = await runCli(["release", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
  });

  it("exits 1 releasing an unclaimed task even with --force", async () => {
    // `--force` overrides the non-holder guard, not the "does a claim exist
    // at all" one — releaseTask checks for a claim before it ever looks at
    // `force`, so there is nothing for the flag to take over.
    const task = await add("never claimed");

    const result = await runCli(["release", task, "--force"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
  });

  it("emits parseable JSON with nothing on stderr", async () => {
    const task = await add("do the thing");
    await runCli(["claim", task], { cwd: repo.dir });

    const result = await runCli(["release", task, "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    const payload = result.json() as { task: { id: string }; claim: { holder: string } };
    expect(payload.task.id).toBe(task);
    expect(payload.claim.holder).not.toBe("");
  });

  it("release --mine reports each claim it released", async () => {
    const first = await add("first thing");
    const second = await add("second thing");
    await runCli(["claim", first], { cwd: repo.dir });
    await runCli(["claim", second], { cwd: repo.dir });

    const result = await runCli(["release", "--mine"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(first);
    expect(result.stdout).toContain(second);
  });

  it("release --mine exits 0 and reports nothing held when the worktree has no claims", async () => {
    await add("never claimed");

    const result = await runCli(["release", "--mine"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
  });

  it("release --mine --json lists the released claim ids", async () => {
    const task = await add("do the thing");
    await runCli(["claim", task], { cwd: repo.dir });

    const result = await runCli(["release", "--mine", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    const payload = result.json() as { released: readonly { task: { id: string } }[] };
    expect(payload.released.map((entry) => entry.task.id)).toEqual([task]);
  });

  it("release --mine with an explicit id is a usage error", async () => {
    const task = await add("do the thing");

    const result = await runCli(["release", task, "--mine"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.usage);
  });
});
