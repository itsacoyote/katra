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

  it("close flattens a hostile close-reason and unblocked-task title — no ANSI/bidi/zero-width, and forges no row", async () => {
    // Built by codepoint, per next.test.ts's convention — an invisible
    // literal in test source is unreviewable. Each hostile payload pairs a
    // visible marker with the hostile codepoints so the readable remnant
    // can be asserted; a pure-invisible payload would trim to "" instead.
    const ESC = String.fromCharCode(0x1b);
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);

    // The close-reason (result.task.closeReason, lifecycle.ts:18) carries an
    // embedded newline plus a fake row indistinguishable from a real
    // "unblocked" row, if unsanitized.
    const hostileReason = `shipped${ESC}[31m${RLO}HACKED${ZWSP}\n    kt-fake0000  a forged unblocked row`;
    // The unblocked dependent's title (task.title, lifecycle.ts:24) carries
    // its own forged row.
    const hostileDependentTitle = `was waiting${ESC}[31m${RLO}HACKED2${ZWSP}\n    kt-fake1111  another forged row`;

    const blocker = await add("the blocker");
    const dependent = await add(hostileDependentTitle);
    await runCli(["dep", dependent, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["close", blocker, "--reason", hostileReason], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).not.toContain(RLO);
    expect(result.stdout).not.toContain(ZWSP);
    // The readable remnant survives — sanitizing flattens the field, it does
    // not blank it.
    expect(result.stdout).toContain("shipped");
    expect(result.stdout).toContain("HACKED");
    expect(result.stdout).toContain("was waiting");
    expect(result.stdout).toContain("HACKED2");

    // Exactly one real "unblocked" row — the dependent's — never the extra
    // rows either hostile field's embedded newline would otherwise forge.
    const rowLines = result.stdout.split("\n").filter((line) => line.startsWith("    "));
    expect(rowLines).toHaveLength(1);
    expect(rowLines[0]).toContain(dependent);
    expect(rowLines[0]).not.toContain("kt-fake0000");
  });

  it("close --json carries the hostile close-reason verbatim", async () => {
    const ESC = String.fromCharCode(0x1b);
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const hostileReason = `shipped${ESC}[31m${RLO}HACKED${ZWSP}\nfake line`;
    const id = await add("a task");

    const result = await runCli(["close", id, "--reason", hostileReason, "--json"], {
      cwd: repo.dir,
    });

    const payload = result.json() as LifecycleResult;
    expect(payload.task.closeReason).toBe(hostileReason);
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

describe("katra reopen reports what it took away", () => {
  it("reopen flattens a hostile reblocked-task title — no ANSI/bidi/zero-width, and forges no 'blocked again' row", async () => {
    // The core returns `reblocked`; nothing rendered it. Deleting the whole
    // block from formatLifecycle once left the suite green, so the one
    // command that can produce it was printing nothing — and, until this
    // bead, unsanitized once it was rendered. `reopen` is the only command
    // that reaches this branch (close/cancel never reblock anything), so it
    // is the sole behavioral proof for lifecycle.ts:30.
    const ESC = String.fromCharCode(0x1b);
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const hostileWaiterTitle = `was startable${ESC}[31m${RLO}HACKED${ZWSP}\n    kt-fake0000  a forged blocked-again row`;

    const blocker = await add("the blocker");
    const waiter = await add(hostileWaiterTitle);
    await runCli(["dep", waiter, "--blocked-by", blocker], { cwd: repo.dir });
    await runCli(["close", blocker], { cwd: repo.dir });

    const result = await runCli(["reopen", blocker], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("blocked again 1:");
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).not.toContain(RLO);
    expect(result.stdout).not.toContain(ZWSP);
    // The readable remnant survives — sanitizing flattens the field, it does
    // not blank it.
    expect(result.stdout).toContain("was startable");
    expect(result.stdout).toContain("HACKED");

    // Exactly one real "blocked again" row — the waiter's — never a second
    // one forged out of the hostile title's embedded newline.
    const rowLines = result.stdout.split("\n").filter((line) => line.startsWith("    "));
    expect(rowLines).toHaveLength(1);
    expect(rowLines[0]).toContain(waiter);
  });

  it("says nothing about re-blocking when close and cancel run", async () => {
    const blocker = await add("the blocker");
    const waiter = await add("waits");
    await runCli(["dep", waiter, "--blocked-by", blocker], { cwd: repo.dir });

    const closed = await runCli(["close", blocker], { cwd: repo.dir });

    expect(closed.stdout).not.toContain("blocked again");
    expect(closed.stdout).toContain("unblocked 1:");
  });
});
