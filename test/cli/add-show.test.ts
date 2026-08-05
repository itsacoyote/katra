import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import { openStore } from "../../src/core/store.js";
import type { TaskList } from "../../src/core/tasks/repo.js";
import type { Task, TaskDetail, TaskView } from "../../src/core/tasks/types.js";
import { SHOW_ACTIVITY_LIMIT, SHOW_NOTE_LIMIT } from "../../src/core/tasks/view.js";
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

/** Seeds a task directly, so it has no created event and no notes. */
function seedTaskWithoutHistory(): void {
  const { store } = openStore(repo.dir, {});
  try {
    seedTask(store, { id: "kt-qu1et0", title: "nothing has happened to me" });
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

  it("reads a description from stdin when asked with --body-file -", async () => {
    const body = 'a description with "quotes", `backticks` and $VARS\nplus a second line';
    const id = await add(["piped", "--body-file", "-"], body);

    const shown = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(shown.task.description).toBe(body);
  });

  it("ignores stdin that was not asked for", async () => {
    // Consuming whatever happens to be on fd 0 made every redirect a silent
    // write: `bash script.sh < data.txt` calling `katra add` would take the
    // script's input as the description. The shell's plumbing is not consent.
    const id = await add(["not piped"], "this is somebody else's stdin");

    const shown = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(shown.task.description).toBeNull();
  });

  it("treats an empty --body-file as no body, like an empty pipe", async () => {
    writeFileSync(join(repo.dir, "empty.md"), "   \n");
    const id = await add(["blank body", "--body-file", "empty.md"]);

    const shown = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(shown.task.description).toBeNull();
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

  it("names what is blocking the task and what it is blocking", async () => {
    // Found by dogfooding katra on its own backlog: `show` was the only view
    // that never mentioned dependencies, so a task blocked by two others
    // looked exactly like one that could be started.
    const blocker = await add(["must land first"]);
    const id = await add(["waits on it"]);
    const downstream = await add(["waits on me"]);
    await runCli(["dep", id, "--blocked-by", blocker], { cwd: repo.dir });
    await runCli(["dep", downstream, "--blocked-by", id], { cwd: repo.dir });

    const result = await runCli(["show", id], { cwd: repo.dir });

    expect(result.stdout).toMatch(
      new RegExp(`blockers\\s+${blocker}\\s+Defined\\s+must land first`),
    );
    expect(result.stdout).toMatch(
      new RegExp(`blocking\\s+${downstream}\\s+Defined\\s+waits on me`),
    );
  });

  it("says blockers are none rather than omitting the line", async () => {
    // A missing line reads as "this view does not know", which is precisely
    // what it used to mean.
    const id = await add(["nothing in the way"]);

    const result = await runCli(["show", id], { cwd: repo.dir });

    expect(result.stdout).toMatch(/blockers\s+none/);
  });

  it("carries blockers and blocking in the JSON document", async () => {
    const blocker = await add(["must land first"]);
    const id = await add(["waits on it"]);
    await runCli(["dep", id, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["show", id, "--json"], { cwd: repo.dir });
    const detail = result.json() as TaskDetail;

    expect(detail.blockers).toEqual([{ id: blocker, title: "must land first", lane: "Defined" }]);
    expect(detail.blocking).toEqual([]);
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

describe("katra show — notes and activity", () => {
  /** Attaches a note from stdin. */
  async function note(id: string, body: string, kind = "general"): Promise<void> {
    const result = await runCli(["note", "add", id, "--kind", kind, "--body-file", "-"], {
      cwd: repo.dir,
      stdin: body,
    });
    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
  }

  it("lists a task's notes with kind and a one-line preview", async () => {
    const id = await add(["a task"]);
    await note(id, "first line of the handoff\nsecond line never shown here", "handoff");

    const result = await runCli(["show", id], { cwd: repo.dir });

    expect(result.stdout).toMatch(/notes \(1/);
    expect(result.stdout).toContain("handoff");
    expect(result.stdout).toContain("first line of the handoff");
    // A preview is one line: the body's later lines belong to `note list`.
    expect(result.stdout).not.toContain("second line never shown here");
    // And the output says where to find them.
    expect(result.stdout).toContain("katra note list");
  });

  it("shows recent activity newest first", async () => {
    const id = await add(["a task"]);
    await runCli(["update", id, "--lane", "Planned"], { cwd: repo.dir });

    const result = await runCli(["show", id], { cwd: repo.dir });
    const activity = result.stdout.slice(result.stdout.indexOf("activity ("));

    expect(activity).toContain("status-changed");
    expect(activity).toContain("created");
    expect(activity.indexOf("status-changed")).toBeLessThan(activity.indexOf("created"));
    expect(result.stdout).toContain("katra log");
  });

  it("caps both sections regardless of how much history exists", async () => {
    const id = await add(["a busy task"]);
    for (let i = 0; i < 12; i++) await note(id, `note ${i}`);

    const view = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskView;

    // 12 notes written and 13 events, but both sections stay at their fixed
    // internal caps: `show` is a summary, not a dump.
    expect(view.notes).toHaveLength(SHOW_NOTE_LIMIT);
    expect(view.activity).toHaveLength(SHOW_ACTIVITY_LIMIT);

    const listed = (await runCli(["note", "list", id, "--json"], { cwd: repo.dir })).json() as {
      notes: unknown[];
    };
    expect(listed.notes).toHaveLength(12);
  });

  it("keeps the newest notes when it caps, not the oldest", async () => {
    const id = await add(["a task"]);
    for (let i = 0; i < SHOW_NOTE_LIMIT + 3; i++) await note(id, `note ${i}`);

    const view = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskView;

    expect(view.notes[0]?.body).toBe(`note ${SHOW_NOTE_LIMIT + 2}`);
  });

  it("strips control characters from a note preview", async () => {
    // Notes are where fetched content and model output get pasted, and F3's
    // brief will hand handoff notes to other agents as their first context. A
    // raw escape executes on whatever renders it.
    const id = await add(["a task"]);
    await note(id, "\u001B[31mred and \u001B[2Jcleared");

    const result = await runCli(["show", id], { cwd: repo.dir });

    expect(result.stdout).not.toContain("\u001B");
    expect(result.stdout).toContain("[31mred");
  });

  it("strips control characters from a note body in note list too", async () => {
    // The same property one command over: `note list` prints whole bodies, so
    // it is the larger surface. Newlines and tabs survive, so pasted code
    // still reads correctly — that was the whole objection to sanitising.
    const id = await add(["a task"]);
    await note(id, "line one\n\tindented \u001B[31mred\u001B[0m\nline three");

    const result = await runCli(["note", "list", id], { cwd: repo.dir });

    expect(result.stdout).not.toContain("\u001B");
    expect(result.stdout).toContain("line one");
    expect(result.stdout).toContain("line three");
    expect(result.stdout).toContain("\tindented");
  });

  it("keeps the body verbatim under --json", async () => {
    // `--json` is the programmatic path: its consumer is not a terminal, and a
    // value altered on the way out is no longer what was stored.
    const id = await add(["a task"]);
    const body = "\u001B[31mred\nsecond line";
    await note(id, body);

    const view = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskView;

    expect(view.notes[0]?.body).toBe(body);
  });

  it("omits both sections for a task with neither", async () => {
    // An empty heading is a line saying nothing happened, which the absence
    // already says. Seeded rather than added, because `add` writes a created
    // event and there would be activity to show.
    seedTaskWithoutHistory();

    const result = await runCli(["show", "kt-qu1et0"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).not.toContain("notes (");
    expect(result.stdout).not.toContain("activity (");
  });

  it("carries notes and activity in the JSON document", async () => {
    const id = await add(["a task"]);
    await note(id, "a note", "decision");

    const view = (await runCli(["show", id, "--json"], { cwd: repo.dir })).json() as TaskView;

    expect(view.notes[0]).toMatchObject({ kind: "decision", body: "a note" });
    expect(view.activity.map((e) => e.type)).toEqual(["note-added", "created"]);
  });
});

describe("show on an epic", () => {
  it("names which child each activity row is about", async () => {
    // An epic's view carries its children's events, so three bare `created`
    // rows — one of them the epic's own — were indistinguishable from each
    // other. formatEventLog already carries the id and title for this reason.
    const epic = await add(["an epic", "--level", "epic"]);
    const one = await add(["first child", "--parent", epic]);
    await add(["second child", "--parent", epic]);
    await runCli(["update", one, "--lane", "Planned"], { cwd: repo.dir });

    const result = await runCli(["show", epic], { cwd: repo.dir });
    const activity = result.stdout.slice(result.stdout.indexOf("activity ("));

    expect(activity).toContain("first child");
    expect(activity).toContain("second child");
    expect(activity).toContain(one);
  });

  it("leaves the task's own rows unattributed, since they need no naming", async () => {
    // The subject column disambiguates; repeating the task you asked about on
    // every one of its own rows is the noise the log already elides.
    const id = await add(["a plain task"]);
    await runCli(["update", id, "--lane", "Planned"], { cwd: repo.dir });

    const result = await runCli(["show", id], { cwd: repo.dir });
    const activity = result.stdout.slice(result.stdout.indexOf("activity ("));

    expect(activity).not.toContain("a plain task");
    expect(activity).not.toContain(id);
    expect(activity).toContain("status-changed");
  });
});
