import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { StaleResult } from "../../src/core/contract.js";
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

/** Backdates `taskId`'s one recorded event directly — see recent.test.ts's twin helper. */
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

const DAY_MS = 24 * 60 * 60 * 1000;

describe("katra stale", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("stale");
  });

  it("applies stale's two-week default and names the window", async () => {
    const forgotten = await add(["forgotten a while back"]);
    backdate(forgotten, 15 * DAY_MS);
    const fresh = await add(["touched recently"]);

    const text = await runCli(["stale"], { cwd: repo.dir });

    expect(text.exitCode).toBe(EXIT.ok);
    expect(text.stdout).toContain(forgotten);
    expect(text.stdout).not.toContain(fresh);
    // The window is named even though --older-than was never passed.
    expect(text.stdout).toMatch(/untouched since before/);

    const document = (await runCli(["stale", "--json"], { cwd: repo.dir })).json() as StaleResult;
    expect(document.hits.map((hit) => hit.id)).toEqual([forgotten]);
    // The default resolved to an actual cutoff timestamp, roughly two weeks
    // back — not the literal string "2w".
    expect(document.olderThan).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const age = Date.now() - Date.parse(document.olderThan);
    expect(age).toBeGreaterThan(13 * DAY_MS);
    expect(age).toBeLessThan(15 * DAY_MS);
  });

  it("says so explicitly, and still names the window, when nothing is stale", async () => {
    await add(["fresh"]);

    const text = await runCli(["stale"], { cwd: repo.dir });

    expect(text.exitCode).toBe(EXIT.ok);
    expect(text.stdout).toMatch(/untouched since before/);
    expect(text.stdout).toMatch(/nothing is stale/);
  });
});
