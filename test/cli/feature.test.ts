/**
 * The whole-feature gates.
 *
 * Every other test file checks one command. These check properties that only
 * exist across the finished command set — which is why they land last, and why
 * they iterate the program rather than a hand-written list: a list would drift
 * silently the moment a command is added.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo, git } from "../helpers/fixture.js";

/** The database file, for tests that need to break it on purpose. */
function storeDbPath(dir: string): string {
  return join(dir, ".git", STORE_DIR_NAME, DB_FILE_NAME);
}

/** Every command katra ships in F1. */
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
  "next",
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
  it("registers all twelve commands on the program", () => {
    // Iterating the program rather than asserting against a hand-written list
    // is the point: a command built and never wired up would pass any test
    // that only checked the list.
    const registered = createProgram({ cwd: repo.dir })
      .commands.map((command) => command.name())
      .sort();

    expect(registered).toEqual([...EXPECTED_COMMANDS].sort());
    expect(registered).toHaveLength(12);
  });

  it("gives every command a description and a --json flag where it returns data", () => {
    for (const command of createProgram({ cwd: repo.dir }).commands) {
      expect(command.description(), `${command.name()} has no description`).not.toBe("");
      const flags = command.options.map((option) => option.long);
      expect(flags, `${command.name()} has no --json`).toContain("--json");
    }
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

    const invocations: Array<readonly string[]> = [
      ["init"],
      ["add", "another task"],
      ["show", blocker],
      ["list"],
      ["update", blocker, "--priority", "1"],
      ["dep", dependent, "--blocked-by", blocker],
      ["link", linked, doomed],
      ["close", blocker],
      ["reopen", blocker],
      ["cancel", blocker, "--reason", "dropped"],
      ["delete", doomed, "--force"],
      ["next"],
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
  it("does not switch to JSON when --json is an option's value", async () => {
    // `argv.includes("--json")` was true here, so a caller who never asked for
    // JSON got a JSON error document on stdout and an empty stderr.
    const result = await runCli(["add", "t", "--assignee", "--json", "--nope"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/unknown option/);
  });

  it("ignores --json after a bare double dash", async () => {
    const result = await runCli(["add", "--", "--json"], { cwd: repo.dir });
    expect(result.stdout).toMatch(/^kt-/);
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

  it("exits non-zero and names the blockers when everything planned is stuck", async () => {
    // An empty success would read as "all done" when the truth is "everything
    // is stuck" — the distinction this whole return shape exists for.
    const blocker = await add(["the blocker"]);
    const blocked = await add(["stuck", "--lane", "Planned"]);
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["next"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stdout).toContain("1 blocked");
    expect(result.stdout).toContain("waits on");
    expect(result.stdout).toContain("the blocker");
  });

  it("still emits a structured answer under --json when nothing is ready", async () => {
    const blocker = await add(["the blocker"]);
    const blocked = await add(["stuck", "--lane", "Planned"]);
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["next", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    const payload = result.json() as { status: string; blocked: Array<{ id: string }> };
    expect(payload.status).toBe("none");
    expect(payload.blocked[0]?.id).toBe(blocked);
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

  it("narrows by kind without returning more than one item", async () => {
    await add(["a feature", "--lane", "Planned", "--kind", "feat", "--priority", "0"]);
    const bug = await add(["a bug", "--lane", "Planned", "--kind", "fix", "--priority", "4"]);

    const result = await runCli(["next", "--kind", "fix"], { cwd: repo.dir });

    expect(result.stdout).toContain(bug);
    expect(result.stdout.match(/kt-[0-9a-z]{6}/g)).toHaveLength(1);
  });
});
