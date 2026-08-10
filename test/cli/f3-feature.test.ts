/**
 * F3's cross-command properties.
 *
 * The two claims here cannot be made by either command's own suite: one is
 * about `brief` and `board` **together**, the other about `board` agreeing with
 * a command from F1. A per-command test can only ever check its own half.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { BoardResult, EventLog, NextResult } from "../../src/core/contract.js";
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

async function lane(id: string, to: string): Promise<void> {
  await runCli(["update", id, "--lane", to], { cwd: repo.dir });
}

/** How many events the store holds, read through the CLI like everything else. */
async function eventCount(): Promise<number> {
  const log = (await runCli(["log", "--limit", "1000", "--json"], { cwd: repo.dir })).json();
  return (log as EventLog).events.length;
}

describe("F3 reads change nothing", () => {
  it("runs brief and board without writing an event", async () => {
    // Asserted over **both** commands in one run, because that is what the
    // criterion says. Each command's own suite checks its own half, and neither
    // can speak for the pair.
    const epic = await add(["an epic", "--level", "epic"]);
    const task = await add(["a task", "--parent", epic]);
    await lane(task, "Planned");
    await runCli(["note", "add", task, "--kind", "handoff", "--body-file", "-"], {
      cwd: repo.dir,
      stdin: "a handoff",
    });

    const before = await eventCount();

    for (const args of [
      ["brief", task],
      ["brief", task, "--full"],
      ["brief", epic],
      ["board"],
      ["board", "--digest"],
      ["board", "--limit", "1"],
    ]) {
      const result = await runCli(args, { cwd: repo.dir });
      expect(result.exitCode, `${args.join(" ")} failed`).toBe(EXIT.ok);
    }

    expect(await eventCount()).toBe(before);
  });
});

describe("board and next agree about what to start", () => {
  it("agrees with next about the first ready task, through the CLI", async () => {
    // Asserted against `next` itself, never a hard-coded id — a literal would
    // still pass once the two queries drifted apart, which is the whole failure
    // this pins. At the CLI level, so it covers the wiring as well as the query.
    const ids: string[] = [];
    for (const [index, priority] of [3, 0, 1, 2].entries()) {
      const id = await add([`task ${index}`, "--priority", String(priority)]);
      await lane(id, "Planned");
      ids.push(id);
    }

    const board = (await runCli(["board", "--json"], { cwd: repo.dir })).json() as BoardResult;
    const next = (await runCli(["next", "--json"], { cwd: repo.dir })).json() as NextResult;

    if (next.status !== "found") throw new Error("next found nothing to compare against");
    expect(board.ready.tasks[0]?.id).toBe(next.task.id);
    expect(ids).toContain(next.task.id);
  });

  it("agrees when the only planned work is an epic — neither offers it", async () => {
    // The behaviour change F3 makes to `next`, checked from both sides at once.
    // An epic is a container; nobody picks one up.
    const epic = await add(["an epic", "--level", "epic"]);
    await lane(epic, "Planned");

    const board = (await runCli(["board", "--json"], { cwd: repo.dir })).json() as BoardResult;
    const next = (await runCli(["next", "--json"], { cwd: repo.dir })).json() as NextResult;

    expect(board.ready.tasks).toEqual([]);
    expect(board.counts.ready).toBe(0);
    expect(next.status).toBe("none");
  });
});
