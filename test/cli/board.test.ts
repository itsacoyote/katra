import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { BoardResult } from "../../src/core/contract.js";
import { openStore } from "../../src/core/store.js";
import { BRIEF_HANDOFF_CHARS } from "../../src/core/tasks/brief.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";
import { seedClaim, seedPresence } from "../helpers/seed.js";

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
    // The section titles are not asserted: "in flight" and "ready" both appear
    // in the header string above, so those assertions would hold with every
    // section deleted. The task titles are what carry this test.
    expect(out).toContain("underway");
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

  it("clamps a section row's title to the width log allows", async () => {
    // The same field is cut at 44 in `log`; the schema puts no length on a
    // title, so an uncapped board row would make the orientation view the one
    // place a hostile title floods.
    const task = await add(["x".repeat(60)]);
    await lane(task, "In Progress");

    const out = await board();

    expect(out).toContain(`${"x".repeat(43)}…`);
    expect(out).not.toContain("x".repeat(44));
  });

  it("names the first three blockers and counts the rest", async () => {
    const stuck = await add(["cannot start"]);
    await lane(stuck, "Planned");
    const blockers: string[] = [];
    for (let i = 0; i < 5; i++) {
      const blocker = await add([`blocker ${i}`]);
      await runCli(["dep", stuck, "--blocked-by", blocker], { cwd: repo.dir });
      blockers.push(blocker);
    }

    const out = await board();

    // The row alone: the trailing blockers still appear elsewhere on the
    // board — `recent` names them in their created events.
    const row = out.split("\n").find((line) => line.includes("blocked by")) ?? "";
    expect(row).toContain(`blocked by ${blockers[0]}, ${blockers[1]}, ${blockers[2]}, +2 more`);
    expect(row).not.toContain(blockers[3] ?? "blocker 3");
    expect(row).not.toContain(blockers[4] ?? "blocker 4");
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

  it("refuses a non-numeric limit with exit 1", async () => {
    const result = await runCli(["board", "--limit", "abc"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.user);
  });

  it("refuses an unknown flag with the usage exit code", async () => {
    // ADR-009: the board takes no filters, so `--epic` must be a refusal, not
    // a silently ignored argument. 2, not 1: the invocation is malformed —
    // there is no such flag to refuse on the merits.
    const result = await runCli(["board", "--epic"], { cwd: repo.dir });
    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("applies --limit and --digest together", async () => {
    const noted = await add(["carries the handoff"]);
    await note(noted, "the handoff");
    for (let i = 0; i < 3; i++) {
      const id = await add([`task ${i}`]);
      await lane(id, "Planned");
    }

    const out = await board(["--digest", "--limit", "2"]);

    expect(out.split("\n")[0]).toContain("handoff");
    expect(out).toContain("showing 2 of 3");
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

describe("board and claims", () => {
  /**
   * Claims `id` for a worktree other than this repo's own, directly — the
   * same bypass `test/cli/claim.test.ts` and `test/cli/next.test.ts` use,
   * since seeding through the real `katra claim` would just claim it for the
   * fixture's own identity.
   */
  function claimElsewhere(id: string, branch: string): void {
    const { store } = openStore(repo.dir, {});
    try {
      seedClaim(store, {
        taskId: id,
        holder: "/elsewhere/worktree",
        actor: `${branch} @ /elsewhere/worktree`,
      });
      seedPresence(store, { worktree: "/elsewhere/worktree", branch });
    } finally {
      store.close();
    }
  }

  it("marks a claimed row with claimed by and last seen", async () => {
    const task = await add(["contested"]);
    await lane(task, "Planned");
    claimElsewhere(task, "feature/other");

    const out = await board();

    const row = out.split("\n").find((line) => line.includes(task)) ?? "";
    expect(row).toContain("claimed by feature/other");
    expect(row).toContain("last seen");
    // T4's security scan: the wording must never imply work on this task.
    expect(row).not.toContain("active on");
  });

  it("renders a claim whose holder never heartbeat", async () => {
    // No presence row at all — `bumpPresence` is deliberately non-fatal, so
    // this is a real, reachable state, not just a malformed seed.
    const task = await add(["contested"]);
    await lane(task, "Planned");
    const { store } = openStore(repo.dir, {});
    try {
      seedClaim(store, {
        taskId: task,
        holder: "/elsewhere/worktree",
        actor: "feature/other @ /elsewhere/worktree",
      });
    } finally {
      store.close();
    }

    const out = await board();

    const row = out.split("\n").find((line) => line.includes(task)) ?? "";
    // No presence row means no branch either, so the marker falls back to the
    // full frozen actor string rather than parsing it.
    expect(row).toContain("claimed by feature/other @ /elsewhere/worktree");
    expect(row).toContain("never seen");
    expect(row).not.toContain("null");
  });

  it("carries no marker on a row this worktree claimed itself", async () => {
    // ADR-012: claimed-by-me is deliberately not a marker.
    const task = await add(["mine"]);
    await lane(task, "Planned");
    const claimResult = await runCli(["claim", task], { cwd: repo.dir });
    expect(claimResult.exitCode).toBe(EXIT.ok);

    const out = await board();

    const row = out.split("\n").find((line) => line.includes(task)) ?? "";
    expect(row).not.toBe("");
    expect(row).not.toContain("claimed by");
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
    // Against the digest heading, not the whole output: `update --lane` writes
    // a `Defined -> In Review` row into recent activity, which satisfies a bare
    // `toContain("In Review")` whether or not the heading carries the lane.
    expect(out.split("\n")[0]).toMatch(new RegExp(`handoff\\s+${two}\\s+In Review`));
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
    // `close` writes a `Defined -> Done` activity row, so asserting on the whole
    // output would pass with the lane deleted from the heading entirely — which
    // is the one thing this test exists to catch.
    expect(out.split("\n")[0]).toMatch(new RegExp(`handoff\\s+${task}\\s+Done`));
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
  // Built by codepoint — an invisible literal in test source is unreviewable.
  const ALM = String.fromCharCode(0x061c);
  const LS = String.fromCharCode(0x2028);
  const ESC = "";
  const BIDI = "‮";

  it("strips ESC and bidi control characters from every rendered field", async () => {
    const task = await add([`title ${ESC}[31m${BIDI}${ALM}red${LS}end`]);
    await lane(task, "In Progress");
    await note(task, `body ${ESC}[32m${BIDI}${ALM}green${LS}split`);

    const out = await board(["--digest"]);

    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BIDI);
    // ALM is the Trojan Source mark the first bidi class missed; the line
    // separators break a row in any non-terminal renderer.
    expect(out).not.toContain(ALM);
    expect(out).not.toContain(LS);
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

describe("--limit 0 does not lie about the store", () => {
  it("does not claim the backlog is empty when everything is closed", async () => {
    // The regression a naive `recent.length === 0` sentinel produces once
    // `--limit` bounds recent: on a store whose work is all finished, the text
    // output claimed an empty backlog while --json carried the full history.
    const task = await add(["shipped work"]);
    await runCli(["close", task], { cwd: repo.dir });

    const out = await board(["--limit", "0"]);

    expect(out).not.toContain("the backlog is empty");
    expect(out).toContain("0 open");
  });

  it("still reports that activity was truncated under --limit 0", async () => {
    // The task sections can be recovered from the counts header; this one
    // cannot, so silence here is the only unrecoverable truncation on the board.
    await add(["a task"]);

    const out = await board(["--limit", "0"]);

    expect(out).toContain("recent");
    expect(out).toContain("`katra log` for the rest");
  });

  it("still leads with the digest under --limit 0", async () => {
    const task = await add(["a task"]);
    await note(task, "the handoff must survive a zero limit");

    const out = await board(["--digest", "--limit", "0"]);

    expect(out).toContain("the handoff must survive a zero limit");
  });

  it("still says the backlog is empty on a genuinely empty store", async () => {
    const result = await runCli(["board", "--limit", "0"], { cwd: repo.dir });

    expect(result.stdout).toContain("empty");
  });
});
