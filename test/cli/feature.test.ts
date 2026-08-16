/**
 * The whole-feature gates.
 *
 * Every other test file checks one command. These check properties that only
 * exist across the finished command set — which is why they land last, and why
 * they iterate the program rather than a hand-written list: a list would drift
 * silently the moment a command is added.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram, wantsJson } from "../../src/cli/program.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo, git } from "../helpers/fixture.js";

/** The database file, for tests that need to break it on purpose. */
function storeDbPath(dir: string): string {
  return join(dir, ".git", STORE_DIR_NAME, DB_FILE_NAME);
}

/** Every command katra ships. */
const EXPECTED_COMMANDS = [
  "init",
  "add",
  "show",
  "list",
  "update",
  "close",
  "cancel",
  "reopen",
  "delete",
  "dep",
  "link",
  "ref",
  "next",
  "log",
  "note",
  "brief",
  "board",
  "claim",
  "release",
  "migrate",
  "search",
  "recent",
  "stale",
] as const;

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => repo.cleanup());

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

describe("command registration", () => {
  it("registers all twenty-three commands on the program", () => {
    // Iterating the program rather than asserting against a hand-written list
    // is the point: a command built and never wired up would pass any test
    // that only checked the list.
    const registered = createProgram({ cwd: repo.dir })
      .commands.map((command) => command.name())
      .sort();

    expect(registered).toEqual([...EXPECTED_COMMANDS].sort());
    expect(registered).toHaveLength(23);
  });

  it("gives every command a description and a --json flag where it returns data", () => {
    // Walked recursively, so a subcommand cannot escape the contract by being
    // one level down. A command that *has* subcommands is a namespace — it
    // returns no data of its own and needs no --json, but it still has to say
    // what it is for.
    const check = (command: Command): void => {
      expect(command.description(), `${command.name()} has no description`).not.toBe("");
      if (command.commands.length > 0) {
        for (const child of command.commands) check(child);
        return;
      }
      const flags = command.options.map((option) => option.long);
      expect(flags, `${command.name()} has no --json`).toContain("--json");
    };

    for (const command of createProgram({ cwd: repo.dir }).commands) check(command);
  });
});

describe("--json across every command", () => {
  it("emits parseable JSON with no prose from every command that returns data", async () => {
    // Acceptance criterion 35. Each invocation is a real one against real
    // state, so this also proves every command still runs end to end.
    const epic = await add(["an epic", "--level", "epic"]);
    const blocker = await add(["a blocker", "--parent", epic]);
    const dependent = await add(["a dependent", "--parent", epic]);
    const doomed = await add(["to be deleted"]);
    const linked = await add(["to be linked"]);

    // A minimal, valid bd export so `migrate beads` (preview) below is a real
    // end-to-end invocation like every other entry in this list, not one that
    // only proves the not_found path.
    mkdirSync(join(repo.dir, ".beads"), { recursive: true });
    writeFileSync(
      join(repo.dir, ".beads", "issues.jsonl"),
      `${JSON.stringify({
        _type: "issue",
        id: "bd-1",
        title: "an imported issue",
        description: "",
        status: "open",
        priority: 2,
        issue_type: "task",
        owner: "",
        created_at: "2026-01-01T00:00:00.000Z",
        created_by: "",
        updated_at: "2026-01-01T00:00:00.000Z",
        dependency_count: 0,
        dependent_count: 0,
        comment_count: 0,
      })}\n`,
    );

    const invocations: Array<readonly string[]> = [
      ["init"],
      ["add", "another task"],
      ["show", blocker],
      ["claim", blocker],
      ["release", blocker],
      ["list"],
      ["update", blocker, "--priority", "1"],
      ["dep", dependent, "--blocked-by", blocker],
      ["link", linked, doomed],
      ["ref", "add", blocker, "https://github.com/acme/widgets/pull/7"],
      ["close", blocker],
      ["reopen", blocker],
      ["cancel", blocker, "--reason", "dropped"],
      ["delete", doomed, "--force"],
      ["next"],
      // Deliberately after `delete`: the history of the task just removed is
      // the read only the event stream can answer.
      ["log", doomed],
      ["note", "list"],
      ["brief", epic],
      ["board", "--digest"],
      ["migrate", "beads"],
      ["search", "another"],
      ["recent"],
      ["stale"],
    ];

    const seen = new Set<string>();
    for (const args of invocations) {
      const result = await runCli([...args, "--json"], { cwd: repo.dir });
      seen.add(args[0] as string);

      expect(() => JSON.parse(result.stdout), `${args.join(" ")} emitted non-JSON`).not.toThrow();
      expect(result.stderr, `${args.join(" ")} wrote to stderr under --json`).toBe("");
    }

    expect([...seen].sort()).toEqual([...EXPECTED_COMMANDS].sort());
  });
});

describe("exit codes", () => {
  it("produces each of the four exit codes on a real path", async () => {
    // Acceptance criterion 29. Only here are all four reachable, because they
    // need commands from several different tasks.
    const id = await add(["a task"]);

    // 0 — success.
    expect((await runCli(["show", id], { cwd: repo.dir })).exitCode).toBe(EXIT.ok);

    // 1 — user error: the request is understood and refused.
    expect((await runCli(["show", "zzzz"], { cwd: repo.dir })).exitCode).toBe(EXIT.user);

    // 2 — usage: the invocation itself is malformed.
    expect((await runCli(["show", id, "--nonsense"], { cwd: repo.dir })).exitCode).toBe(EXIT.usage);

    // 3 — conflict: well-formed, but the current state refuses it.
    await runCli(["close", id], { cwd: repo.dir });
    expect((await runCli(["close", id], { cwd: repo.dir })).exitCode).toBe(EXIT.conflict);
  });

  it("reaches the conflict code by all three routes the spec names", async () => {
    const epic = await add(["an epic", "--level", "epic"]);
    await add(["child", "--parent", epic]);
    const a = await add(["a"]);
    const b = await add(["b"]);
    const closed = await add(["closed"]);

    // Deleting an epic that still has children.
    expect((await runCli(["delete", epic, "--force"], { cwd: repo.dir })).exitCode).toBe(
      EXIT.conflict,
    );

    // Closing an already-closed task.
    await runCli(["close", closed], { cwd: repo.dir });
    expect((await runCli(["close", closed], { cwd: repo.dir })).exitCode).toBe(EXIT.conflict);

    // Adding a dependency that would close a cycle. Both ids exist and the
    // command is well formed; only the current shape of the graph refuses it,
    // and removing the opposing edge makes the identical command succeed.
    await runCli(["dep", a, "--blocked-by", b], { cwd: repo.dir });
    expect((await runCli(["dep", b, "--blocked-by", a], { cwd: repo.dir })).exitCode).toBe(
      EXIT.conflict,
    );
  });

  it("uses a distinct code for a genuine fault, not the user-error code", async () => {
    // Requirement 49 defines 1 as "the request was understood and refused".
    // A broken store is not that, and an agent branching on the exit code has
    // to be able to tell "do not retry" from "escalate" (ADR-005).
    const id = await add(["a task"]);
    chmodSync(storeDbPath(repo.dir), 0o444);

    const result = await runCli(["update", id, "--priority", "0"], { cwd: repo.dir });

    chmodSync(storeDbPath(repo.dir), 0o644);
    expect(result.exitCode).toBe(EXIT.internal);
    expect(result.exitCode).not.toBe(EXIT.user);
    expect(result.stderr).toMatch(/internal error/);
  });

  it("reports a fault under --json in the same envelope as a refusal", async () => {
    const id = await add(["a task"]);
    chmodSync(storeDbPath(repo.dir), 0o444);

    const result = await runCli(["update", id, "--priority", "0", "--json"], { cwd: repo.dir });

    chmodSync(storeDbPath(repo.dir), 0o644);
    const payload = result.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("internal");
    expect(result.exitCode).toBe(EXIT.internal);
  });

  it("emits a structured usage document under --json rather than an empty stdout", async () => {
    // Commander owns argument parsing and writes prose. Under --json that
    // prose must not reach either stream, and the failure still has to be
    // readable — an exit code with nothing on stdout is not.
    const result = await runCli(["add", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toBe("");
    const payload = result.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("usage");
    expect(payload.error.message).toMatch(/title/);
  });
});

describe("--json is parsed, not string-matched", () => {
  it("still honours --json after a flag the command does not define", async () => {
    // The bug a flat VALUE_TAKING_FLAGS set caused. `--tag` is a real katra
    // flag — on `add`, not on `update` — so a global set treated `--json` as
    // its value and dropped the JSON contract for a caller who did ask. Twelve
    // commands share fourteen value-taking flags, and only 31 of those 168
    // pairs exist, so 137 argv shapes were affected.
    const id = await add(["a task"]);

    const result = await runCli(["update", id, "--tag", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toBe("");
    const payload = result.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("usage");
    expect(payload.error.message).toMatch(/--tag/);
  });

  it("does not switch to JSON when --json is an option's value", async () => {
    // `argv.includes("--json")` was true here, so a caller who never asked for
    // JSON got a JSON error document on stdout and an empty stderr.
    const result = await runCli(["add", "t", "--assignee", "--json", "--nope"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/unknown option/);
  });

  it("ignores --json after a bare double dash", async () => {
    // Observed on a *failing* invocation, because that is the only place
    // wantsJson's answer is visible. Asserting that `add -- --json` creates a
    // task only observes commander's own `--` handling: deleting the
    // terminator logic from wantsJson left that version passing.
    const result = await runCli(["show", "--", "--json"], { cwd: repo.dir });

    expect(result.exitCode).not.toBe(EXIT.ok);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  it("emits the version under its own key, not the help key", async () => {
    // `--version --json` used to print {"help": "0.0.0"} — the version filed
    // under the wrong name, and indistinguishable in shape from a help screen.
    const result = await runCli(["--version", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json() as { version?: string; help?: string };
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(payload.help).toBeUndefined();
  });

  it("keeps stdout parseable for --help", async () => {
    // Prose on stdout with exit 0 is worse than a usage error: an agent that
    // always passes --json gets unparseable output *and* a success code.
    const result = await runCli(["--help", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json() as { help: string };
    expect(payload.help).toMatch(/Usage: katra/);
    expect(result.stderr).toBe("");
  });
});

describe("invocation directory", () => {
  it("produces identical results from the root, a subdirectory and a linked worktree", async () => {
    // Acceptance criterion 36. Verified through the CLI rather than only at
    // the resolution function: the failure mode is a command that resolves cwd
    // independently, which a unit test of the resolver cannot see.
    const nested = join(repo.dir, "src", "core");
    mkdirSync(nested, { recursive: true });
    const worktree = repo.addWorktree("feature/parity");

    const id = await add(["written from the root"]);

    const places = [repo.dir, nested, worktree];
    const readings = await Promise.all(
      places.map(async (cwd) => (await runCli(["show", id, "--json"], { cwd })).stdout),
    );

    expect(readings[1]).toBe(readings[0]);
    expect(readings[2]).toBe(readings[0]);

    // And a write from the worktree is visible from the root.
    const fromWorktree = (
      await runCli(["add", "written from the worktree"], { cwd: worktree })
    ).stdout.trim();
    expect((await runCli(["show", fromWorktree], { cwd: repo.dir })).exitCode).toBe(EXIT.ok);
  });
});

describe("the working tree", () => {
  it("stays byte-identical across a representative lifecycle", async () => {
    // Acceptance criterion 4, widened past init: the ongoing risk is any write
    // command, or the WAL and SHM sidecars, not just the first run.
    const before = git(repo.dir, "status", "--porcelain");

    const id = await add(["a task"]);
    await runCli(["update", id, "--lane", "Planned"], { cwd: repo.dir });
    await runCli(["dep", id, "--blocked-by", await add(["blocker"])], { cwd: repo.dir });
    await runCli(["list"], { cwd: repo.dir });
    await runCli(["close", id], { cwd: repo.dir });

    expect(git(repo.dir, "status", "--porcelain")).toBe(before);
  });
});

describe("katra next", () => {
  it("hands back one startable task", async () => {
    const id = await add(["ready to go", "--lane", "Planned", "--priority", "0"]);
    await add(["not planned"]);

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(id);
    expect(result.stdout).toContain("blockers  none");
  });

  it("names the blockers, and still exits zero, when everything planned is stuck", async () => {
    // Exit 0 per ADR-006. Nothing failed — `next` was asked a question and the
    // answer was "nothing yet", which is not a refusal. Exit 1 would mean "do
    // not retry" (ADR-005) when closing a blocker makes the identical command
    // return a task. The distinction lives in the payload, which is the thing
    // an agent reads.
    const blocker = await add(["the blocker"]);
    const blocked = await add(["stuck", "--lane", "Planned"]);
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("1 blocked");
    expect(result.stdout).toContain("waits on");
    expect(result.stdout).toContain("the blocker");
  });

  it("carries the whole answer in the --json payload rather than in the exit code", async () => {
    const blocker = await add(["the blocker"]);
    const blocked = await add(["stuck", "--lane", "Planned"]);
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["next", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json() as { status: string; blocked: Array<{ id: string }> };
    expect(payload.status).toBe("none");
    expect(payload.blocked[0]?.id).toBe(blocked);
  });

  it("distinguishes stuck from empty without either changing the exit code", async () => {
    // The pair that makes ADR-006 safe: dropping the exit code is only sound
    // because `status` and `blocked` already separate the two cases, and both
    // must stay readable at exit 0.
    const empty = await runCli(["next", "--json"], { cwd: repo.dir });
    expect(empty.exitCode).toBe(EXIT.ok);
    expect(empty.json()).toEqual({
      status: "none",
      blocked: [],
      untriaged: 0,
      claimedElsewhere: 0,
    });

    const blocker = await add(["a blocker"]);
    const blocked = await add(["stuck", "--lane", "Planned"]);
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });

    const stuck = await runCli(["next", "--json"], { cwd: repo.dir });
    expect(stuck.exitCode).toBe(EXIT.ok);
    expect((stuck.json() as { blocked: unknown[] }).blocked).toHaveLength(1);
  });

  it("distinguishes an empty backlog from a blocked one", async () => {
    const empty = await runCli(["next", "--json"], { cwd: repo.dir });
    expect((empty.json() as { blocked: unknown[] }).blocked).toEqual([]);

    // In text mode too — and that is where it matters, since "blocked" only
    // ever appears in the human renderer. Asserting its absence from --json
    // output, as this used to, was true of any implementation.
    const text = await runCli(["next"], { cwd: repo.dir });
    expect(text.stdout).not.toContain("blocked");
    expect(text.stdout).toMatch(/nothing/i);
  });

  it("refuses --epic pointed at a task that is not an epic", async () => {
    // Same guard as `list --epic`, and it was equally unpinned: swapping
    // requireEpicId back to requireId left all 413 tests green. An empty
    // answer here reads as "this epic has nothing ready" rather than "that is
    // not an epic", which is the more expensive misreading of the two.
    const notAnEpic = await add(["a plain task", "--lane", "Planned"]);

    const result = await runCli(["next", "--epic", notAnEpic], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/not an epic/);
  });

  it("narrows to one epic's children", async () => {
    const wanted = await add(["the wanted epic", "--level", "epic"]);
    const other = await add(["another epic", "--level", "epic"]);
    await add(["in the other epic", "--lane", "Planned", "--priority", "0", "--parent", other]);
    const inWanted = await add([
      "in the wanted epic",
      "--lane",
      "Planned",
      "--priority",
      "4",
      "--parent",
      wanted,
    ]);

    const result = await runCli(["next", "--epic", wanted], { cwd: repo.dir });

    // The lower-priority task wins because the filter excluded the other one.
    expect(result.stdout).toContain(inWanted);
  });

  it("narrows by level", async () => {
    // Deleting the --level filter outright left the whole suite green.
    await add(["a planned task", "--lane", "Planned", "--priority", "0"]);
    const epic = await add(["a planned epic", "--level", "epic", "--lane", "Planned"]);

    const result = await runCli(["next", "--level", "epic", "--json"], { cwd: repo.dir });

    const payload = result.json() as { status: string; task?: { id: string; level: string } };
    expect(payload.status).toBe("found");
    expect(payload.task?.id).toBe(epic);
    expect(payload.task?.level).toBe("epic");
  });

  it("narrows by kind without returning more than one item", async () => {
    await add(["a feature", "--lane", "Planned", "--kind", "feat", "--priority", "0"]);
    const bug = await add(["a bug", "--lane", "Planned", "--kind", "fix", "--priority", "4"]);

    const result = await runCli(["next", "--kind", "fix"], { cwd: repo.dir });

    expect(result.stdout).toContain(bug);
    expect(result.stdout.match(/kt-[0-9a-z]{6}/g)).toHaveLength(1);
  });
});

describe("valueTakingFlags descends into subcommands", () => {
  /**
   * A stand-in for the shape T12 introduces.
   *
   * katra has no subcommands yet, so the mechanism is exercised against a
   * program built here. Waiting for `note` to exist would mean shipping the
   * fix untested and discovering the gap through T12's failures instead.
   */
  function probe(): Command {
    const program = new Command();
    program.name("probe");
    program.command("flat").option("--tag <tag>", "a value-taking flag").option("--json", "");

    const parent = program.command("note");
    parent.command("add").option("--kind <kind>", "a value-taking flag").option("--json", "");
    parent.command("list").option("--json", "");
    return program;
  }

  it("recognises a value-taking flag declared on a subcommand", () => {
    // `--kind` lives on `add`, not on `note`. Read at the parent level it looks
    // like a boolean, so `--json` would be counted as a real request when it
    // is actually `--kind`'s value.
    expect(wantsJson(["note", "add", "--kind", "--json"], probe())).toBe(false);
  });

  it("still recognises one declared on a top-level command", () => {
    // The behaviour the descent replaces, unchanged.
    expect(wantsJson(["flat", "--tag", "--json"], probe())).toBe(false);
  });

  it("honours a genuine --json on a subcommand", () => {
    // The guard on the guard: a descent that swallowed everything would make
    // the assertions above pass while breaking every real request.
    expect(wantsJson(["note", "add", "--kind", "handoff", "--json"], probe())).toBe(true);
    expect(wantsJson(["note", "list", "--json"], probe())).toBe(true);
    expect(wantsJson(["flat", "--json"], probe())).toBe(true);
  });

  it("stops descending at a command with no subcommands", () => {
    // `log kt-abc` must not go hunting for a subcommand named `kt-abc`, and an
    // argument that happens to match a *sibling* command's name must not pull
    // that sibling's options into scope.
    expect(wantsJson(["flat", "note", "--json"], probe())).toBe(true);
  });

  it("does not treat a parent's own flags as its children's", () => {
    // `--kind` belongs to `add`. On `list` it is not defined at all, so a
    // following `--json` is a real request and the invocation is malformed —
    // which is a usage error, not a silent downgrade to text output.
    expect(wantsJson(["note", "list", "--kind", "--json"], probe())).toBe(true);
  });
});

describe("katra next on an untriaged backlog", () => {
  it("says how much is waiting and how to plan it", async () => {
    // Found by dogfooding: eight freshly added tasks, and `next` replied
    // "nothing is in the Planned lane" — true, and a dead end. `add` puts work
    // in Defined, so the caller was told about a lane they never chose and
    // given no way forward.
    await add(["one"]);
    await add(["two"]);

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toMatch(/2 unfinished tasks are waiting to be planned/);
    // A refusal that names what would unblock it, like every other katra
    // refusal does.
    expect(result.stdout).toMatch(/katra update <id> --lane Planned/);
  });

  it("says plainly when there is no unfinished work at all", async () => {
    // The third answer, and it must not be confused with the second: an empty
    // store and an untriaged one are different situations.
    const done = await add(["finished"]);
    await runCli(["close", done], { cwd: repo.dir });

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.stdout).toMatch(/no unfinished work elsewhere/);
    expect(result.stdout).not.toMatch(/waiting to be planned/);
  });

  it("counts one waiting task in the singular", async () => {
    await add(["only one"]);

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.stdout).toMatch(/1 unfinished task is waiting/);
  });

  it("still reports blockers when something is planned but stuck", async () => {
    // The untriaged count must not displace the more specific answer.
    const blocker = await add(["a blocker"]);
    const blocked = await add(["stuck", "--lane", "Planned"]);
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.stdout).toMatch(/1 blocked:/);
    expect(result.stdout).toContain("waits on");
    expect(result.stdout).not.toMatch(/waiting to be planned/);
  });
});
