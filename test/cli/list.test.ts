import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { TaskList } from "../../src/core/tasks/repo.js";
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

async function list(args: readonly string[] = []): Promise<TaskList> {
  const result = await runCli(["list", ...args, "--json"], { cwd: repo.dir });
  expect(result.exitCode).toBe(EXIT.ok);
  return result.json() as TaskList;
}

describe("katra list", () => {
  it("lists every task by default", async () => {
    await add(["one"]);
    await add(["two"]);

    expect((await list()).tasks).toHaveLength(2);
  });

  it("says nothing matched rather than printing an empty response", async () => {
    // A blank response is indistinguishable from a command that failed
    // silently, which an agent would misread as "no work left".
    const result = await runCli(["list"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout.trim()).toBe("no tasks match");
  });

  it("applies every filter the model supports", async () => {
    const epic = await add(["the epic", "--level", "epic"]);
    await add([
      "wanted",
      "--kind",
      "fix",
      "--lane",
      "Planned",
      "--priority",
      "0",
      "--assignee",
      "ada",
      "--parent",
      epic,
      "--tag",
      "urgent",
    ]);
    await add(["other", "--kind", "feat"]);

    expect((await list(["--kind", "fix"])).tasks.map((t) => t.title)).toEqual(["wanted"]);
    expect((await list(["--lane", "Planned"])).tasks.map((t) => t.title)).toEqual(["wanted"]);
    expect((await list(["--priority", "0"])).tasks.map((t) => t.title)).toEqual(["wanted"]);
    expect((await list(["--assignee", "ada"])).tasks.map((t) => t.title)).toEqual(["wanted"]);
    expect((await list(["--tag", "urgent"])).tasks.map((t) => t.title)).toEqual(["wanted"]);
    expect((await list(["--level", "epic"])).tasks.map((t) => t.title)).toEqual(["the epic"]);
    expect((await list(["--epic", epic.slice(3, 6)])).tasks.map((t) => t.title)).toEqual([
      "wanted",
    ]);
  });

  it("separates ready from blocked", async () => {
    const blocker = await add(["blocker"]);
    const blocked = await add(["blocked"]);
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });

    expect((await list(["--blocked"])).tasks.map((t) => t.title)).toEqual(["blocked"]);
    expect((await list(["--ready"])).tasks.map((t) => t.title)).toEqual(["blocker"]);
  });

  it("treats --ready with --blocked as no readiness filter at all", async () => {
    const blocker = await add(["blocker"]);
    const blocked = await add(["blocked"]);
    await runCli(["dep", blocked, "--blocked-by", blocker], { cwd: repo.dir });

    expect((await list(["--ready", "--blocked"])).tasks).toHaveLength(2);
  });

  it("rejects a lane outside the fixed set rather than matching nothing", async () => {
    // Silently returning zero rows would read as "no such work" instead of
    // "you typed a lane that does not exist".
    const result = await runCli(["list", "--lane", "Ready"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/lane must be one of/);
  });

  it("aligns its columns in text mode", async () => {
    await add(["short"]);
    await add(["a much longer title", "--lane", "In Progress", "--priority", "0"]);

    const result = await runCli(["list"], { cwd: repo.dir });
    const lines = result.stdout.trim().split("\n");

    expect(lines).toHaveLength(2);
    // Highest priority first.
    expect(lines[0]).toContain("P0");

    // And the columns actually line up. The previous version asserted only
    // that the row contained its own priority and title, which is true of
    // unaligned output too — deleting both `padEnd` calls from the formatter
    // left it passing. Comparing where the title starts is the property.
    expect(lines[1]).toContain("Defined    "); // "Defined" padded to "In Progress"
    expect(lines[0]?.indexOf("a much longer title")).toBe(lines[1]?.indexOf("short"));
  });

  it("emits list output that parses as JSON with no human text mixed in", async () => {
    await add(["one"]);

    const result = await runCli(["list", "--json"], { cwd: repo.dir });

    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect((result.json() as TaskList).tasks).toHaveLength(1);
  });

  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("list");
  });
});
