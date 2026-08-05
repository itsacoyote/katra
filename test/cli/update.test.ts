import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { TaskList, UpdateResult } from "../../src/core/contract.js";
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
    // The task starts *with* a description. Created without one it was null,
    // so an implementation that appended rather than replaced would satisfy
    // the assertion below just as well — "replaces" was untested.
    const id = await add(["a task"]);
    await runCli(["update", id, "--body-file", "-"], {
      cwd: repo.dir,
      stdin: "the original description",
    });

    await runCli(["update", id, "--body-file", "-"], {
      cwd: repo.dir,
      stdin: "a new description",
    });

    expect((await detail(id)).task.description).toBe("a new description");
  });

  it("leaves the description alone when stdin was not asked for", async () => {
    // The reason bare stdin is no longer consulted: `katra update <id>
    // --priority 0` inside a script with redirected input silently replaced
    // the description with the script's data, with no undo until snapshots.
    const id = await add(["a task"]);
    await runCli(["update", id, "--body-file", "-"], { cwd: repo.dir, stdin: "the real body" });

    await runCli(["update", id, "--priority", "0"], { cwd: repo.dir, stdin: "unrelated input" });

    const after = await detail(id);
    expect(after.task.description).toBe("the real body");
    expect(after.task.priority).toBe(0);
  });

  it("emits the updated task as JSON", async () => {
    const id = await add(["a task"]);

    const result = await runCli(["update", id, "--priority", "0", "--json"], { cwd: repo.dir });

    const document = result.json() as UpdateResult;
    expect(document.tasks).toHaveLength(1);
    expect(document.tasks[0]?.task.priority).toBe(0);
  });

  it("emits the same JSON shape whatever the number of ids", async () => {
    // The point of the envelope. A script passing a variable-length list must
    // not get a different document depending on how many ids it happened to
    // have — which is exactly what returning a bare TaskDetail for one and an
    // array for many would do.
    const one = await add(["one"]);
    const two = await add(["two"]);

    const single = await runCli(["update", one, "--priority", "0", "--json"], { cwd: repo.dir });
    const many = await runCli(["update", one, two, "--priority", "1", "--json"], {
      cwd: repo.dir,
    });

    expect(Object.keys(single.json() as object)).toEqual(Object.keys(many.json() as object));
    expect((many.json() as UpdateResult).tasks).toHaveLength(2);
  });

  it("updates several tasks in one invocation", async () => {
    const one = await add(["one"]);
    const two = await add(["two"]);
    const three = await add(["three"]);

    const result = await runCli(["update", one, two, three, "--lane", "Planned"], {
      cwd: repo.dir,
    });

    expect(result.exitCode).toBe(EXIT.ok);
    // A compact line each, not three field blocks.
    expect(result.stdout).toMatch(/updated 3 tasks/);
    expect(result.stdout.trim().split("\n")).toHaveLength(4);

    const listed = (
      await runCli(["list", "--lane", "Planned", "--json"], { cwd: repo.dir })
    ).json() as TaskList;
    expect(listed.tasks).toHaveLength(3);
  });

  it("still prints the full detail for a single task", async () => {
    const id = await add(["alone"]);

    const result = await runCli(["update", id, "--priority", "0"], { cwd: repo.dir });

    expect(result.stdout).toMatch(/priority\s+P0/);
    expect(result.stdout).not.toMatch(/updated 1 task/);
  });

  it("writes none of a batch when one id in it is refused", async () => {
    // All-or-nothing. A partially applied bulk edit is the worst outcome: the
    // caller is told it failed while half the change survives, with no way to
    // tell which half.
    const one = await add(["one"]);
    const two = await add(["two"]);
    await runCli(["close", two], { cwd: repo.dir });

    const result = await runCli(["update", one, two, "--lane", "Planned"], { cwd: repo.dir });

    // A closed task refusing a lane change is a conflict, not a usage error.
    expect(result.exitCode).toBe(EXIT.conflict);
    const listed = (
      await runCli(["list", "--lane", "Planned", "--json"], { cwd: repo.dir })
    ).json() as TaskList;
    expect(listed.tasks).toEqual([]);
  });

  it("writes none of a batch when one id matches nothing", async () => {
    const one = await add(["one"]);

    const result = await runCli(["update", one, "kt-zzzzzz", "--priority", "0"], {
      cwd: repo.dir,
    });

    expect(result.exitCode).toBe(EXIT.user);
    const listed = (
      await runCli(["list", "--priority", "0", "--json"], { cwd: repo.dir })
    ).json() as TaskList;
    expect(listed.tasks).toEqual([]);
  });

  it("patches a task named twice only once", async () => {
    const id = await add(["repeated"]);

    const result = await runCli(["update", id, id, "--lane", "Planned", "--json"], {
      cwd: repo.dir,
    });

    expect((result.json() as UpdateResult).tasks).toHaveLength(1);
  });

  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("update");
  });
});
