import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { TaskDetail } from "../../src/core/tasks/types.js";
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

async function detail(id: string): Promise<TaskDetail> {
  return (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
}

describe("katra update", () => {
  it("changes a task's title and lane", async () => {
    const id = await add(["before"]);

    const result = await runCli(["update", id, "--title", "after", "--lane", "Planned"], {
      cwd: repo.dir,
    });

    expect(result.exitCode).toBe(EXIT.ok);
    expect((await detail(id)).task).toMatchObject({ title: "after", lane: "Planned" });
  });

  it("refuses to set a terminal lane and points at close or cancel", async () => {
    const id = await add(["a task"]);

    const result = await runCli(["update", id, "--lane", "Done"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/katra close/);
    expect(result.stderr).toMatch(/katra cancel/);
    expect((await detail(id)).task.lane).toBe("Defined");
  });

  it("reparents onto another epic and names it in the output", async () => {
    const first = await add(["first epic", "--level", "epic"]);
    const second = await add(["second epic", "--level", "epic"]);
    const id = await add(["child", "--parent", first]);

    const result = await runCli(["update", id, "--parent", second.slice(3, 6)], { cwd: repo.dir });

    expect(result.stdout).toContain("second epic");
    const shown = await detail(id);
    expect(shown.task.id).toBe(id);
    expect(shown.task.parentId).toBe(second);
  });

  it("detaches a task from its epic", async () => {
    const epic = await add(["the epic", "--level", "epic"]);
    const id = await add(["child", "--parent", epic]);

    await runCli(["update", id, "--clear-parent"], { cwd: repo.dir });

    expect((await detail(id)).task.parentId).toBeNull();
  });

  it("clears an assignee", async () => {
    const id = await add(["a task", "--assignee", "ada"]);

    await runCli(["update", id, "--clear-assignee"], { cwd: repo.dir });

    expect((await detail(id)).task.assignee).toBeNull();
  });

  it("adds and removes tags", async () => {
    const id = await add(["a task", "--tag", "keep", "--tag", "drop"]);

    await runCli(["update", id, "--add-tag", "new", "--remove-tag", "drop"], { cwd: repo.dir });

    expect((await detail(id)).task.tags).toEqual(["keep", "new"]);
  });

  it("replaces the description from a piped body", async () => {
    const id = await add(["a task"]);

    await runCli(["update", id], { cwd: repo.dir, stdin: "a new description" });

    expect((await detail(id)).task.description).toBe("a new description");
  });

  it("emits the updated task as JSON", async () => {
    const id = await add(["a task"]);

    const result = await runCli(["update", id, "--priority", "0", "--json"], { cwd: repo.dir });

    expect((result.json() as TaskDetail).task.priority).toBe(0);
  });

  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("update");
  });
});
