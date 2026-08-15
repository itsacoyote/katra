import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { RecentResult } from "../../src/core/contract.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";
import { backdate } from "../helpers/store.js";

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => repo.cleanup());

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

describe("katra recent", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("recent");
  });

  it("renders recent with relative last-activity times", async () => {
    const task = await add(["touched a while ago"]);
    backdate(repo.dir, task, 3 * 60 * 60 * 1000);

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

  it("renders visible rows plus the time-shaped hint when more activity exists than --limit shows", async () => {
    // QA gap: the ordinary truncated render — rows present *and* a trailing
    // hint — executed zero times in the suite. Also pins that recent's hint
    // is the chronological one, never search's rank-shaped one — the two
    // RAISE_*_LIMIT_LINE constants (format.ts) can't be swapped.
    const first = await add(["first"]);
    const second = await add(["second"]);
    await add(["third"]);

    const text = await runCli(["recent", "--limit", "2"], { cwd: repo.dir });
    expect(text.exitCode).toBe(EXIT.ok);
    const rows = text.stdout.split("\n").filter((line) => line.startsWith("kt-"));
    expect(rows).toHaveLength(2);
    // Newest first: the third task (most recent) leads, then second.
    expect(rows[1]).toContain(second);
    expect(text.stdout).toContain("see further back");
    expect(text.stdout).not.toContain("see more matches");

    const document = (
      await runCli(["recent", "--limit", "2", "--json"], { cwd: repo.dir })
    ).json() as RecentResult;
    expect(document.truncated).toBe(true);
    expect(document.hits).toHaveLength(2);
    expect(document.hits.map((hit) => hit.id)).not.toContain(first);
  });
});
