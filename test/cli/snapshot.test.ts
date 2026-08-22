/**
 * `katra snapshot` — the F10 T2 vertical slice: export.ts's real store→file
 * write, through the real CLI end to end.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { SnapshotResult } from "../../src/core/contract.js";
import { MIGRATIONS } from "../../src/core/db/migrations/index.js";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/core/snapshot/types.js";
import { runCli } from "../helpers/cli.js";
import { seedTask } from "../helpers/seed.js";
import { createStoreFixture } from "../helpers/store.js";

/**
 * A single toggle, not `vi.spyOn` — Vitest cannot redefine a property on a
 * real ESM module's namespace object (Node's own "node:fs", frozen and
 * non-configurable), only replace the whole module via `vi.mock`, which is
 * hoisted once for this file. Every other `node:fs` function passes straight
 * through to the real implementation; only `renameSync` is interceptable,
 * and only while `renameShouldFail` is true — off by default so every other
 * test in this file (and every helper it calls: `createStoreFixture`,
 * `runCli`, `mkdirSync` above) sees the genuine filesystem.
 */
let renameShouldFail = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameShouldFail) throw new Error("simulated rename failure");
      return actual.renameSync(...args);
    },
  };
});

/** The full migration chain's own target version — independent of readSchemaVersion, the same value the header line must carry. */
const CURRENT_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

/** Splits snapshot content into its lines, dropping the trailing empty string `split` leaves after the file's pinned trailing newline. */
function linesOf(content: string): string[] {
  const parts = content.split("\n");
  expect(parts.at(-1)).toBe("");
  return parts.slice(0, -1);
}

describe("katra snapshot", () => {
  it("snapshot writes the pinned header and every table's rows in canonical order", async () => {
    const fixture = createStoreFixture();
    try {
      // Inserted in descending id order, so the file's ascending order proves
      // canonical (primary-key) ordering rather than insertion order.
      seedTask(fixture.store, { id: "kt-s00002", title: "second by id" });
      seedTask(fixture.store, { id: "kt-s00001", title: "first by id" });

      const outPath = join(fixture.repo.dir, "snap.jsonl");
      const result = await runCli(["snapshot", "--out", outPath], { cwd: fixture.repo.dir });

      expect(result.exitCode).toBe(0);
      const lines = linesOf(readFileSync(outPath, "utf8"));

      const header = JSON.parse(lines[0] ?? "");
      expect(header).toEqual({
        format: "katra-snapshot",
        formatVersion: SNAPSHOT_FORMAT_VERSION,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });

      // tasks is SNAPSHOT_TABLES' first table, and this fixture has exactly
      // two rows and nothing else ahead of them.
      const taskIds = lines
        .slice(1, 3)
        .map((line) => (JSON.parse(line) as { readonly id: string }).id);
      expect(taskIds).toEqual(["kt-s00001", "kt-s00002"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("an unchanged store snapshots to a byte-identical file", async () => {
    const fixture = createStoreFixture();
    try {
      // Interleaved insertion order: without the ORDER BY this test's own
      // mutation proof drops, a plain table scan would very likely still
      // reproduce identical bytes across two runs of an untouched table
      // (SQLite's rowid order is stable), so determinism alone would not
      // catch a missing ORDER BY. The canonical-order assertion below is
      // what actually depends on it.
      seedTask(fixture.store, { id: "kt-s00003" });
      seedTask(fixture.store, { id: "kt-s00001" });
      seedTask(fixture.store, { id: "kt-s00002" });

      const outPath = join(fixture.repo.dir, "snap.jsonl");
      const first = await runCli(["snapshot", "--out", outPath], { cwd: fixture.repo.dir });
      expect(first.exitCode).toBe(0);
      const firstContent = readFileSync(outPath, "utf8");

      const second = await runCli(["snapshot", "--out", outPath], { cwd: fixture.repo.dir });
      expect(second.exitCode).toBe(0);
      const secondContent = readFileSync(outPath, "utf8");

      expect(secondContent).toBe(firstContent);

      const taskIds = linesOf(firstContent)
        .slice(1, 4)
        .map((line) => (JSON.parse(line) as { readonly id: string }).id);
      expect(taskIds).toEqual(["kt-s00001", "kt-s00002", "kt-s00003"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("a store change produces a one-line diff in the changed table", async () => {
    const fixture = createStoreFixture();
    try {
      seedTask(fixture.store, { id: "kt-s00001" });
      seedTask(fixture.store, { id: "kt-s00003" });

      const outPath = join(fixture.repo.dir, "snap.jsonl");
      await runCli(["snapshot", "--out", outPath], { cwd: fixture.repo.dir });
      const before = linesOf(readFileSync(outPath, "utf8"));

      // Sorts between the two existing tasks, so it lands as one new line in
      // the middle of the tasks section — not at an edge a coincidental
      // match could hide behind.
      seedTask(fixture.store, { id: "kt-s00002" });

      await runCli(["snapshot", "--out", outPath], { cwd: fixture.repo.dir });
      const after = linesOf(readFileSync(outPath, "utf8"));

      expect(after.length).toBe(before.length + 1);
      const afterWithoutNewLine = after.filter((line) => !line.includes("kt-s00002"));
      expect(afterWithoutNewLine).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("the default path resolves to the worktree toplevel from a subdirectory", async () => {
    const fixture = createStoreFixture();
    try {
      seedTask(fixture.store, {});
      const subdir = join(fixture.repo.dir, "sub", "deeper");
      mkdirSync(subdir, { recursive: true });

      const result = await runCli(["snapshot", "--json"], { cwd: subdir });

      expect(result.exitCode).toBe(0);
      const document = result.json() as SnapshotResult;
      const expectedPath = join(fixture.repo.dir, ".katra", "snapshot.jsonl");
      expect(document.path).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("--out resolves relative paths against the invoking cwd", async () => {
    const fixture = createStoreFixture();
    try {
      seedTask(fixture.store, {});
      const subdir = join(fixture.repo.dir, "sub");
      mkdirSync(subdir, { recursive: true });

      const result = await runCli(["snapshot", "--out", "rel-snap.jsonl", "--json"], {
        cwd: subdir,
      });

      expect(result.exitCode).toBe(0);
      const document = result.json() as SnapshotResult;
      const expectedPath = join(subdir, "rel-snap.jsonl");
      expect(document.path).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("a failed write leaves the previous snapshot intact (temp+rename)", async () => {
    const fixture = createStoreFixture();
    try {
      seedTask(fixture.store, { id: "kt-s00001" });
      const outPath = join(fixture.repo.dir, "snap.jsonl");

      const first = await runCli(["snapshot", "--out", outPath], { cwd: fixture.repo.dir });
      expect(first.exitCode).toBe(0);
      const originalContent = readFileSync(outPath, "utf8");

      // A real store change, so a successful second snapshot would produce
      // genuinely different bytes at the target — only the write's own
      // atomicity is what can keep them from landing there.
      seedTask(fixture.store, { id: "kt-s00002" });

      // Forces the rename step specifically to fail, after any write to a
      // temp file has already completed. A direct-write implementation has
      // no rename call for this to intercept at all, so this is the mutation
      // surface that actually distinguishes "temp file, then rename" from
      // "write straight to the target": mutate writeAtomic into a bare
      // writeFileSync(outPath, ...) and this stops mattering — the second
      // snapshot's bytes would land directly at outPath despite the
      // injected failure never firing.
      renameShouldFail = true;
      let second: Awaited<ReturnType<typeof runCli>>;
      try {
        second = await runCli(["snapshot", "--out", outPath], { cwd: fixture.repo.dir });
      } finally {
        renameShouldFail = false;
      }

      // A raw filesystem failure, not a KatraException — ADR-005's fault
      // code, not a refusal.
      expect(second.exitCode).toBe(EXIT.internal);

      const afterContent = readFileSync(outPath, "utf8");
      expect(afterContent).toBe(originalContent);

      const strays = readdirSync(fixture.repo.dir).filter((name) =>
        name.includes(".snap.jsonl.tmp-"),
      );
      expect(strays).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("--json mirrors the text counts", async () => {
    const fixture = createStoreFixture();
    try {
      seedTask(fixture.store, {});
      seedTask(fixture.store, {});

      const outPath = join(fixture.repo.dir, "snap.jsonl");
      const jsonRun = await runCli(["snapshot", "--out", outPath, "--json"], {
        cwd: fixture.repo.dir,
      });
      expect(jsonRun.exitCode).toBe(0);
      const document = jsonRun.json() as SnapshotResult;

      const textRun = await runCli(["snapshot", "--out", outPath], { cwd: fixture.repo.dir });
      expect(textRun.exitCode).toBe(0);

      for (const entry of document.tables) {
        expect(textRun.stdout).toContain(`${entry.table}: ${String(entry.count)}`);
      }
      expect(textRun.stdout).toContain(`schema v${String(document.schemaVersion)}`);
    } finally {
      fixture.cleanup();
    }
  });
});
