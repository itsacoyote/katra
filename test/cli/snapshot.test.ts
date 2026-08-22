/**
 * `katra snapshot` / `katra restore` — the F10 T2/T4 vertical slices:
 * export.ts's real store→file write and restoreSnapshot's real file→store
 * rebuild, both through the real CLI end to end.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { RestoreResult, SnapshotResult } from "../../src/core/contract.js";
import { openDatabase } from "../../src/core/db/connection.js";
import { MIGRATIONS } from "../../src/core/db/migrations/index.js";
import { PRESENCE_FRESH_MS } from "../../src/core/presence.js";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/core/snapshot/types.js";
import { runCli } from "../helpers/cli.js";
import { seedTask } from "../helpers/seed.js";
import { createStoreFixture, OTHER_IDENTITY, openAs } from "../helpers/store.js";

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

      // Ages every presence row well past PRESENCE_FRESH_MS before the
      // second run — the exact condition ADR-017's amendment names: the
      // second `katra snapshot` invocation's own `openStore` call rewrites
      // `last_seen` to a fresh timestamp for a row this stale (`presence.ts`'s
      // `bumpPresence`), which is precisely what made byte-identity false
      // before presence was excluded from SNAPSHOT_TABLES. With the
      // exclusion in place this assertion stays green; reverting the
      // exclusion (temporarily dropping "presence" back into
      // SNAPSHOT_TABLES) turns it red on a presence-line diff — that's the
      // whole point of aging the row here rather than leaving presence
      // untouched, which would pass either way and prove nothing.
      const staleTimestamp = new Date(Date.now() - PRESENCE_FRESH_MS * 2).toISOString();
      fixture.store.db.prepare("UPDATE presence SET last_seen = ?").run(staleTimestamp);

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

  it("sweeps a stranded temp file but leaves a concurrent writer's alone", async () => {
    const fixture = createStoreFixture();
    try {
      seedTask(fixture.store, {});
      const outPath = join(fixture.repo.dir, "snap.jsonl");
      const tempPrefix = `.${basename(outPath)}.tmp-`;

      const strandedPath = join(fixture.repo.dir, `${tempPrefix}stranded`);
      const freshPath = join(fixture.repo.dir, `${tempPrefix}fresh`);
      writeFileSync(strandedPath, "stranded", "utf8");
      writeFileSync(freshPath, "fresh", "utf8");

      // Ages the stranded file two hours past its creation — well past
      // STALE_TEMP_AGE_MS (1h), old enough that no real snapshot write could
      // still be in flight. The fresh file is left at its just-created
      // mtime, standing in for a concurrent writer's own temp file mid-write
      // — the exact file a name-only sweep would have unlinked out from
      // under that writer, stranding its own renameSync on ENOENT.
      const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(strandedPath, staleTime, staleTime);

      const result = await runCli(["snapshot", "--out", outPath], { cwd: fixture.repo.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(strandedPath)).toBe(false);
      expect(existsSync(freshPath)).toBe(true);
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

describe("katra restore", () => {
  it("restore preview reports versions, per-table counts, and other worktrees' presence without swapping", async () => {
    const fixture = createStoreFixture();
    try {
      seedTask(fixture.store, { id: "kt-s00001", title: "first" });

      // A second worktree present, bumping its own presence row — the
      // "informed consent" a later forced swap's preview exists to give.
      const other = openAs(fixture.repo.dir, OTHER_IDENTITY);
      other.close();

      const snapPath = join(fixture.repo.dir, "snap.jsonl");
      const snap = await runCli(["snapshot", "--out", snapPath], { cwd: fixture.repo.dir });
      expect(snap.exitCode).toBe(0);

      // The live store changes after the snapshot was taken, so snapshot
      // and live counts genuinely disagree — proving both sides are read
      // independently, not one echoing the other.
      seedTask(fixture.store, { id: "kt-s00002", title: "added after the snapshot" });

      const dbPath = fixture.store.dbPath;
      const tasksBefore = fixture.store.db.prepare("SELECT COUNT(*) c FROM tasks").get();

      const preview = await runCli(["restore", snapPath, "--json"], { cwd: fixture.repo.dir });
      expect(preview.exitCode).toBe(0);
      const document = preview.json() as RestoreResult;

      expect(document.applied).toBe(false);
      if (document.applied) throw new Error("unreachable");
      expect(document.fromSchemaVersion).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
      expect(document.toSchemaVersion).toBe(document.fromSchemaVersion);

      const tasksEntry = document.tables.find((entry) => entry.table === "tasks");
      expect(tasksEntry).toEqual({ table: "tasks", snapshot: 1, live: 2 });

      // At least the deliberate other worktree — `createStoreFixture` itself
      // opens once under its own fixed identity, which also legitimately
      // counts as "another worktree" from the real CLI identity `runCli`
      // resolves for `fixture.repo.dir`, so this asserts presence rather
      // than an exact count coupled to that fixture-internal detail.
      expect(
        document.otherWorktrees.some(
          (w) => w.worktree === OTHER_IDENTITY.worktree && w.branch === OTHER_IDENTITY.branch(),
        ),
      ).toBe(true);
      // Never the caller's own (real) worktree.
      expect(document.otherWorktrees.some((w) => w.worktree === fixture.repo.dir)).toBe(false);

      // No swap: targeted reads, not mtime/byte-compare — the live store's
      // own row count is exactly what it was right before the preview ran.
      expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM tasks").get()).toEqual(tasksBefore);
      expect(existsSync(`${dbPath}.tmp-restore`)).toBe(false);
      expect(existsSync(`${dbPath}.bak`)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("--apply refuses a store holding only surviving events without --force", async () => {
    const fixture = createStoreFixture();
    try {
      const snapPath = join(fixture.repo.dir, "snap.jsonl");
      const snap = await runCli(["snapshot", "--out", snapPath], { cwd: fixture.repo.dir });
      expect(snap.exitCode).toBe(0);

      // The katra-9aw.52 scenario, made real: a task created then deleted
      // leaves zero rows in `tasks`, but its `created`/`deleted` events
      // outlive it (ADR-008 — events carry no foreign key to the task they
      // describe), so the store is not actually empty.
      const added = await runCli(["add", "will be deleted"], { cwd: fixture.repo.dir });
      expect(added.exitCode).toBe(0);
      const taskId = added.stdout.trim();
      const deleted = await runCli(["delete", taskId, "--force"], { cwd: fixture.repo.dir });
      expect(deleted.exitCode).toBe(0);

      const tasksLeft = fixture.store.db.prepare("SELECT COUNT(*) c FROM tasks").get() as {
        c: number;
      };
      const eventsLeft = fixture.store.db.prepare("SELECT COUNT(*) c FROM events").get() as {
        c: number;
      };
      expect(tasksLeft.c).toBe(0);
      expect(eventsLeft.c).toBeGreaterThan(0);

      const result = await runCli(["restore", snapPath, "--apply"], { cwd: fixture.repo.dir });

      expect(result.exitCode).toBe(EXIT.conflict);
      expect(result.stderr).toContain("already holds data");
      expect(result.stderr).toContain("--force");

      // Refused before touching anything.
      const dbPath = fixture.store.dbPath;
      expect(existsSync(`${dbPath}.tmp-restore`)).toBe(false);
      expect(existsSync(`${dbPath}.bak`)).toBe(false);
      expect(fixture.store.db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual(eventsLeft);
    } finally {
      fixture.cleanup();
    }
  });

  it("--apply proceeds on a fresh-init store without --force", async () => {
    const source = createStoreFixture();
    const target = createStoreFixture();
    try {
      seedTask(source.store, { id: "kt-s00001", title: "from the source store" });
      const snapPath = join(source.repo.dir, "snap.jsonl");
      const snap = await runCli(["snapshot", "--out", snapPath], { cwd: source.repo.dir });
      expect(snap.exitCode).toBe(0);

      // A fresh-init target: presence only, nothing in any of the nine
      // source-of-truth tables.
      const result = await runCli(["restore", snapPath, "--apply"], { cwd: target.repo.dir });

      expect(result.exitCode).toBe(0);

      // A fresh connection, not target.store's own: the swap renamed the
      // file out from under that handle's still-open file descriptor, which
      // keeps reading the pre-swap (now-.bak) data rather than the new file
      // now sitting at the same path.
      const restored = openDatabase(target.store.dbPath);
      try {
        expect(restored.prepare("SELECT title FROM tasks WHERE id = 'kt-s00001'").get()).toEqual({
          title: "from the source store",
        });
      } finally {
        restored.close();
      }
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it("--apply --force swaps, keeps the previous store as .bak, and the restored board answers", async () => {
    const fixture = createStoreFixture();
    const source = createStoreFixture();
    try {
      seedTask(fixture.store, { id: "kt-orig01", title: "original, pre-restore" });
      const dbPath = fixture.store.dbPath;

      seedTask(source.store, { id: "kt-s00001", title: "restored task" });
      const snapPath = join(fixture.repo.dir, "snap.jsonl");
      const snap = await runCli(["snapshot", "--out", snapPath], { cwd: source.repo.dir });
      expect(snap.exitCode).toBe(0);

      const result = await runCli(["restore", snapPath, "--apply", "--force", "--json"], {
        cwd: fixture.repo.dir,
      });
      expect(result.exitCode).toBe(0);
      const document = result.json() as RestoreResult;

      expect(document.applied).toBe(true);
      if (!document.applied) throw new Error("unreachable");
      expect(document.bakPath).toBe(`${dbPath}.bak`);
      const tasksEntry = document.tables.find((entry) => entry.table === "tasks");
      expect(tasksEntry).toEqual({ table: "tasks", count: 1 });

      // .bak is a real SQLite file (a rename, not a snapshot), so it is
      // read directly — genuinely holding the pre-restore data.
      expect(existsSync(document.bakPath)).toBe(true);
      const bak = openDatabase(document.bakPath);
      try {
        expect(bak.prepare("SELECT title FROM tasks WHERE id = 'kt-orig01'").get()).toEqual({
          title: "original, pre-restore",
        });
      } finally {
        bak.close();
      }

      // The restored store is genuinely operational post-swap: board still
      // answers successfully...
      const board = await runCli(["board"], { cwd: fixture.repo.dir });
      expect(board.exitCode).toBe(0);

      // ...and holds the new content, not the old — checked precisely via
      // list, since board's own text is summary counts and never prints an
      // individual title.
      const list = await runCli(["list", "--json"], { cwd: fixture.repo.dir });
      expect(list.exitCode).toBe(0);
      const tasks = (list.json() as { tasks: ReadonlyArray<{ title: string }> }).tasks;
      expect(tasks.map((t) => t.title)).toEqual(["restored task"]);
    } finally {
      fixture.cleanup();
      source.cleanup();
    }
  });

  it("a missing file refuses not_found with restore's own wording; a directory refuses with a typed validation error", async () => {
    const fixture = createStoreFixture();
    try {
      const missingPath = join(fixture.repo.dir, "nope.jsonl");
      const missing = await runCli(["restore", missingPath], { cwd: fixture.repo.dir });

      expect(missing.exitCode).toBe(EXIT.user);
      // restore's own wording (r2 HIGH): never beads'/--from's.
      expect(missing.stderr).toContain("katra snapshot");
      expect(missing.stderr).not.toContain("bd export");
      expect(missing.stderr).not.toContain("--from");

      const dirPath = join(fixture.repo.dir, "a-directory");
      mkdirSync(dirPath);
      const directory = await runCli(["restore", dirPath], { cwd: fixture.repo.dir });

      expect(directory.exitCode).toBe(EXIT.user);
      expect(directory.stderr).toContain("not a regular file");
      expect(directory.stderr).toContain("the snapshot file");
      expect(directory.stderr).not.toContain("--from");
    } finally {
      fixture.cleanup();
    }
  });

  it("--json mirrors preview and apply", async () => {
    const source = createStoreFixture();
    try {
      seedTask(source.store, { id: "kt-s00001", title: "mirrored" });
      const snapPath = join(source.repo.dir, "snap.jsonl");
      const snap = await runCli(["snapshot", "--out", snapPath], { cwd: source.repo.dir });
      expect(snap.exitCode).toBe(0);

      // Preview: --json and text against the same store, which a preview
      // never changes, so running it twice is safe.
      const previewJson = await runCli(["restore", snapPath, "--json"], {
        cwd: source.repo.dir,
      });
      expect(previewJson.exitCode).toBe(0);
      const previewDocument = previewJson.json() as RestoreResult;
      if (previewDocument.applied) throw new Error("unreachable");

      const previewText = await runCli(["restore", snapPath], { cwd: source.repo.dir });
      expect(previewText.exitCode).toBe(0);
      for (const entry of previewDocument.tables) {
        expect(previewText.stdout).toContain(
          `${entry.table}: ${String(entry.snapshot)} (snapshot) vs ${String(entry.live)} (live)`,
        );
      }
      expect(previewText.stdout).toContain(`v${String(previewDocument.fromSchemaVersion)}`);

      // Apply: --json and text each against their own fresh-init target, so
      // neither needs --force and neither's swap affects the other.
      const jsonTarget = createStoreFixture();
      const textTarget = createStoreFixture();
      try {
        const applyJson = await runCli(["restore", snapPath, "--apply", "--json"], {
          cwd: jsonTarget.repo.dir,
        });
        expect(applyJson.exitCode).toBe(0);
        const applyDocument = applyJson.json() as RestoreResult;
        if (!applyDocument.applied) throw new Error("unreachable");

        const applyText = await runCli(["restore", snapPath, "--apply"], {
          cwd: textTarget.repo.dir,
        });
        expect(applyText.exitCode).toBe(0);
        for (const entry of applyDocument.tables) {
          expect(applyText.stdout).toContain(`${entry.table}: ${String(entry.count)}`);
        }
        // Its own target's .bak, not jsonTarget's — two separate stores.
        expect(applyText.stdout).toContain(`${textTarget.store.dbPath}.bak`);
      } finally {
        jsonTarget.cleanup();
        textTarget.cleanup();
      }
    } finally {
      source.cleanup();
    }
  });
});
