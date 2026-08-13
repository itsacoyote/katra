/**
 * `katra migrate beads` — CLI wiring (F5, T7, `katra-9aw.49.7`).
 *
 * Preview and apply are exercised through `runCli` exactly as an operator
 * would type them. The pipeline stages themselves (extract/mapping/transform/
 * load) are covered by `test/core/beads-*.test.ts`; these tests are about the
 * CLI's own contract — store handling, exit codes, `--json`, and sanitized
 * rendering — not about re-proving the transform's classification logic.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { MigrationReport } from "../../src/core/contract.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";

/** One minimal, valid bd export issue record — every field `hasValidShape` requires. */
function issueLine(overrides: Record<string, unknown> & { readonly id: string }): string {
  return JSON.stringify({
    _type: "issue",
    title: `Issue ${overrides.id}`,
    description: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: "",
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "",
    updated_at: "2026-01-01T00:00:00.000Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    ...overrides,
  });
}

/** Writes a bd export at `path` (relative to `dir`), creating parent directories as needed. */
function writeExport(dir: string, path: string, lines: readonly string[]): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, `${lines.join("\n")}\n`);
}

function storeDbPath(dir: string): string {
  return join(dir, ".git", STORE_DIR_NAME, DB_FILE_NAME);
}

let repo: GitFixture;
beforeEach(() => {
  repo = createGitRepo();
});
afterEach(() => repo.cleanup());

describe("katra migrate beads — preview", () => {
  it("previews by default without creating or opening a store", async () => {
    writeExport(repo.dir, ".beads/issues.jsonl", [issueLine({ id: "bd-1" })]);

    const result = await runCli(["migrate", "beads"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toMatch(/would import/);
    expect(result.stdout).toMatch(/preview — nothing written; run with --apply/);
    // No store file, and no store directory at all — a preview must not even
    // create the empty shell a store would otherwise occupy.
    expect(existsSync(storeDbPath(repo.dir))).toBe(false);
    expect(existsSync(join(repo.dir, ".git", STORE_DIR_NAME))).toBe(false);
  });

  it("previews against a repo that has no katra store at all", async () => {
    // No `katra init` anywhere in this test — the point is that preview works
    // whether or not a store has ever existed in this repository.
    writeExport(repo.dir, ".beads/issues.jsonl", [issueLine({ id: "bd-1" })]);

    const result = await runCli(["migrate", "beads", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json() as MigrationReport;
    expect(payload.applied).toBe(false);
    expect(payload.idMap).toEqual([{ oldId: "bd-1", newId: null }]);
  });

  it("defaults --from to .beads/issues.jsonl at the repo root", async () => {
    writeExport(repo.dir, ".beads/issues.jsonl", [issueLine({ id: "bd-default" })]);

    // No --from at all.
    const result = await runCli(["migrate", "beads", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json() as MigrationReport;
    expect(payload.idMap.map((entry) => entry.oldId)).toEqual(["bd-default"]);
  });

  it("exits 1 with not_found naming a missing --from path", async () => {
    // Deliberately no export written anywhere.
    const missing = join(repo.dir, "nowhere.jsonl");

    const result = await runCli(["migrate", "beads", "--from", missing], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toContain(missing);
    expect(result.stderr).toMatch(/bd export/);
  });

  it("sanitizes report lines built from export content", async () => {
    // A hostile title carrying a raw ANSI escape (ESC) and a bell (BEL), and a
    // hostile *id* carrying an ESC plus an embedded newline. Ids are export
    // content too, not minted ids — a raw oldId is both a terminal
    // escape-injection vector on its own and, via the embedded newline, a way
    // to forge an extra physical line that impersonates a benign report line
    // (the surface a human reads before ever deciding to run --apply).
    // String.fromCharCode, not a literal or \n escape sequence spliced next to
    // one, so nothing resembling a real control character sits in this file's
    // own source.
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const hostileTitle = ["Evil", esc, "[31mTitle", bel].join("");
    const hostileId = ["bd-hostile", esc, "[31m", "\ninjected: forged summary line"].join("");
    writeExport(repo.dir, ".beads/issues.jsonl", [
      issueLine({ id: hostileId, title: hostileTitle, owner: "legacy-owner" }),
    ]);

    const result = await runCli(["migrate", "beads"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("bd-hostile");
    expect(result.stdout.includes(esc)).toBe(false);
    expect(result.stdout.includes(bel)).toBe(false);

    // The forgery half: this fixture produces exactly one degrade section
    // (the hostile owner), so a correctly sanitized report is exactly three
    // blocks — the summary line, a "dropped: owner" section (its own header
    // line plus one item line), and the closing line — six physical lines
    // once the blank block-separator lines are counted. An unsanitized id's
    // embedded newline would inject a seventh line that reads as legitimate
    // report output but is actually forged from export content.
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(6);
  });
});

describe("katra migrate beads --apply", () => {
  it("applies with --apply and reports applied: true with a populated id map", async () => {
    await runCli(["init"], { cwd: repo.dir });
    writeExport(repo.dir, ".beads/issues.jsonl", [issueLine({ id: "bd-1" })]);

    const result = await runCli(["migrate", "beads", "--apply", "--json"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.ok);
    const payload = result.json() as MigrationReport;
    expect(payload.applied).toBe(true);
    expect(payload.idMap).toHaveLength(1);
    expect(payload.idMap[0]?.oldId).toBe("bd-1");
    expect(payload.idMap[0]?.newId).toMatch(/^kt-/);
  });

  it("emits the same MigrationReport shape as JSON in both modes", async () => {
    writeExport(repo.dir, ".beads/issues.jsonl", [issueLine({ id: "bd-1" })]);

    const preview = await runCli(["migrate", "beads", "--json"], { cwd: repo.dir });
    await runCli(["init"], { cwd: repo.dir });
    const applied = await runCli(["migrate", "beads", "--apply", "--json"], { cwd: repo.dir });

    const previewKeys = Object.keys(preview.json() as object).sort();
    const appliedKeys = Object.keys(applied.json() as object).sort();
    expect(appliedKeys).toEqual(previewKeys);
  });

  it("exits 3 when --apply meets a non-empty store", async () => {
    await runCli(["init"], { cwd: repo.dir });
    await runCli(["add", "already here"], { cwd: repo.dir });
    writeExport(repo.dir, ".beads/issues.jsonl", [issueLine({ id: "bd-1" })]);

    const result = await runCli(["migrate", "beads", "--apply"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.conflict);
  });

  it("tells the operator to run katra init when applying with no store", async () => {
    // No `katra init` at all.
    writeExport(repo.dir, ".beads/issues.jsonl", [issueLine({ id: "bd-1" })]);

    const result = await runCli(["migrate", "beads", "--apply"], { cwd: repo.dir });

    expect(result.exitCode).toBe(EXIT.user);
    expect(result.stderr).toMatch(/katra init/);
  });
});
