import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { LifecycleResult } from "../../src/core/tasks/lifecycle.js";
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

describe("katra close", () => {
  it("finishes a task", async () => {
    const id = await add("a task");

    const result = await runCli(["close", id, "--reason", "shipped"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(`${id} is now Done`);
    expect(result.stdout).toContain("shipped");
  });

  it("refuses to close an already-closed task with the conflict code", async () => {
    // Requirement 59, and one of the three paths that must reach exit 3.
    const id = await add("a task");
    await runCli(["close", id], { cwd: repo.dir });

    const result = await runCli(["close", id], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/already Done/);
  });
});

describe("katra cancel", () => {
  it("abandons a task and records why", async () => {
    const id = await add("a task");

    const result = await runCli(["cancel", id, "--reason", "superseded"], { cwd: repo.dir });

    expect(result.stdout).toContain(`${id} is now Cancelled`);
    expect(result.stdout).toContain("superseded");
  });

  it("reports every task the cancellation released", async () => {
    // The ADR-003 payoff: abandoning a blocker must release what it was
    // blocking, and say so, or the reader has to work it out themselves.
    const blocker = await add("the blocker");
    const first = await add("first dependent");
    const second = await add("second dependent");
    await runCli(["dep", first, "--blocked-by", blocker], { cwd: repo.dir });
    await runCli(["dep", second, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["cancel", blocker, "--reason", "not doing this"], {
      cwd: repo.dir,
    });

    expect(result.stdout).toContain("unblocked 2");
    expect(result.stdout).toContain("first dependent");
    expect(result.stdout).toContain("second dependent");
  });

  it("makes the released tasks genuinely ready afterwards", async () => {
    const blocker = await add("the blocker");
    const dependent = await add("waiting");
    await runCli(["dep", dependent, "--blocked-by", blocker], { cwd: repo.dir });

    await runCli(["cancel", blocker, "--reason", "dropped"], { cwd: repo.dir });

    const ready = await runCli(["list", "--ready", "--json"], { cwd: repo.dir });
    expect((ready.json() as { tasks: { title: string }[] }).tasks.map((t) => t.title)).toContain(
      "waiting",
    );
  });

  it("refuses to cancel a finished task with the conflict code", async () => {
    const id = await add("a task");
    await runCli(["close", id], { cwd: repo.dir });

    const result = await runCli(["cancel", id, "--reason", "too late"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
  });
});

describe("katra reopen", () => {
  it("returns a cancelled task to the Defined lane", async () => {
    const id = await add("a task");
    await runCli(["cancel", id, "--reason", "dropped"], { cwd: repo.dir });

    const result = await runCli(["reopen", id], { cwd: repo.dir });

    expect(result.stdout).toContain(`${id} is now Defined`);
  });

  it("accepts another active lane", async () => {
    const id = await add("a task");
    await runCli(["close", id], { cwd: repo.dir });

    const result = await runCli(["reopen", id, "--lane", "In Progress"], { cwd: repo.dir });

    expect(result.stdout).toContain("is now In Progress");
  });

  it("refuses --lane Done and --lane Cancelled on reopen", async () => {
    // Otherwise reopen is a second way into a terminal lane, bypassing close
    // and cancel exactly as `update --lane Done` would have.
    const id = await add("a task");
    await runCli(["close", id], { cwd: repo.dir });

    for (const lane of ["Done", "Cancelled"]) {
      const result = await runCli(["reopen", id, "--lane", lane], { cwd: repo.dir });
      expect(result.exitCode).toBe(EXIT.user);
      expect(result.stderr).toMatch(/reopen cannot move/);
    }
  });

  it("refuses to reopen a task that is already active", async () => {
    const id = await add("a task");

    const result = await runCli(["reopen", id], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.stderr).toMatch(/nothing to reopen/);
  });
});

describe("registration and json", () => {
  it("registers close, cancel and reopen on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["close", "cancel", "reopen"]));
  });

  it("emits each transition as JSON carrying what it unblocked", async () => {
    const blocker = await add("the blocker");
    const dependent = await add("waiting");
    await runCli(["dep", dependent, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["cancel", blocker, "--reason", "dropped", "--json"], {
      cwd: repo.dir,
    });

    const payload = result.json() as LifecycleResult;
    expect(payload.task.lane).toBe("Cancelled");
    expect(payload.task.closeReason).toBe("dropped");
    expect(payload.unblocked.map((t) => t.id)).toEqual([dependent]);
  });
});
