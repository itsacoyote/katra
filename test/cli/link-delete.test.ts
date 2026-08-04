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
});

describe("registration", () => {
  it("registers link and delete on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["link", "delete"]));
  });
});
