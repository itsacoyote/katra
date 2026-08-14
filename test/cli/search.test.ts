import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import type { SearchResult } from "../../src/core/contract.js";
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
  const result = await runCli(["note", "add", id, "--body-file", "-"], {
    cwd: repo.dir,
    stdin: body,
  });
  expect(result.exitCode).toBe(EXIT.ok);
}

describe("katra search", () => {
  it("is registered on the program", () => {
    const names = createProgram({ cwd: repo.dir }).commands.map((command) => command.name());
    expect(names).toContain("search");
  });

  it("searches, renders ranked rows and emits the documented JSON", async () => {
    const byTitle = await add(["zephyrus mentioned in the title"]);
    const byNote = await add(["a task with an unrelated title"]);
    await note(byNote, "zephyrus mentioned only in a handoff note");

    const text = await runCli(["search", "zephyrus"], { cwd: repo.dir });
    expect(text.exitCode).toBe(EXIT.ok);
    // The tier rule (search.ts's docs): a task's own text hit always outranks
    // a note-only hit, regardless of bm25 magnitude — a deterministic
    // ordering to assert on, not a bm25 coincidence.
    const rows = text.stdout.split("\n").filter((line) => line.startsWith("kt-"));
    expect(rows[0]).toContain(byTitle);
    expect(rows[1]).toContain(byNote);
    expect(text.stdout).toContain("note match —");

    const jsonResult = await runCli(["search", "zephyrus", "--json"], { cwd: repo.dir });
    expect(jsonResult.exitCode).toBe(EXIT.ok);
    expect(jsonResult.stderr).toBe("");
    const document = jsonResult.json() as SearchResult;
    expect(document.query).toBe("zephyrus");
    expect(document.hits.map((hit) => hit.id)).toEqual([byTitle, byNote]);
    expect(document.hits[0]?.matchedIn).toBe("task");
    expect(document.hits[1]?.matchedIn).toBe("note");
    expect(typeof document.hits[0]?.score).toBe("number");
    expect(document.hits[0]?.snippet).not.toBeNull();
    expect(document.truncated).toBe(false);
  });

  it("exits usage when neither query nor filters are given", async () => {
    const bare = await runCli(["search"], { cwd: repo.dir });
    expect(bare.exitCode).toBe(EXIT.usage);
    expect(bare.stderr).toMatch(/--lane/);

    // Neither half alone is the refusal: a filter with no text is a
    // legitimate filter-only search (spec req 5).
    const filterOnly = await runCli(["search", "--lane", "Defined"], { cwd: repo.dir });
    expect(filterOnly.exitCode).toBe(EXIT.ok);
  });

  it("returns zero hits, not an error, for punctuation-only queries", async () => {
    await add(["an ordinary task"]);

    const text = await runCli(["search", "!!!"], { cwd: repo.dir });
    expect(text.exitCode).toBe(EXIT.ok);
    expect(text.stdout).toContain("no matches for !!!");

    const document = (
      await runCli(["search", "!!!", "--json"], { cwd: repo.dir })
    ).json() as SearchResult;
    expect(document.hits).toEqual([]);

    // The query itself is stored, untrusted input, and the "no matches for
    // <query>" line echoes it straight back — that echo has to go through
    // the same oneLine discipline as every other rendered field, not just
    // titles and snippets.
    const ESC = String.fromCharCode(0x1b);
    const BIDI = String.fromCharCode(0x202e);
    const hostileQuery = `${ESC}[31m${BIDI}gibberish123`;

    const hostile = await runCli(["search", hostileQuery], { cwd: repo.dir });
    expect(hostile.exitCode).toBe(EXIT.ok);
    expect(hostile.stdout).toContain("no matches for");
    expect(hostile.stdout).not.toContain(ESC);
    expect(hostile.stdout).not.toContain(BIDI);
    expect(hostile.stdout).toContain("gibberish123");
  });

  it("bounds a giant single-token note body to a fixed-width snippet line", async () => {
    // FTS5's own excerpt cap (`SNIPPET_MAX_TOKENS`, search.ts) is by token
    // count, not character count — a note body that is one unbroken run of
    // word characters is still "one token", so `snippet()` returns the whole
    // thing verbatim (probe-verified: a 2000-character single token comes
    // back as a 2010-character snippet, brackets included).
    const task = await add(["a task with a giant note"]);
    await note(task, `zephyrus${"x".repeat(2000)}`);

    const text = await runCli(["search", "zephyrus"], { cwd: repo.dir });

    expect(text.exitCode).toBe(EXIT.ok);
    const snippetLine = text.stdout.split("\n").find((line) => line.includes("note match —"));
    expect(snippetLine).toBeDefined();
    expect(snippetLine?.length).toBeLessThan(250);
    expect(snippetLine).toContain("…");
    expect(snippetLine).toContain("zephyrus");

    const document = (
      await runCli(["search", "zephyrus", "--json"], { cwd: repo.dir })
    ).json() as SearchResult;
    const hit = document.hits.find((candidate) => candidate.id === task);
    // --json stays verbatim — the clamp is a render concern only.
    expect(hit?.snippet?.length).toBeGreaterThan(1000);
  });

  it("sanitizes hostile stored titles and snippets in search output", async () => {
    // Built by codepoint — an invisible literal in test source is unreviewable
    // (board.test.ts's precedent).
    const ESC = "";
    const ALM = String.fromCharCode(0x061c);
    const LS = String.fromCharCode(0x2028);
    const BIDI = "‮";
    const title = `zephyrus ${ESC}[31m${BIDI}${ALM}${LS}hostile`;

    const task = await add([title]);

    const text = await runCli(["search", "zephyrus"], { cwd: repo.dir });

    expect(text.exitCode).toBe(EXIT.ok);
    expect(text.stdout).not.toContain(ESC);
    expect(text.stdout).not.toContain(BIDI);
    expect(text.stdout).not.toContain(ALM);
    expect(text.stdout).not.toContain(LS);
    // The substance survives — this is sanitization, not mangling.
    expect(text.stdout).toContain("zephyrus");
    expect(text.stdout).toContain("hostile");

    const document = (
      await runCli(["search", "zephyrus", "--json"], { cwd: repo.dir })
    ).json() as SearchResult;
    const hit = document.hits.find((candidate) => candidate.id === task);
    // --json carries the stored bytes verbatim — sanitization is a render
    // concern only (search.ts's docs; SearchHit.snippet's docs).
    expect(hit?.title).toBe(title);
  });

  it("accepts relative and ISO forms on every time flag and refuses garbage naming the forms", async () => {
    await add(["a task"]);

    const accepted: Array<readonly string[]> = [
      ["search", "--lane", "Defined", "--updated-before", "2w"],
      ["search", "--lane", "Defined", "--updated-after", "2020-01-01"],
      ["stale", "--older-than", "3d"],
      ["stale", "--older-than", "2026-01-01T00:00:00.000Z"],
    ];
    for (const args of accepted) {
      const result = await runCli(args, { cwd: repo.dir });
      expect(result.exitCode, args.join(" ")).toBe(EXIT.ok);
    }

    const refused: Array<{ args: readonly string[]; flag: string }> = [
      {
        args: ["search", "--lane", "Defined", "--updated-before", "nonsense"],
        flag: "--updated-before",
      },
      {
        args: ["search", "--lane", "Defined", "--updated-after", "2weeks"],
        flag: "--updated-after",
      },
      { args: ["stale", "--older-than", "nonsense"], flag: "--older-than" },
    ];
    for (const { args, flag } of refused) {
      const result = await runCli(args, { cwd: repo.dir });
      expect(result.exitCode, args.join(" ")).toBe(EXIT.user);
      expect(result.stderr).toContain(flag);
      expect(result.stderr).toMatch(/relative duration|absolute timestamp/);
    }
  });

  it("refuses a negative --limit before the over-fetch math sees it, across search, recent and stale", async () => {
    // T5 senior review LOW-2: `narrowCount` already refuses any negative
    // candidate (candidate >= 0), which is the actual root cause of the
    // probed bug (`--limit -3` silently returned 2 hits, truncated: true) —
    // SQLite's own `LIMIT -2` means "unbounded", and a negative `Array.slice`
    // end then cuts from the wrong side entirely. Reusing `narrowCount`
    // exactly as `list`/`board` already do closes it; `--limit 0` stays a
    // real, legitimate zero (board.ts's own precedent), so this only checks
    // the negative case.
    const negative: Array<readonly string[]> = [
      ["search", "--lane", "Defined", "--limit", "-3"],
      ["recent", "--limit", "-3"],
      ["stale", "--limit", "-3"],
    ];
    for (const args of negative) {
      const result = await runCli(args, { cwd: repo.dir });
      expect(result.exitCode, args.join(" ")).toBe(EXIT.user);
    }
  });
});
