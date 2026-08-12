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
 * bypass `test/cli/next.test.ts` uses, since seeding through the real `katra
 * claim` would just claim it for the fixture's own identity.
 */
function claimElsewhere(id: string, actor?: string): void {
  const { store } = openStore(repo.dir, {});
  try {
    seedClaim(store, {
      taskId: id,
      holder: "/elsewhere/worktree",
      ...(actor === undefined ? {} : { actor }),
    });
  } finally {
    store.close();
  }
}

describe("katra claim", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("claim");
  });

  it("claims a task and echoes the claim", async () => {
    const task = await add("do the thing");

    const result = await runCli(["claim", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(task);
    expect(result.stdout).toContain("claimed by");
    expect(result.stderr).toBe("");
  });

  it("exits 3 naming the holder when the task is already claimed", async () => {
    const task = await add("contested");
    claimElsewhere(task, "feature/other @ /elsewhere/worktree");

    const result = await runCli(["claim", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.stderr).toContain("feature/other @ /elsewhere/worktree");
  });

  it("names release --force as the unblock in the refusal hint", async () => {
    const task = await add("contested");
    claimElsewhere(task);

    const result = await runCli(["claim", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.stderr).toContain("release --force");
  });

  it("re-claiming your own task succeeds quietly", async () => {
    const task = await add("do the thing");
    const first = await runCli(["claim", task], { cwd: repo.dir });
    expect(first.exitCode).toBe(EXIT.ok);

    const second = await runCli(["claim", task], { cwd: repo.dir });

    expect(second.exitCode).toBe(EXIT.ok);
    expect(second.stderr).toBe("");
    expect(second.stdout).toContain(task);
  });

  it("refuses claiming an epic, exit 1", async () => {
    const epic = (
      await runCli(["add", "an epic", "--level", "epic"], { cwd: repo.dir })
    ).stdout.trim();

    const result = await runCli(["claim", epic], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
  });

  it("emits parseable JSON with nothing on stderr", async () => {
    const task = await add("do the thing");

    const result = await runCli(["claim", task, "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    const payload = result.json() as { task: { id: string }; claim: { holder: string } };
    expect(payload.task.id).toBe(task);
    expect(payload.claim.holder).not.toBe("");
  });

  it("emits a conflict as structured JSON with nothing on stdout", async () => {
    const task = await add("contested");
    claimElsewhere(task);

    const result = await runCli(["claim", task, "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
    const payload = result.json() as { error: { code: string } };
    expect(payload.error.code).toBe("conflict");
  });
});

describe("claim and a hostile stored actor", () => {
  // Built by codepoint, per `test/cli/board.test.ts`'s convention — an
  // invisible literal in test source is unreviewable.
  const ESC = String.fromCharCode(0x1b);

  it("keeps stderr to one line with no ESC when the holder's stored actor is hostile", async () => {
    // A real second worktree, so the holder path is genuine — but the *actor*
    // string is what katra actually renders, and nothing about a worktree
    // path constrains it: `claims.actor` is free text (T1's schema puts no
    // CHECK on its shape), so a corrupted or tampered row can carry anything.
    // This is the exact vector the security-scan finding on `emitError`
    // covers — see `cli/output.ts`.
    const worktreeB = repo.addWorktree("feature/hostile");
    const task = await add("contested");
    const hostileActor = `feature/hostile ${ESC}[31mHACKED${ESC}[0m\nsecond line @ ${worktreeB}`;

    const { store } = openStore(repo.dir, {});
    try {
      seedClaim(store, { taskId: task, holder: worktreeB, actor: hostileActor });
    } finally {
      store.close();
    }

    const result = await runCli(["claim", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.stderr).not.toContain(ESC);
    // Exactly one non-empty line: the sanitized refusal, nothing split across
    // a second physical line by the embedded newline.
    const lines = result.stderr.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
  });
});
