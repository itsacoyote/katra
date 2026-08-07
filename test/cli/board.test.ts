import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { BoardResult } from "../../src/core/contract.js";
import { BRIEF_HANDOFF_CHARS } from "../../src/core/tasks/brief.js";
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

async function note(id: string, body: string): Promise<void> {
  const result = await runCli(["note", "add", id, "--kind", "handoff", "--body-file", "-"], {
    cwd: repo.dir,
    stdin: body,
  });
  expect(result.exitCode).toBe(EXIT.ok);
}

async function board(args: readonly string[] = []): Promise<string> {
  const result = await runCli(["board", ...args], { cwd: repo.dir });
  expect(result.exitCode).toBe(EXIT.ok);
  return result.stdout;
}

async function lane(id: string, to: string): Promise<void> {
  await runCli(["update", id, "--lane", to], { cwd: repo.dir });
}

describe("katra board", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("board");
  });

  it("prints the counts header above the sections", async () => {
    const started = await add(["underway"]);
    await lane(started, "In Progress");
    const planned = await add(["ready to go"]);
    await lane(planned, "Planned");

    const out = await board();

    expect(out).toMatch(/\d+ open · \d+ in flight · \d+ ready · \d+ blocked · \d+ untriaged/);
    expect(out).toContain("in flight");
    expect(out).toContain("underway");
    expect(out).toContain("ready");
    expect(out).toContain("ready to go");
  });

  it("names the blocker in the blocked section", async () => {
    const blocker = await add(["the blocker"]);
    await lane(blocker, "Planned");
    const stuck = await add(["cannot start"]);
    await lane(stuck, "Planned");
    await runCli(["dep", stuck, "--blocked-by", blocker], { cwd: repo.dir });

    const out = await board();

    expect(out).toContain("blocked");
    expect(out).toContain(`blocked by ${blocker}`);
  });

  it("exits 0 with one line on an empty store", async () => {
    // An empty board is not a refusal — the same reasoning ADR-006 applies to
    // `next`. An agent branches on exit codes, so 1 must never mean "nothing
    // here yet".
    const result = await runCli(["board"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toContain("empty");
  });

  it("names where the work is when everything sits in Defined", async () => {
    // `add` writes into Defined, so this is the ordinary state of a young
    // store — and four empty sections above a non-empty backlog is the dead end
    // the pointer exists to prevent.
    await add(["one"]);
    await add(["two"]);

    const out = await board();

    expect(out).toContain("2 tasks waiting to be planned");
    expect(out).toContain("--lane Planned");
  });

  it("reports the true total when a section is capped", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await add([`task ${i}`]);
      await lane(id, "Planned");
    }

    const out = await board(["--limit", "2"]);

    expect(out).toContain("5 ready");
    expect(out).toContain("showing 2 of 5");
  });

  it("refuses a limit above the maximum with exit 1", async () => {
    const result = await runCli(["board", "--limit", "1e21"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.user);
  });

  it("treats --limit 0 as truthfully empty sections, not unbounded", async () => {
    const id = await add(["a task"]);
    await lane(id, "Planned");

    const document = (
      await runCli(["board", "--limit", "0", "--json"], { cwd: repo.dir })
    ).json() as BoardResult;

    expect(document.ready.tasks).toEqual([]);
    expect(document.counts.ready).toBe(1);
    // The pointer keys off the counts, not the rendered rows, so emptying the
    // sections with a cap must not make it fire.
    expect(document.pointer).toBeNull();
  });

  it("emits parseable JSON with nothing on stderr", async () => {
    await add(["a task"]);

    const result = await runCli(["board", "--json"], { cwd: repo.dir });

    expect(result.stderr).toBe("");
    const document = result.json() as BoardResult;
    expect(document.digest).toBeNull();
    expect(document.inFlight.tasks).toEqual([]);
  });
});

describe("katra board --digest", () => {
  it("leads with the newest handoff, labelled with its lane", async () => {
    const one = await add(["first"]);
    const two = await add(["second"]);
    await note(one, "the older handoff");
    await note(two, "the newest handoff");
    await lane(two, "In Review");

    const out = await board(["--digest"]);

    expect(out.indexOf("the newest handoff")).toBeLessThan(out.indexOf("open ·"));
    expect(out).toContain("In Review");
    expect(out).not.toContain("the older handoff");
  });

  it("shows a digest handoff from a Done task without implying it is live", async () => {
    // Deliberately unfiltered: "I finished X, next is Y" is the commonest real
    // handoff and lives on finished work. The lane is what disambiguates.
    const task = await add(["finished work"]);
    await note(task, "done, next is the renderer");
    await runCli(["close", task], { cwd: repo.dir });

    const out = await board(["--digest"]);

    expect(out).toContain("done, next is the renderer");
    expect(out).toContain("Done");
  });

  it("labels attribution as last touch, not as an owner", async () => {
    const task = await add(["a task"]);
    await note(task, "a handoff");

    const out = await board(["--digest"]);

    expect(out).toContain("last touch");
    expect(out).not.toMatch(/\bowner\b/i);
    expect(out).not.toMatch(/\bassignee\b/i);
  });

  it("names note list when the digest body is truncated", async () => {
    const task = await add(["a task"]);
    await note(task, "x".repeat(BRIEF_HANDOFF_CHARS + 50));

    const out = await board(["--digest"]);

    expect(out).toContain("truncated");
    expect(out).toContain(`katra note list ${task}`);
  });

  it("is a no-op when the store holds no handoff", async () => {
    await add(["a task"]);

    const document = (
      await runCli(["board", "--digest", "--json"], { cwd: repo.dir })
    ).json() as BoardResult;

    expect(document.digest).toBeNull();
  });
});

describe("board and untrusted text", () => {
  const ESC = "";
  const BIDI = "‮";

  it("strips ESC and bidi control characters from every rendered field", async () => {
    const task = await add([`title ${ESC}[31m${BIDI}red`]);
    await lane(task, "In Progress");
    await note(task, `body ${ESC}[32m${BIDI}green`);

    const out = await board(["--digest"]);

    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BIDI);
    expect(out).toContain("green");
  });

  it("keeps every character verbatim under --json", async () => {
    const task = await add(["a task"]);
    const body = `body ${ESC}[32m${BIDI}green`;
    await note(task, body);

    const document = (
      await runCli(["board", "--digest", "--json"], { cwd: repo.dir })
    ).json() as BoardResult;

    expect(document.digest?.note.body).toBe(body);
  });
});
