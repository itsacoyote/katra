import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram, wantsJson } from "../../src/cli/program.js";
import type { NoteList } from "../../src/core/contract.js";
import type { Note } from "../../src/core/notes/types.js";
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

/** Attaches a note from stdin and returns it. */
async function note(id: string, body: string, extra: readonly string[] = []): Promise<Note> {
  const result = await runCli(["note", "add", id, "--body-file", "-", ...extra, "--json"], {
    cwd: repo.dir,
    stdin: body,
  });
  expect(result.exitCode, result.stderr).toBe(EXIT.ok);
  return result.json() as Note;
}

describe("katra note add", () => {
  it("writes a note and its note-added event in one transaction", async () => {
    const task = await add(["a task"]);

    const written = await note(task, "the handoff");

    expect(written.id).toMatch(/^nt-[0-9a-z]{6}$/);
    expect(written.body).toBe("the handoff");
    expect(written.taskId).toBe(task);

    const log = (await runCli(["log", task, "--json"], { cwd: repo.dir })).json() as {
      events: Array<{ type: string; ref: string | null }>;
    };
    expect(log.events[0]?.type).toBe("note-added");
  });

  it("sets the event ref to the note id", async () => {
    const task = await add(["a task"]);

    const written = await note(task, "body");

    const log = (await runCli(["log", task, "--json"], { cwd: repo.dir })).json() as {
      events: Array<{ type: string; ref: string | null }>;
    };
    expect(log.events.find((e) => e.type === "note-added")?.ref).toBe(written.id);
  });

  it("reads a body from stdin on --body-file -", async () => {
    // A note is prose: quotes, backticks and newlines are content, not shell
    // syntax to fight. That is why there is no inline body argument.
    const task = await add(["a task"]);
    const body = 'a "quoted" line\nwith `backticks` and $VARS\n\n  indented code';

    expect((await note(task, body)).body).toBe(body);
  });

  it("reads a body from a file", async () => {
    const task = await add(["a task"]);
    writeFileSync(join(repo.dir, "handoff.md"), "from a file");

    const result = await runCli(["note", "add", task, "--body-file", "handoff.md", "--json"], {
      cwd: repo.dir,
    });

    expect((result.json() as Note).body).toBe("from a file");
  });

  it("ignores stdin that was not asked for", async () => {
    // The F1 rule: the shell's plumbing is not consent. Here it would attach a
    // note nobody wrote rather than merely overwrite a description.
    const task = await add(["a task"]);

    const result = await runCli(["note", "add", task], {
      cwd: repo.dir,
      stdin: "somebody else's stdin",
    });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/a note needs a body/);
  });

  it("refuses a note with no body at all", async () => {
    const task = await add(["a task"]);

    const result = await runCli(["note", "add", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/a note needs a body/);
  });

  it("refuses a blank body from a file", async () => {
    const task = await add(["a task"]);
    writeFileSync(join(repo.dir, "blank.md"), "   \n\n");

    const result = await runCli(["note", "add", task, "--body-file", "blank.md"], {
      cwd: repo.dir,
    });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/a note needs a body/);
  });

  it("records the kind it was given", async () => {
    const task = await add(["a task"]);

    expect((await note(task, "b", ["--kind", "handoff"])).kind).toBe("handoff");
  });

  it("refuses an unknown kind, naming all four", async () => {
    const task = await add(["a task"]);

    const result = await runCli(["note", "add", task, "--kind", "summary", "--body-file", "-"], {
      cwd: repo.dir,
      stdin: "b",
    });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/note kind must be one of/);
    expect(result.stderr).toMatch(/general.*handoff.*decision.*acceptance/s);
  });

  it("refuses a task kind, which is a different set entirely", async () => {
    const task = await add(["a task"]);

    const result = await runCli(["note", "add", task, "--kind", "feat", "--body-file", "-"], {
      cwd: repo.dir,
      stdin: "b",
    });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/note kind must be one of/);
  });

  it("refuses a note on a task that does not exist, naming how to create one", async () => {
    const result = await runCli(["note", "add", "kt-zzzzzz", "--body-file", "-"], {
      cwd: repo.dir,
      stdin: "orphan",
    });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/katra add/);
  });

  it("treats a missing --kind value as a refusal, not a JSON request", async () => {
    // The whole reason gap.15 exists. `--kind` is declared on the *subcommand*,
    // so a parent-only lookup reports it as not-value-taking and reads the
    // following `--json` as a real request — answering a malformed invocation
    // with a JSON document.
    //
    // The exit code is 1, not 2: commander parses this correctly, taking
    // `--json` as `--kind`'s value, and it is katra's own narrower that
    // refuses it. That is the better outcome — the message names all four
    // kinds and quotes what it actually received.
    const task = await add(["a task"]);

    const result = await runCli(["note", "add", task, "--kind", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    // The load-bearing half: prose on stderr and an empty stdout, because this
    // invocation never asked for JSON. Without the descent, the refusal comes
    // back as a JSON document on stdout instead.
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/note kind must be one of/);
    expect(result.stderr).toContain('"--json"');
    expect(() => JSON.parse(result.stderr)).toThrow();
  });

  it("still honours a genuine --json on a subcommand", async () => {
    // The guard on the guard: the assertion above would also pass if `--json`
    // stopped working on `note add` entirely.
    const task = await add(["a task"]);

    const result = await runCli(["note", "add", task, "--kind", "handoff", "--body-file", "-"], {
      cwd: repo.dir,
      stdin: "b",
    });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(wantsJson(["note", "add", task, "--kind", "handoff", "--json"], createProgram())).toBe(
      true,
    );
  });

  it("resolves a partial task id", async () => {
    const task = await add(["a task"]);

    expect((await note(task.slice(3, 6), "b")).taskId).toBe(task);
  });
});

describe("katra note list", () => {
  it("lists a task's notes newest first, filtered by kind", async () => {
    const task = await add(["a task"]);
    await note(task, "first", ["--kind", "decision"]);
    await note(task, "second", ["--kind", "handoff"]);
    await note(task, "third", ["--kind", "handoff"]);

    const all = (
      await runCli(["note", "list", task, "--json"], { cwd: repo.dir })
    ).json() as NoteList;
    expect(all.notes.map((n) => n.body)).toEqual(["third", "second", "first"]);

    const handoffs = (
      await runCli(["note", "list", task, "--kind", "handoff", "--json"], { cwd: repo.dir })
    ).json() as NoteList;
    expect(handoffs.notes.map((n) => n.body)).toEqual(["third", "second"]);
  });

  it("reads every note in the store when given no id", async () => {
    const one = await add(["one"]);
    const two = await add(["two"]);
    await note(one, "mine");
    await note(two, "theirs");

    const all = (await runCli(["note", "list", "--json"], { cwd: repo.dir })).json() as NoteList;

    expect(all.notes).toHaveLength(2);
  });

  it("prints each note's body rather than truncating it to a row", async () => {
    // The reason `note list` is not a one-line-per-item listing like `list` and
    // `log`: a note's body is the reason to read it.
    const task = await add(["a task"]);
    await note(task, "line one\nline two");

    const result = await runCli(["note", "list", task], { cwd: repo.dir });

    expect(result.stdout).toContain("line one");
    expect(result.stdout).toContain("line two");
  });

  it("bounds the result with --limit", async () => {
    const task = await add(["a task"]);
    await note(task, "one");
    await note(task, "two");
    await note(task, "three");

    const bounded = (
      await runCli(["note", "list", task, "--limit", "2", "--json"], { cwd: repo.dir })
    ).json() as NoteList;

    expect(bounded.notes).toHaveLength(2);
  });

  it("says there are no notes rather than printing nothing", async () => {
    const task = await add(["a task"]);

    const result = await runCli(["note", "list", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout.trim()).toBe("no notes");
  });

  it("refuses an id that matches no task rather than reporting no notes", async () => {
    // An empty list would read as "this task has nothing", which is a
    // different answer from "there is no such task".
    const result = await runCli(["note", "list", "kt-zzzzzz"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/no task matches/);
  });

  it("emits parseable JSON with nothing on stderr", async () => {
    const task = await add(["a task"]);
    await note(task, "b");

    const result = await runCli(["note", "list", task, "--json"], { cwd: repo.dir });

    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toBe("");
  });
});

describe("note command registration", () => {
  it("registers both note commands on the program", async () => {
    // Real subcommands, not two flat commands named with a space. Verified
    // against commander 15: `.command("note add")` makes a command called
    // "note" with a positional argument "add", and registering
    // `.command("note list")` beside it throws — which would have made every
    // katra invocation exit 4, since createProgram runs on all of them.
    const program = createProgram({ cwd: repo.dir });
    const parent = program.commands.find((command) => command.name() === "note");

    expect(parent).toBeDefined();
    expect(parent?.commands.map((command) => command.name()).sort()).toEqual(["add", "list"]);
  });

  it("gives the note subcommands their own descriptions and --json", async () => {
    const program = createProgram({ cwd: repo.dir });
    const parent = program.commands.find((command) => command.name() === "note");

    for (const child of parent?.commands ?? []) {
      expect(child.description(), `note ${child.name()} has no description`).not.toBe("");
      expect(
        child.options.map((option) => option.long),
        `note ${child.name()} has no --json`,
      ).toContain("--json");
    }
  });

  it("builds the program without throwing, on every invocation", async () => {
    // The failure mode the flat form would have had: not a broken `note`, but
    // a broken katra.
    expect(() => createProgram({ cwd: repo.dir })).not.toThrow();
    const result = await runCli(["list"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.ok);
  });
});

describe("note list refuses bad flag values", () => {
  it("refuses a --limit that is not a whole count", async () => {
    // The validators are unit-tested and the same wiring is CLI-tested for
    // `log --limit` and `note add --kind`, but nothing drove these two
    // one-line pass-throughs through the actual command.
    const task = await add(["a task"]);

    const result = await runCli(["note", "list", task, "--limit", "lots"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/whole number of items/);
  });

  it("refuses a --kind outside the four, naming them", async () => {
    const task = await add(["a task"]);

    const result = await runCli(["note", "list", task, "--kind", "summary"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/note kind must be one of/);
    expect(result.stderr).toMatch(/general.*handoff.*decision.*acceptance/s);
  });

  it("refuses a --limit past the ceiling rather than failing as internal", async () => {
    // 1e21 satisfies Number.isInteger, and better-sqlite3 then refuses to bind
    // it — which used to surface as exit 4, telling an agent to escalate a
    // broken machine over a typo.
    const task = await add(["a task"]);

    const result = await runCli(["note", "list", task, "--limit", "1e21"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.exitCode).not.toBe(EXIT.internal);
  });
});
