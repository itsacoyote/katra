import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatEventLog } from "../../src/cli/format.js";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { EventLog } from "../../src/core/contract.js";
import type { LoggedEvent } from "../../src/core/events/types.js";
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

const events = async (args: readonly string[] = []): Promise<readonly LoggedEvent[]> =>
  ((await runCli(["log", ...args, "--json"], { cwd: repo.dir })).json() as EventLog).events;

describe("katra log", () => {
  it("prints an entity's history newest first", async () => {
    const id = await add(["a task"]);
    await runCli(["update", id, "--lane", "Planned"], { cwd: repo.dir });
    await runCli(["close", id, "--reason", "shipped"], { cwd: repo.dir });

    const result = await runCli(["log", id], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toContain("closed");
    expect(lines[1]).toContain("status-changed");
    expect(lines[2]).toContain("created");
  });

  it("reads the whole store when given no id", async () => {
    await add(["one"]);
    await add(["two"]);

    expect(await events()).toHaveLength(2);
  });

  it("includes an epic's children in its history", async () => {
    const epic = await add(["an epic", "--level", "epic"]);
    const child = await add(["a child", "--parent", epic]);
    await add(["unrelated"]);

    const scoped = await events([epic]);

    expect(scoped.map((e) => e.entityId).sort()).toEqual([child, epic].sort());
  });

  it("still reads the history of a task that has been deleted", async () => {
    // The headline case, and the one `requireId` could not serve: it searches
    // `tasks`, so resolving the argument failed before the read ever ran.
    const id = await add(["a typo"]);
    await runCli(["delete", id, "--force"], { cwd: repo.dir });

    const result = await runCli(["log", id], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("deleted");
    expect(result.stdout).toContain("a typo");
  });

  it("resolves a partial id belonging to a deleted task", async () => {
    const id = await add(["a typo"]);
    await runCli(["delete", id, "--force"], { cwd: repo.dir });

    const result = await runCli(["log", id.slice(3, 6)], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("deleted");
  });

  it("keeps a deleted child's history under its epic", async () => {
    const epic = await add(["an epic", "--level", "epic"]);
    const child = await add(["doomed", "--parent", epic]);
    await runCli(["delete", child, "--force"], { cwd: repo.dir });

    const scoped = await events([epic]);

    expect(scoped.map((e) => e.type)).toContain("deleted");
    expect(scoped.some((e) => e.entityId === child)).toBe(true);
  });

  it("bounds the result with --limit", async () => {
    const id = await add(["a task"]);
    await runCli(["update", id, "--lane", "Planned"], { cwd: repo.dir });
    await runCli(["close", id], { cwd: repo.dir });

    expect(await events(["--limit", "2"])).toHaveLength(2);
    expect(await events(["--limit", "0"])).toHaveLength(0);
  });

  it("refuses a --limit that is not a whole count", async () => {
    const result = await runCli(["log", "--limit", "lots"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/whole number/);
  });

  it("says nothing has happened rather than printing an empty response", async () => {
    // A blank response is indistinguishable from a command that failed
    // silently.
    const result = await runCli(["log"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout.trim()).toBe("nothing has happened yet");
  });

  it("refuses an id that neither a task nor history knows", async () => {
    const result = await runCli(["log", "kt-zzzzzz"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/no task or recorded history matches/);
  });

  it("emits parseable JSON with nothing on stderr", async () => {
    const id = await add(["a task"]);
    await runCli(["close", id, "--reason", "done"], { cwd: repo.dir });

    const result = await runCli(["log", id, "--json"], { cwd: repo.dir });

    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toBe("");
    const document = result.json() as EventLog;
    expect(document.events[0]).toMatchObject({ type: "closed", reason: "done" });
  });

  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("log");
  });
});

describe("formatEventLog", () => {
  const event = (overrides: Partial<LoggedEvent> = {}): LoggedEvent => ({
    id: 1,
    type: "created",
    entityId: "kt-aaaaaa",
    epicId: null,
    actor: "main @ /repo",
    fromLane: null,
    toLane: null,
    ref: null,
    reason: null,
    title: null,
    createdAt: "2026-08-05T16:41:09.123Z",
    entityTitle: null,
    ...overrides,
  });

  it("keeps one physical line per event when a reason contains newlines", () => {
    // `--reason` is a plain argument, never routed through readBody, so it can
    // hold newlines — and one of them shifts every following row out of its
    // column for the rest of the log.
    const rendered = formatEventLog([
      event({ type: "cancelled", reason: "first line\nsecond line\r\nthird" }),
      event({ id: 2 }),
    ]);

    expect(rendered.split("\n")).toHaveLength(2);
    expect(rendered).toContain("first line second line third");
  });

  it("strips control characters that would execute on a terminal", () => {
    // Reasons and titles are where fetched content and model output get
    // pasted. A raw escape sequence runs on whatever renders it.
    const rendered = formatEventLog([
      event({ type: "cancelled", reason: "\u001B[31mred\u0007", entityTitle: "\u001B[1mbold" }),
    ]);

    expect(rendered).not.toContain("\u001B");
    expect(rendered).not.toContain("\u0007");
    expect(rendered).toContain("[31mred");
    expect(rendered).toContain("[1mbold");
  });

  it("does not overflow the stack on a very large history", () => {
    // `Math.max(...events.map(…))` blows the stack somewhere past a hundred
    // thousand arguments, and nothing prunes this table — its size is
    // unbounded by design.
    const many = Array.from({ length: 200_000 }, (_unused, index) =>
      event({ id: index + 1, entityId: `kt-${String(index).padStart(6, "0")}` }),
    );

    expect(() => formatEventLog(many)).not.toThrow();
  });

  it("shows a lane transition with both ends", () => {
    const rendered = formatEventLog([
      event({ type: "status-changed", fromLane: "Defined", toLane: "Planned" }),
    ]);

    expect(rendered).toContain("Defined -> Planned");
  });

  it("renders the date as well as the time", () => {
    // A log spanning weeks needs it; ADR-008's illustration showed the time
    // alone because every line in it was from one afternoon.
    expect(formatEventLog([event()])).toContain("2026-08-05 16:41");
  });

  it("omits the actor column when every event shares one actor", () => {
    // In a single-agent repository it is the same string on every row.
    const rendered = formatEventLog([event(), event({ id: 2 })]);

    expect(rendered).not.toContain("main @ /repo");
  });

  it("shows the actor once the log holds more than one", () => {
    // Across worktrees it is the whole reason ADR-007 records it.
    const rendered = formatEventLog([event(), event({ id: 2, actor: "feature/other @ /repo/wt" })]);

    expect(rendered).toContain("main @ /repo");
    expect(rendered).toContain("feature/other @ /repo/wt");
  });

  it("says nothing has happened for an empty log", () => {
    expect(formatEventLog([])).toBe("nothing has happened yet");
  });
});

describe("entity titles in the log", () => {
  it("names the task a lifecycle event is about", async () => {
    // Without this, whole-store history is a column of ids: `status-changed
    // kt-0zhobj Defined -> Planned` says nothing about which task moved.
    const id = await add(["wire the events"]);
    await runCli(["update", id, "--lane", "Planned"], { cwd: repo.dir });

    const all = await events();
    const moved = all.find((e) => e.type === "status-changed");

    expect(moved?.entityTitle).toBe("wire the events");
    // The stored column stays null: only created and deleted stamp a title.
    expect(moved?.title).toBeNull();
  });

  it("prefers the task's current title over the one stamped at creation", async () => {
    // A log's job is to say *which* task a row is about, and the live title
    // answers that after a rename. What it was called at the time is still on
    // the event for anyone who wants that instead.
    const id = await add(["the old name"]);
    await runCli(["update", id, "--title", "the new name"], { cwd: repo.dir });

    const created = (await events([id])).find((e) => e.type === "created");

    expect(created?.entityTitle).toBe("the new name");
    expect(created?.title).toBe("the old name");
  });

  it("keeps rendering events whose task has been deleted", async () => {
    // The LEFT join, asserted through the command. An inner join drops every
    // one of these rows — the bug ADR-008 predicts by name.
    const id = await add(["a typo"]);
    await runCli(["delete", id, "--force"], { cwd: repo.dir });

    const history = await events([id]);

    expect(history.map((e) => e.type)).toEqual(["deleted", "created"]);
    // No live row to join to, so the stamped title is what survives.
    expect(history.every((e) => e.entityTitle === "a typo")).toBe(true);
  });

  it("does not lose unrelated events from the whole-store read when one task is deleted", async () => {
    const kept = await add(["still here"]);
    const gone = await add(["removed"]);
    await runCli(["delete", gone, "--force"], { cwd: repo.dir });

    const all = await events();

    expect(all.some((e) => e.entityId === kept)).toBe(true);
    expect(all.some((e) => e.entityId === gone)).toBe(true);
  });

  it("names every task the log spans", async () => {
    const one = await add(["first task"]);
    await add(["second task"]);
    await runCli(["update", one, "--lane", "Planned"], { cwd: repo.dir });

    const whole = await runCli(["log"], { cwd: repo.dir });
    const scoped = await runCli(["log", one], { cwd: repo.dir });

    // Several tasks: the title is the only thing telling the rows apart.
    expect(whole.stdout).toContain("first task");
    expect(whole.stdout).toContain("second task");
    // One task, named by the caller: repeating its title down the page is the
    // same noise the actor column is elided to avoid.
    // Scoped, the title repeats — deliberately. For a task that still exists
    // `show` could tell you, but for a deleted one this log is the only place
    // the name survives, so eliding it would destroy the answer exactly when
    // it matters most.
    expect(scoped.stdout).toContain("first task");
    expect(scoped.stdout).toContain(one);
  });
});
