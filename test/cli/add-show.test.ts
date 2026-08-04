import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import { openStore } from "../../src/core/store.js";
import type { TaskList } from "../../src/core/tasks/repo.js";
import type { Task, TaskDetail } from "../../src/core/tasks/types.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";
import { seedTask } from "../helpers/seed.js";

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => repo.cleanup());

/** Seeds two tasks whose ids share a prefix, for ambiguity tests. */
function seedAmbiguousPair(): void {
  const { store } = openStore(repo.dir, {});
  try {
    seedTask(store, { id: "kt-ab0001" });
    seedTask(store, { id: "kt-ab0002" });
  } finally {
    store.close();
  }
}

/** Adds a task and returns its id. */
async function add(args: readonly string[], stdin?: string): Promise<string> {
  const result = await runCli(["add", ...args], {
    cwd: repo.dir,
    ...(stdin === undefined ? {} : { stdin }),
  });
  expect(result.exitCode).toBe(EXIT.ok);
  return result.stdout.trim();
}

describe("katra add", () => {
  it("prints the new id and nothing else in text mode", async () => {
    const result = await runCli(["add", "wire up the parser"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    // Just the id, so the output pipes straight into another command.
    expect(result.stdout.trim()).toMatch(/^kt-[0-9a-z]{6}$/);
  });

  it("creates a task in the Defined lane by default", async () => {
    const id = await add(["a task"]);

    const shown = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(shown.task).toMatchObject({ level: "task", kind: "feat", lane: "Defined", priority: 2 });
  });

  it("creates an epic when --level epic is given", async () => {
    const id = await add(["an epic", "--level", "epic"]);

    const shown = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(shown.task.level).toBe("epic");
  });

  it("accepts every field the model has", async () => {
    const epic = await add(["parent epic", "--level", "epic"]);
    const id = await add([
      "full task",
      "--kind",
      "fix",
      "--lane",
      "Planned",
      "--priority",
      "0",
      "--assignee",
      "someone",
      "--parent",
      epic,
      "--tag",
      "urgent",
      "--tag",
      "backend",
    ]);

    const shown = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(shown.task).toMatchObject({
      kind: "fix",
      lane: "Planned",
      priority: 0,
      assignee: "someone",
      parentId: epic,
      tags: ["backend", "urgent"],
    });
  });

  it("rejects a kind outside the fixed set and names the allowed values", async () => {
    const result = await runCli(["add", "t", "--kind", "style"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/kind must be one of/);
    // The refusal has to say what would work, not merely that it failed.
    expect(result.stderr).toMatch(/feat.*fix.*chore/s);
  });

  it("rejects a lane outside the fixed set", async () => {
    const result = await runCli(["add", "t", "--lane", "Ready"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/lane must be one of/);
  });

  it("reads a description from stdin", async () => {
    const body = 'a description with "quotes", `backticks` and $VARS\nplus a second line';
    const id = await add(["piped"], body);

    const shown = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(shown.task.description).toBe(body);
  });

  it("reads a description from --body-file", async () => {
    writeFileSync(join(repo.dir, "body.md"), "from a file");

    const id = await add(["filed", "--body-file", "body.md"]);

    const shown = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(shown.task.description).toBe("from a file");
  });

  it("reads --body-file relative to the invoking directory, not the repo root", async () => {
    // The opposite rule to store resolution: the store must be identical from
    // anywhere, but a relative file path means what it would mean to any other
    // command typed in that directory.
    const nested = join(repo.dir, "deep", "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "body.md"), "found relative to cwd");
    writeFileSync(join(repo.dir, "body.md"), "found at the repo root");

    const result = await runCli(["add", "relative", "--body-file", "body.md"], { cwd: nested });
    const id = result.stdout.trim();

    const shown = (await runCli(["show", id, "--json"], { cwd: nested })).json() as TaskDetail;
    expect(shown.task.description).toBe("found relative to cwd");
  });

  it("reports a missing --body-file rather than creating a task without one", async () => {
    const result = await runCli(["add", "t", "--body-file", "absent.md"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/could not read --body-file/);

    // The claim is that nothing was written. `show kt` cannot check it — "kt"
    // is stripped as the id prefix and the remainder is below the minimum
    // length, so that call fails identically whether or not a task exists.
    const listed = (await runCli(["list", "--json"], { cwd: repo.dir })).json() as TaskList;
    expect(listed.tasks).toEqual([]);
  });

  it("refuses --lane Done with a refusal rather than a constraint dump", async () => {
    const result = await runCli(["add", "born finished", "--lane", "Done"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).not.toContain("internal error");
    expect(result.stderr).not.toContain("CHECK constraint");
    expect(result.stderr).toMatch(/katra close/);
  });

  it("refuses --parent pointing at a task, in the structured error shape", async () => {
    const notAnEpic = await add(["an ordinary task"]);

    const result = await runCli(["add", "child", "--parent", notAnEpic, "--json"], {
      cwd: repo.dir,
    });

    expect(result.exitCode).toBe(EXIT.user);
    // The trigger backing this rule can only RAISE(ABORT) with a bare string,
    // which surfaced as code "internal" — a value KatraErrorCode does not
    // contain, so a consumer switching over the union could never handle it.
    const payload = result.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("validation");
    expect(payload.error.message).toContain("not an epic");
  });

  it("accepts a parent given as a partial id", async () => {
    const epic = await add(["an epic", "--level", "epic"]);
    const id = await add(["child", "--parent", epic.slice(3, 6)]);

    const shown = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(shown.task.parentId).toBe(epic);
  });

  it("emits the created task as JSON when asked", async () => {
    const result = await runCli(["add", "jsonned", "--json"], { cwd: repo.dir });

    const task = result.json() as Task;
    expect(task.title).toBe("jsonned");
    expect(task.id).toMatch(/^kt-[0-9a-z]{6}$/);
  });
});

describe("katra show", () => {
  it("renders the task's parent and tags in text output", async () => {
    const epic = await add(["the epic", "--level", "epic"]);
    const id = await add(["the child", "--parent", epic, "--tag", "alpha", "--tag", "beta"]);

    const result = await runCli(["show", id], { cwd: repo.dir });

    expect(result.stdout).toContain("the child");
    expect(result.stdout).toContain("the epic");
    expect(result.stdout).toMatch(/tags\s+alpha, beta/);
  });

  it("resolves a partial id", async () => {
    const id = await add(["findable"]);

    const result = await runCli(["show", id.slice(3, 6)], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(id);
  });

  it("emits show output that parses as JSON with no human text mixed in", async () => {
    const id = await add(["jsonned"]);

    const result = await runCli(["show", id, "--json"], { cwd: repo.dir });

    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect((result.json() as TaskDetail).task.id).toBe(id);
  });

  it("exits non-zero when show is given an id that does not exist", async () => {
    const result = await runCli(["show", "zzzz"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/no task matches/);
  });

  it("lists every candidate when a prefix is ambiguous", async () => {
    // A refusal must say what would unblock it — here, which ids to choose from.
    // Ids are random, so two that share a prefix are seeded rather than added.
    seedAmbiguousPair();

    const result = await runCli(["show", "ab"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/matches 2 tasks/);
    expect(result.stderr).toContain("kt-ab0001");
    expect(result.stderr).toContain("kt-ab0002");
  });

  it("emits an ambiguous failure as structured JSON carrying the candidates", async () => {
    seedAmbiguousPair();

    const result = await runCli(["show", "ab", "--json"], { cwd: repo.dir });

    const payload = result.json() as { error: { code: string; candidates: string[] } };
    expect(payload.error.code).toBe("ambiguous_id");
    expect(payload.error.candidates).toEqual(["kt-ab0001", "kt-ab0002"]);
  });

  it("matches against the suffix, so a bare kt is not a wildcard", async () => {
    // The `kt-` every id carries is stripped before matching, and what remains
    // is compared against the random suffix. So "kt" means "suffix starting kt",
    // not "every task" — worth pinning, because the opposite reading is the
    // natural guess.
    seedAmbiguousPair();

    const bare = await runCli(["show", "kt"], { cwd: repo.dir });
    const real = await runCli(["show", "ab"], { cwd: repo.dir });

    expect(bare.stderr).toMatch(/no task matches/);
    expect(real.stderr).toMatch(/matches 2 tasks/);
  });

  it("refuses a prefix too short to identify anything", async () => {
    await add(["one"]);

    const result = await runCli(["show", "k"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/too short/);
  });
});

describe("command registration", () => {
  it("registers init, add and show on the program", () => {
    // No task previously owned wiring commands onto the program, so they could
    // have been written and never reachable.
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());

    expect(names).toEqual(expect.arrayContaining(["init", "add", "show"]));
  });
});

describe("warnings from a non-init command", () => {
  it("surfaces the GIT_COMMON_DIR warning from show, not only from init", async () => {
    // The dangerous case: the redirect points at a repository that DOES have a
    // store, so katra silently reads a different project's backlog and the
    // warning is the only signal anything is wrong.
    const other = createGitRepo();
    await runCli(["init"], { cwd: other.dir });
    const otherId = (
      await runCli(["add", "belongs to the other repo"], { cwd: other.dir })
    ).stdout.trim();

    const result = await runCli(["show", otherId], {
      cwd: repo.dir,
      env: { ...process.env, GIT_COMMON_DIR: join(other.dir, ".git") },
    });

    other.cleanup();
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("belongs to the other repo");
    expect(result.stderr).toMatch(/GIT_COMMON_DIR/);
  });
});
