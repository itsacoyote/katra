import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinkResult } from "../../src/cli/commands/link.js";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { DeleteResult } from "../../src/core/tasks/delete.js";
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

describe("katra link", () => {
  it("links two tasks and shows the link from both ends", async () => {
    const a = await add(["first"]);
    const b = await add(["second"]);

    const result = await runCli(["link", a, b], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.ok);

    const fromA = (await runCli(["show", a, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    const fromB = (await runCli(["show", b, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(fromA.links.map((l) => l.id)).toEqual([b]);
    expect(fromB.links.map((l) => l.id)).toEqual([a]);
  });

  it("is idempotent in either direction", async () => {
    const a = await add(["first"]);
    const b = await add(["second"]);

    await runCli(["link", a, b], { cwd: repo.dir });
    const again = await runCli(["link", b, a], { cwd: repo.dir });

    expect(again.exitCode).toBe(EXIT.ok);
    const fromA = (await runCli(["show", a, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(fromA.links).toHaveLength(1);
  });

  it("removes a link from either direction", async () => {
    const a = await add(["first"]);
    const b = await add(["second"]);
    await runCli(["link", a, b], { cwd: repo.dir });

    const result = await runCli(["link", b, a, "--remove"], { cwd: repo.dir });

    expect(result.stdout).toContain("no longer linked");
    const fromA = (await runCli(["show", a, "--json"], { cwd: repo.dir })).json() as TaskDetail;
    expect(fromA.links).toEqual([]);
  });

  it("does not make a linked task blocked", async () => {
    // A link says "related", not "waits for".
    const a = await add(["first"]);
    const b = await add(["second"]);
    await runCli(["link", a, b], { cwd: repo.dir });

    const ready = await runCli(["list", "--ready", "--json"], { cwd: repo.dir });
    expect((ready.json() as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it("emits the pair as JSON in canonical order", async () => {
    const a = await add(["first"]);
    const b = await add(["second"]);

    const result = await runCli(["link", b, a, "--json"], { cwd: repo.dir });

    const payload = result.json() as LinkResult;
    expect(payload.action).toBe("linked");
    expect([payload.a, payload.b]).toEqual([a, b].sort());
    // The pair was passed in as (b, a). Ids are random, so roughly half the
    // time b already sorts before a and an implementation that simply echoed
    // its arguments would satisfy the assertion above by luck. This is the
    // canonical-order claim itself, and it holds on every run.
    expect(payload.a < payload.b).toBe(true);
  });
});

describe("katra delete", () => {
  it("requires --force, and never prompts", async () => {
    // A prompt would hang a non-interactive agent's turn rather than ask it
    // anything, so confirmation is a flag.
    const id = await add(["a mistake"]);

    const result = await runCli(["delete", id], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/--force/);
    expect(result.stderr).toMatch(/katra cancel/);
    // Nothing was removed.
    expect((await runCli(["show", id], { cwd: repo.dir })).exitCode).toBe(EXIT.ok);
  });

  it("deletes a task when forced", async () => {
    const id = await add(["a mistake"]);

    const result = await runCli(["delete", id, "--force"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(`deleted ${id}`);
    expect((await runCli(["show", id], { cwd: repo.dir })).exitCode).toBe(EXIT.user);
  });

  it("reports what the deletion unblocked", async () => {
    const blocker = await add(["the blocker"]);
    const dependent = await add(["was waiting"]);
    await runCli(["dep", dependent, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["delete", blocker, "--force"], { cwd: repo.dir });

    expect(result.stdout).toContain("unblocked 1");
    expect(result.stdout).toContain("was waiting");
  });

  it("refuses to delete an epic that still has children, with the conflict code", async () => {
    const epic = await add(["the epic", "--level", "epic"]);
    await add(["child", "--parent", epic]);

    const result = await runCli(["delete", epic, "--force"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.stderr).toMatch(/1 child\b/);
    expect((await runCli(["show", epic], { cwd: repo.dir })).exitCode).toBe(EXIT.ok);
  });

  it("emits the result as JSON", async () => {
    const id = await add(["a mistake"]);

    const result = await runCli(["delete", id, "--force", "--json"], { cwd: repo.dir });

    expect((result.json() as DeleteResult).id).toBe(id);
  });

  it("delete flattens a hostile stored title — no ANSI/bidi/zero-width in output, and forges no unblocked row", async () => {
    // Built by codepoint, per next.test.ts's convention — an invisible
    // literal in test source is unreviewable. Each hostile payload pairs a
    // visible marker with the hostile codepoints so the readable remnant
    // can be asserted; a pure-invisible payload would trim to "" instead.
    const ESC = String.fromCharCode(0x1b);
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);

    // The deleted task's own title (result.title, delete.ts:14) carries an
    // embedded newline plus a fake row indistinguishable from a real
    // "unblocked" row, if unsanitized.
    const hostileBlockerTitle = `the blocker${ESC}[31m${RLO}HACKED${ZWSP}\n    kt-fake0000  a forged unblocked row`;
    // The unblocked dependent's title (task.title, delete.ts:17) carries its
    // own forged row.
    const hostileDependentTitle = `was waiting${ESC}[31m${RLO}HACKED2${ZWSP}\n    kt-fake1111  another forged row`;

    const blocker = await add([hostileBlockerTitle]);
    const dependent = await add([hostileDependentTitle]);
    await runCli(["dep", dependent, "--blocked-by", blocker], { cwd: repo.dir });

    const result = await runCli(["delete", blocker, "--force"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).not.toContain(RLO);
    expect(result.stdout).not.toContain(ZWSP);
    // The readable remnant survives — sanitizing flattens the field, it does
    // not blank it.
    expect(result.stdout).toContain("the blocker");
    expect(result.stdout).toContain("HACKED");
    expect(result.stdout).toContain("was waiting");
    expect(result.stdout).toContain("HACKED2");

    // Exactly one real "unblocked" row — the dependent's — never the extra
    // rows either hostile title's embedded newline would otherwise forge.
    const rowLines = result.stdout.split("\n").filter((line) => line.startsWith("    "));
    expect(rowLines).toHaveLength(1);
    expect(rowLines[0]).toContain(dependent);
    expect(rowLines[0]).not.toContain("kt-fake0000");
  });

  it("delete --json carries the hostile title verbatim", async () => {
    const ESC = String.fromCharCode(0x1b);
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const hostileTitle = `a mistake${ESC}[31m${RLO}HACKED${ZWSP}\nfake line`;
    const id = await add([hostileTitle]);

    const result = await runCli(["delete", id, "--force", "--json"], { cwd: repo.dir });

    expect((result.json() as DeleteResult).title).toBe(hostileTitle);
  });
});

describe("registration", () => {
  it("registers link and delete on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["link", "delete"]));
  });
});

describe("deleting a task that carries everything", () => {
  it("removes its tags, links and dependencies through the CLI", async () => {
    // Covered at the core level; the CLI layer is a thin pass-through, but
    // "thin" is an assumption worth one test rather than an argument.
    const doomed = await add(["doomed", "--tag", "hot", "--tag", "cold"]);
    const linked = await add(["linked"]);
    const blocked = await add(["waiting on doomed"]);
    await runCli(["link", doomed, linked], { cwd: repo.dir });
    await runCli(["dep", blocked, "--blocked-by", doomed], { cwd: repo.dir });

    const result = await runCli(["delete", doomed, "--force", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json() as { unblocked: Array<{ id: string }> };
    expect(payload.unblocked.map((t) => t.id)).toEqual([blocked]);

    // The dependent is startable, the link is gone from the survivor's side,
    // and the task itself is unfindable.
    expect((await runCli(["show", doomed], { cwd: repo.dir })).exitCode).toBe(EXIT.user);
    const survivor = (await runCli(["show", linked, "--json"], { cwd: repo.dir })).json() as {
      links: unknown[];
    };
    expect(survivor.links).toEqual([]);
    const ready = (await runCli(["list", "--ready", "--json"], { cwd: repo.dir })).json() as {
      tasks: Array<{ id: string }>;
    };
    expect(ready.tasks.map((t) => t.id)).toContain(blocked);
  });
});
