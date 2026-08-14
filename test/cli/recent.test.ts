import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { RecentResult } from "../../src/core/contract.js";
import { openStore } from "../../src/core/store.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => repo.cleanup());

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

/**
 * Backdates `taskId`'s one recorded event directly — the CLI has no way to
 * produce a timestamp in the past, and "3h ago" has to come from a real
 * `created_at`, not a stubbed clock (T4/T5's own tests take the same
 * direct-store approach for `readRecent`/`readStale`).
 */
function backdate(taskId: string, msAgo: number): void {
  const { store } = openStore(repo.dir, {});
  try {
    store.db
      .prepare("UPDATE events SET created_at = ? WHERE entity_id = ?")
      .run(new Date(Date.now() - msAgo).toISOString(), taskId);
  } finally {
    store.close();
  }
}

describe("katra recent", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("recent");
  });

  it("renders recent with relative last-activity times", async () => {
    const task = await add(["touched a while ago"]);
    backdate(task, 3 * 60 * 60 * 1000);

    const text = await runCli(["recent"], { cwd: repo.dir });

    expect(text.exitCode).toBe(EXIT.ok);
    expect(text.stdout).toContain(task);
    expect(text.stdout).toMatch(/\b3h ago\b/);

    const document = (await runCli(["recent", "--json"], { cwd: repo.dir })).json() as RecentResult;
    expect(document.hits[0]?.id).toBe(task);
    // `recent` joins activity INNER (activity.ts's docs): every hit truly has
    // one, never null.
    expect(document.hits[0]?.lastActivity).not.toBeNull();
    expect(document.truncated).toBe(false);
  });

  it("reports an empty store plainly, and truncation even when the cap empties it", async () => {
    const empty = await runCli(["recent"], { cwd: repo.dir });
    expect(empty.stdout).toMatch(/nothing has happened yet/);

    await add(["something happened"]);
    const capped = await runCli(["recent", "--limit", "0"], { cwd: repo.dir });
    expect(capped.stdout).toMatch(/raise --limit/);
    expect(capped.stdout).not.toMatch(/nothing has happened yet/);
  });
});
