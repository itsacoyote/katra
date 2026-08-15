import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { RefResult } from "../../src/core/contract.js";
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

describe("katra ref add", () => {
  it("add with github PR URL prints canonical ref, exit 0", async () => {
    const task = await add(["a task"]);

    const result = await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/42"], {
      cwd: repo.dir,
    });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("acme/widgets#42");
    expect(result.stdout).toContain("linked");
  });

  it("re-add prints already linked, exit 0", async () => {
    const task = await add(["a task"]);
    const url = "https://github.com/acme/widgets/pull/43";
    await runCli(["ref", "add", task, url], { cwd: repo.dir });

    const result = await runCli(["ref", "add", task, url], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("already linked");
  });

  it("linear bare id renders without hyperlink", async () => {
    const task = await add(["a task"]);

    const result = await runCli(["ref", "add", task, "ENG-451"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("ENG-451");
    expect(result.stdout).not.toContain("http");
  });

  it("unknown URL refuses naming all three flags", async () => {
    const task = await add(["a task"]);

    const result = await runCli(
      ["ref", "add", task, "https://gitlab.com/acme/widgets/-/merge_requests/1"],
      { cwd: repo.dir },
    );

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/--provider/);
    expect(result.stderr).toMatch(/--id/);
    expect(result.stderr).toMatch(/--url/);
  });

  it("explicit-flag add stores arbitrary provider verbatim", async () => {
    const task = await add(["a task"]);

    const result = await runCli(
      ["ref", "add", task, "--provider", "gitlab", "--id", "myorg/myrepo!5", "--json"],
      { cwd: repo.dir },
    );

    expect(result.exitCode).toBe(EXIT.ok);
    const doc = result.json() as RefResult;
    expect(doc.ref.provider).toBe("gitlab");
    expect(doc.ref.externalId).toBe("myorg/myrepo!5");
    expect(doc.ref.url).toBeNull();
  });

  it("javascript: --url refuses", async () => {
    const task = await add(["a task"]);

    const result = await runCli(
      ["ref", "add", task, "--provider", "foo", "--id", "bar", "--url", "javascript:alert(1)"],
      { cwd: repo.dir },
    );

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/absolute http/);
  });

  it("refuses mixing a positional ref with explicit flags", async () => {
    const task = await add(["a task"]);

    const result = await runCli(
      ["ref", "add", task, "ENG-1", "--provider", "gitlab", "--id", "x"],
      { cwd: repo.dir },
    );

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/not both/);
  });

  it("refuses when given neither a ref nor explicit flags", async () => {
    const task = await add(["a task"]);

    const result = await runCli(["ref", "add", task], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/--provider/);
  });

  it("--json round-trips RefResult", async () => {
    const task = await add(["a task"]);
    const url = "https://github.com/acme/widgets/pull/21";

    const result = await runCli(["ref", "add", task, url, "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.json()).toEqual({
      action: "linked",
      taskId: task,
      ref: {
        provider: "github",
        externalId: "acme/widgets#21",
        url,
        cachedStatus: null,
        cachedTitle: null,
        syncedAt: null,
      },
    });
  });

  it("hostile provider/id/url (ANSI, RLO via fromCharCode) oneLined in show/brief text, verbatim in --json", async () => {
    // Bidi and zero-width characters ride through storage by design (render
    // sanitization is the defense); C0/C1 controls now refuse at
    // validateExplicitRef — covered by the refusal test below.
    const task = await add(["a task"]);
    const esc = String.fromCharCode(27);
    const rlo = String.fromCharCode(0x202e);
    const provider = "provider";
    const id = `id${rlo}here`;
    const url = `https://example.com/${rlo}x`;

    const added = await runCli(
      ["ref", "add", task, "--provider", provider, "--id", id, "--url", url, "--json"],
      { cwd: repo.dir },
    );
    expect(added.exitCode).toBe(EXIT.ok);
    const doc = added.json() as RefResult;
    // --json is verbatim, per house policy.
    expect(doc.ref.provider).toBe(provider);
    expect(doc.ref.externalId).toBe(id);
    expect(doc.ref.url).toBe(url);

    const shown = await runCli(["show", task], { cwd: repo.dir });
    expect(shown.exitCode).toBe(EXIT.ok);
    expect(shown.stdout).not.toContain(esc);
    expect(shown.stdout).not.toContain(rlo);

    const briefed = await runCli(["brief", task], { cwd: repo.dir });
    expect(briefed.exitCode).toBe(EXIT.ok);
    expect(briefed.stdout).not.toContain(esc);
    expect(briefed.stdout).not.toContain(rlo);
  });

  it("NUL-bearing --id refuses as user error, never an internal CHECK failure", async () => {
    // A NUL-leading value passes code-point bounds but SQLite's length()
    // counts pre-NUL characters only — unguarded, it surfaced as exit 4 with
    // leaked DDL text (validate round-1 finding). In-process argv carries the
    // NUL; a real shell cannot, but library callers can.
    const task = await add(["a task"]);
    const nul = String.fromCharCode(0);

    const result = await runCli(["ref", "add", task, "--provider", "p", "--id", `${nul}abc`], {
      cwd: repo.dir,
    });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/control characters/);
    expect(result.stderr).not.toContain("CHECK constraint");
  });

  it("ambiguous-remove candidate list oneLines hostile stored fields on stderr", async () => {
    // The candidates hint path in output.ts rendered verbatim until F7 — safe
    // while task-id candidates were the only producer (GLOB-constrained ids),
    // live terminal injection once ambiguous-ref candidates carry stored
    // provider/id/url. Two refs where the remove argument matches one ref's
    // url AND the other's external id force the refusal that renders both.
    // RLO, not ESC: C0/C1 controls now refuse at validateExplicitRef, but
    // bidi rides through storage by design — the sink's oneLine is still the
    // only thing between a stored RLO and the terminal.
    const task = await add(["a task"]);
    const rlo = String.fromCharCode(0x202e);
    const url = "https://github.com/acme/app/pull/99";
    const hostileProvider = `${rlo}x`;

    const first = await runCli(["ref", "add", task, url], { cwd: repo.dir });
    expect(first.exitCode).toBe(EXIT.ok);
    const second = await runCli(["ref", "add", task, "--provider", hostileProvider, "--id", url], {
      cwd: repo.dir,
    });
    expect(second.exitCode).toBe(EXIT.ok);

    const removed = await runCli(["ref", "remove", task, url], { cwd: repo.dir });
    expect(removed.exitCode).not.toBe(EXIT.ok);
    expect(removed.stderr).toContain("matches 2 refs");
    expect(removed.stderr).not.toContain(rlo);
  });

  it("refs render on an epic's show/brief", async () => {
    const epic = await add(["an epic", "--level", "epic"]);

    const added = await runCli(["ref", "add", epic, "https://github.com/acme/widgets/pull/31"], {
      cwd: repo.dir,
    });
    expect(added.exitCode).toBe(EXIT.ok);

    const shown = await runCli(["show", epic], { cwd: repo.dir });
    expect(shown.stdout).toContain("acme/widgets#31");

    const briefed = await runCli(["brief", epic], { cwd: repo.dir });
    expect(briefed.stdout).toContain("acme/widgets#31");
  });

  it("log renders ref-linked/ref-unlinked rows through the existing path (no crash, ref oneLined)", async () => {
    const task = await add(["a task"]);
    await runCli(["ref", "add", task, "https://github.com/acme/widgets/pull/9"], {
      cwd: repo.dir,
    });
    await runCli(["ref", "remove", task, "acme/widgets#9"], { cwd: repo.dir });

    const log = await runCli(["log", task], { cwd: repo.dir });

    expect(log.exitCode).toBe(EXIT.ok);
    expect(log.stdout).toContain("ref-linked");
    expect(log.stdout).toContain("ref-unlinked");
    expect(log.stdout).toContain("acme/widgets#9");
  });
});

describe("katra ref remove", () => {
  it("remove by url and by qualified id", async () => {
    const taskA = await add(["task a"]);
    const taskB = await add(["task b"]);
    const url = "https://github.com/acme/widgets/pull/11";

    await runCli(["ref", "add", taskA, url], { cwd: repo.dir });
    await runCli(["ref", "add", taskB, url], { cwd: repo.dir });

    const byUrl = await runCli(["ref", "remove", taskA, url, "--json"], { cwd: repo.dir });
    expect(byUrl.exitCode).toBe(EXIT.ok);
    expect((byUrl.json() as RefResult).action).toBe("unlinked");

    const byId = await runCli(["ref", "remove", taskB, "acme/widgets#11", "--json"], {
      cwd: repo.dir,
    });
    expect(byId.exitCode).toBe(EXIT.ok);
    expect((byId.json() as RefResult).action).toBe("unlinked");
  });

  it("numeric remove arg refuses naming both forms", async () => {
    const task = await add(["a task"]);

    const result = await runCli(["ref", "remove", task, "12345"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/url/);
    expect(result.stderr).toMatch(/qualified id/);
  });

  it("escape-hatch ref with null url removes by its id (B3 regression at CLI level)", async () => {
    const task = await add(["a task"]);

    const added = await runCli(
      ["ref", "add", task, "--provider", "gitlab", "--id", "myorg/myrepo!5", "--json"],
      { cwd: repo.dir },
    );
    expect(added.exitCode).toBe(EXIT.ok);
    expect((added.json() as RefResult).ref.url).toBeNull();

    const removed = await runCli(["ref", "remove", task, "myorg/myrepo!5", "--json"], {
      cwd: repo.dir,
    });

    expect(removed.exitCode).toBe(EXIT.ok);
    expect((removed.json() as RefResult).action).toBe("unlinked");
  });

  it("second positional never reaches task resolveId (KT-451 wiring guard)", async () => {
    const task = await add(["a task"]);
    const otherTask = await add(["another task"]);

    // A genuine task id as the second arg: if `ref remove` ever routed this
    // through resolveId/requireId (the wrong table — risk note 17), it would
    // resolve as a task rather than refuse as an unmatched ref.
    const byTaskId = await runCli(["ref", "remove", task, otherTask], { cwd: repo.dir });
    expect(byTaskId.exitCode).toBe(EXIT.user);
    expect(byTaskId.stderr).toMatch(/no ref matching/);

    // "KT-451" reads like a Linear id and is visually adjacent to a kt- task
    // id fragment (risk note 18) — it must refuse the identical way, not
    // resolve as a task lookup.
    const byLinearLookingId = await runCli(["ref", "remove", task, "KT-451"], { cwd: repo.dir });
    expect(byLinearLookingId.exitCode).toBe(EXIT.user);
    expect(byLinearLookingId.stderr).toMatch(/no ref matching/);
  });
});

describe("ref command registration", () => {
  it("registers both ref commands on the program", () => {
    // Real subcommands, not two flat commands named with a space — same
    // commander-15 trap `note.ts` documents.
    const program = createProgram({ cwd: repo.dir });
    const parent = program.commands.find((command) => command.name() === "ref");

    expect(parent).toBeDefined();
    expect(parent?.commands.map((command) => command.name()).sort()).toEqual(["add", "remove"]);
  });

  it("gives the ref subcommands their own descriptions and --json", () => {
    const program = createProgram({ cwd: repo.dir });
    const parent = program.commands.find((command) => command.name() === "ref");

    for (const child of parent?.commands ?? []) {
      expect(child.description(), `ref ${child.name()} has no description`).not.toBe("");
      expect(
        child.options.map((option) => option.long),
        `ref ${child.name()} has no --json`,
      ).toContain("--json");
    }
  });
});
