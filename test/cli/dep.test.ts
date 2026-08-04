import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DepResult } from "../../src/cli/commands/dep.js";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => repo.cleanup());

async function add(title: string): Promise<string> {
  return (await runCli(["add", title], { cwd: repo.dir })).stdout.trim();
}

describe("katra dep", () => {
  it("records a dependency between two tasks given by partial id", async () => {
    const blocker = await add("the blocker");
    const blocked = await add("the blocked");

    const result = await runCli(["dep", blocked.slice(3, 6), "--blocked-by", blocker.slice(3, 6)], {
      cwd: repo.dir,
    });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(`${blocked} now depends on ${blocker}`);
  });

  it("reports what still blocks the task after the change", async () => {
    // The answer has to be actionable: knowing it is blocked is useless
    // without knowing by what.
    const first = await add("first blocker");
    const second = await add("second blocker");
    const blocked = await add("waiting");

    await runCli(["dep", blocked, "--blocked-by", first], { cwd: repo.dir });
    const result = await runCli(["dep", blocked, "--blocked-by", second], { cwd: repo.dir });

    expect(result.stdout).toContain("blocked by 2");
    expect(result.stdout).toContain("first blocker");
    expect(result.stdout).toContain("second blocker");
  });

  it("removes an existing dependency and reports the task ready", async () => {
    const blocker = await add("the blocker");
    const blocked = await add("the blocked");
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["dep", blocked, "--blocked-by", blocker, "--remove"], {
      cwd: repo.dir,
    });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("no longer depends on");
    expect(result.stdout).toContain("ready");
  });

  it("prints the cycle path and exits non-zero when the edge would close a cycle", async () => {
    const a = await add("a");
    const b = await add("b");
    await runCli(["dep", a, "--blocked-by", b], { cwd: repo.dir });

    const result = await runCli(["dep", b, "--blocked-by", a], { cwd: repo.dir });

    // A conflict, not a user error: the command is well formed and both ids
    // exist — only the graph as it currently stands refuses the edge.
    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.stderr).toMatch(/dependency cycle/);
    // The path, not merely the fact — otherwise the reader has to find it.
    expect(result.stderr).toContain(`cycle: ${b} -> ${a} -> ${b}`);
  });

  it("exits non-zero when either id is ambiguous or unknown", async () => {
    const id = await add("a task");

    const unknown = await runCli(["dep", id, "--blocked-by", "zzzz"], { cwd: repo.dir });
    expect(unknown.exitCode).toBe(EXIT.user);
    expect(unknown.stderr).toMatch(/no task matches/);
  });

  it("refuses a self-dependency", async () => {
    const id = await add("a task");

    const result = await runCli(["dep", id, "--blocked-by", id], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/cannot depend on itself/);
  });

  it("reports removing an edge that was never there", async () => {
    const a = await add("a");
    const b = await add("b");

    const result = await runCli(["dep", a, "--blocked-by", b, "--remove"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/does not depend on/);
  });

  it("requires --blocked-by rather than guessing", async () => {
    const id = await add("a task");

    const result = await runCli(["dep", id], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("emits the result as JSON with the blockers included", async () => {
    const blocker = await add("the blocker");
    const blocked = await add("the blocked");

    const result = await runCli(["dep", blocked, "--blocked-by", blocker, "--json"], {
      cwd: repo.dir,
    });

    const payload = result.json() as DepResult;
    expect(payload).toMatchObject({
      action: "added",
      taskId: blocked,
      dependsOnId: blocker,
      ready: false,
    });
    expect(payload.blockers).toHaveLength(1);
    expect(payload.blockers[0]?.title).toBe("the blocker");
  });

  it("emits a cycle failure as structured JSON carrying the path", async () => {
    const a = await add("a");
    const b = await add("b");
    await runCli(["dep", a, "--blocked-by", b], { cwd: repo.dir });

    const result = await runCli(["dep", b, "--blocked-by", a, "--json"], { cwd: repo.dir });

    const payload = result.json() as { error: { code: string; path: string[] } };
    expect(payload.error.code).toBe("cycle");
    expect(payload.error.path).toEqual([b, a, b]);
  });

  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("dep");
  });
});
