import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { BriefResult } from "../../src/core/contract.js";
import { openStore } from "../../src/core/store.js";
import { BRIEF_HANDOFF_CHARS } from "../../src/core/tasks/brief.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";
import { seedTask } from "../helpers/seed.js";

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => repo.cleanup());

async function add(args: readonly string[]): Promise<string> {
  return (await runCli(["add", ...args], { cwd: repo.dir })).stdout.trim();
}

/** Writes a note through the real CLI path, which only takes a body file. */
async function note(id: string, body: string, kind = "handoff"): Promise<void> {
  const result = await runCli(["note", "add", id, "--kind", kind, "--body-file", "-"], {
    cwd: repo.dir,
    stdin: body,
  });
  expect(result.exitCode).toBe(EXIT.ok);
}

async function brief(args: readonly string[]): Promise<string> {
  const result = await runCli(["brief", ...args], { cwd: repo.dir });
  expect(result.exitCode).toBe(EXIT.ok);
  return result.stdout;
}

describe("katra brief", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("brief");
  });

  it("prints the handoff body in one invocation", async () => {
    // The claim the whole feature rests on: no second command to read the note.
    const task = await add(["wire up the renderer"]);
    await note(task, "picked up the parser, left the renderer half-done");

    const out = await brief([task]);

    expect(out).toContain("picked up the parser, left the renderer half-done");
    expect(out).toContain("handoff");
  });

  it("labels attribution as last touch, not as an owner", async () => {
    // katra has no concept of ownership until claims land. A heading that said
    // "owner" would have a reader believe somebody currently holds this.
    const task = await add(["a task"]);
    await note(task, "a handoff");

    const out = await brief([task]);

    expect(out).toContain("last touch");
    expect(out).not.toMatch(/\bowner\b/i);
    expect(out).not.toMatch(/\bassignee\b/i);
  });

  it("names note list with the resolved id when it truncates a handoff", async () => {
    // The second half of the truncation contract: saying it was cut is not
    // enough if the reader has to work out how to see the rest.
    const task = await add(["a task"]);
    await note(task, "x".repeat(BRIEF_HANDOFF_CHARS + 50));

    const out = await brief([task]);

    expect(out).toContain("truncated");
    expect(out).toContain(`katra note list ${task}`);
  });

  it("prints the whole body under --full", async () => {
    const task = await add(["a task"]);
    await note(task, `${"x".repeat(BRIEF_HANDOFF_CHARS + 50)}THEEND`);

    expect(await brief([task, "--full"])).toContain("THEEND");
    expect(await brief([task])).not.toContain("THEEND");
  });

  it("omits the note sections when a task has none", async () => {
    // An empty heading is a line that says nothing happened, which the absence
    // already says. Activity is not asserted absent here — `add` writes a
    // `created` event, so a task made through the CLI always has one. The
    // genuinely-empty case is pinned at core level.
    const task = await add(["a bare task"]);

    const out = await brief([task]);

    expect(out).not.toContain("handoff");
    expect(out).not.toContain("notes:");
  });

  it("includes a note body where show includes none", async () => {
    // The line between the two commands, asserted in both directions. If it
    // ever blurs, `brief` is `show --verbose` and does not earn its place.
    const task = await add(["a task"]);
    // Longer than `show`'s 56-character preview, and multi-line: those are the
    // two things a preview cannot carry and a body must.
    const body = `${"the opening clause runs on for a while so a preview cannot hold it"}\nand a second line the preview flattens away`;
    await note(task, body);

    const briefOut = await brief([task]);
    const showOut = (await runCli(["show", task], { cwd: repo.dir })).stdout;

    expect(briefOut).toContain("and a second line the preview flattens away");
    expect(showOut).not.toContain("and a second line the preview flattens away");
  });

  it("carries blockers on both shapes, and children only on the epic", async () => {
    const epic = await add(["an epic", "--level", "epic"]);
    const child = await add(["a child", "--parent", epic]);

    const epicDoc = (await runCli(["brief", epic, "--json"], { cwd: repo.dir })).json();
    const taskDoc = (await runCli(["brief", child, "--json"], { cwd: repo.dir })).json();

    expect(Object.hasOwn(epicDoc as object, "children")).toBe(true);
    expect(Object.hasOwn(taskDoc as object, "children")).toBe(false);
    // Both carry blockers — that is not what the union discriminates.
    expect(Object.hasOwn(epicDoc as object, "blockers")).toBe(true);
    expect(Object.hasOwn(taskDoc as object, "blockers")).toBe(true);
  });

  it("groups an epic's children under their lanes", async () => {
    const epic = await add(["an epic", "--level", "epic"]);
    await add(["planned work", "--parent", epic]);
    const started = await add(["started work", "--parent", epic]);
    await runCli(["update", started, "--lane", "In Progress"], { cwd: repo.dir });

    const out = await brief([epic]);
    // Sliced above the activity heading. Every one of these strings also
    // appears in the activity rows — `created` and `status-changed` name the
    // child and its lanes — so asserting on the whole output passes even with
    // `childrenByLane` returning nothing at all.
    const shape = out.slice(0, out.indexOf("activity ("));

    expect(shape).toContain("In Progress");
    expect(shape).toContain("started work");
    expect(shape).toContain("planned work");
  });

  it("reports what a task blocks, naming the dependent", async () => {
    // Requirement 2's other direction. The blocking data was asserted at core
    // level while no test rendered the section — coverage found the loop with
    // zero hits, so it could be deleted with the whole suite green.
    const blocker = await add(["the foundation"]);
    const dependent = await add(["waits on the foundation"]);
    await runCli(["dep", dependent, "--blocked-by", blocker], { cwd: repo.dir });

    const out = await brief([blocker]);

    // The line itself, so an activity row naming the dependent cannot carry it.
    const line = out.split("\n").find((l) => l.trimStart().startsWith("blocking")) ?? "";
    expect(line).toContain(dependent);
    expect(line).toContain("waits on the foundation");
  });

  it("refuses an id nothing matches, with exit 1", async () => {
    const result = await runCli(["brief", "kt-zzzzzz"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.user);
  });

  it("lists candidates when the id prefix is ambiguous", async () => {
    // Ids are random, so a shared prefix is seeded rather than added.
    const { store } = openStore(repo.dir, {});
    try {
      seedTask(store, { id: "kt-ab0001" });
      seedTask(store, { id: "kt-ab0002" });
    } finally {
      store.close();
    }

    const result = await runCli(["brief", "ab"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toContain("kt-ab0001");
    expect(result.stderr).toContain("kt-ab0002");
  });

  it("refuses a missing id argument with the usage exit code", async () => {
    // 2, not 1: the invocation itself is malformed, which EXIT.usage exists
    // for — a missing argument is not a well-formed request katra refused.
    const result = await runCli(["brief"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("honours --full for an epic's child handoff under --json", async () => {
    // Three wirings in one pass: --full through the CLI, --full on an epic,
    // and --full composed with --json — none of which any single unit test
    // exercises end to end.
    const epic = await add(["an epic", "--level", "epic"]);
    const child = await add(["a child", "--parent", epic]);
    await note(child, "x".repeat(BRIEF_HANDOFF_CHARS + 50));

    const result = await runCli(["brief", epic, "--full", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    const document = result.json() as BriefResult;
    expect(document.handoff?.truncated).toBe(false);
    expect(document.handoff?.note.body).toHaveLength(BRIEF_HANDOFF_CHARS + 50);
  });

  it("emits parseable JSON with nothing on stderr", async () => {
    const task = await add(["a task"]);
    await note(task, "a handoff");

    const result = await runCli(["brief", task, "--json"], { cwd: repo.dir });

    expect(result.stderr).toBe("");
    const document = result.json() as BriefResult;
    expect(document.level).toBe("task");
    expect(document.handoff?.note.body).toBe("a handoff");
  });
});

describe("brief and untrusted text", () => {
  // Built by codepoint — an invisible literal in test source is unreviewable.
  const ALM = String.fromCharCode(0x061c);
  const LS = String.fromCharCode(0x2028);
  const ESC = "";
  const BIDI = "‮";

  it("strips ESC and bidi control characters from every rendered field", async () => {
    // The largest untrusted-text surface katra has: a handoff body is where
    // pasted output and model text land, and `brief` is the command that hands
    // it to the next agent. F2 shipped a version of this bug once, where the
    // same string was sanitised in one renderer and raw in another.
    const result = await runCli(
      ["add", `title ${ESC}[31m${BIDI}${ALM}red${LS}end`, "--body-file", "-"],
      {
        cwd: repo.dir,
        stdin: `description ${ESC}[1m${BIDI}${ALM}bold${LS}tail`,
      },
    );
    expect(result.exitCode).toBe(EXIT.ok);
    const task = result.stdout.trim();
    await note(task, `body ${ESC}[32m${BIDI}${ALM}green${LS}split\nsecond line`);

    const out = await brief([task]);

    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BIDI);
    // ALM is the Trojan Source mark the first bidi class missed; the line
    // separators break a row in any non-terminal renderer.
    expect(out).not.toContain(ALM);
    expect(out).not.toContain(LS);
    // The text itself survives — this strips the payload, not the content.
    expect(out).toContain("green");
    expect(out).toContain("second line");
  });

  it("keeps every character verbatim under --json", async () => {
    // The sanitizers are a terminal concern. A value altered on the way out
    // would no longer be what was stored, and --json is the contract another
    // agent parses.
    const task = await add(["a task"]);
    const body = `body ${ESC}[32m${BIDI}green`;
    await note(task, body);

    const document = (
      await runCli(["brief", task, "--json"], { cwd: repo.dir })
    ).json() as BriefResult;

    expect(document.handoff?.note.body).toBe(body);
  });
});

describe("brief on an epic answers for the epic", () => {
  it("names the child's task when truncating a handoff that came from a child", async () => {
    // The hint has to name a command that works. On an epic the handoff comes
    // from the epic *or any child*, and `note list` is task-scoped — so naming
    // the epic sends the reader to a command that prints "no notes".
    const epic = await add(["an epic", "--level", "epic"]);
    const child = await add(["a child", "--parent", epic]);
    await note(child, "x".repeat(BRIEF_HANDOFF_CHARS + 50));

    const out = await brief([epic]);

    expect(out).toContain(`katra note list ${child}`);
    expect(out).not.toContain(`katra note list ${epic}`);
  });

  it("does not name a task-scoped command for an epic's aggregated note counts", async () => {
    // No single id answers this: the tally spans children. Naming `note list`
    // would assert notes exist and then point at something that says they do not.
    const epic = await add(["an epic", "--level", "epic"]);
    const child = await add(["a child", "--parent", epic]);
    await note(child, "a decision", "decision");

    const out = await brief([epic]);

    expect(out).toContain("notes:");
    expect(out).toContain("across this epic and its children");
    expect(out).not.toContain(`katra note list ${epic}`);
  });

  it("reports an epic's own blockers, as show does", async () => {
    // Nothing forbids an epic carrying a dependency, and `brief`'s stated first
    // question is whether the thing can be started. Omitting the line answered
    // that question by silence.
    const epic = await add(["an epic", "--level", "epic"]);
    const blocker = await add(["blocks the epic"]);
    await runCli(["dep", epic, "--blocked-by", blocker], { cwd: repo.dir });

    const out = await brief([epic]);

    expect(out).toContain("blockers");
    expect(out).toContain(blocker);
    expect(out).toContain("blocks the epic");
  });

  it("qualifies an unblocked epic's blockers line rather than claiming none", async () => {
    const epic = await add(["an epic", "--level", "epic"]);

    const out = await brief([epic]);
    // The whole line, so the blocked arm's `field("blockers", …)` cannot
    // satisfy it — "none" alone would read as a claim about the children.
    expect(out).toMatch(/^ {2}blockers {4}none on the epic itself — children not checked$/m);
  });
});
