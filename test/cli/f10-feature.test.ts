/**
 * F10's epic-level acceptance criteria (T5) — the five ACs no single T2/T4
 * unit test owns end to end, proven through the real CLI, one store per test.
 * `test/cli/snapshot.test.ts` pins each behavior in isolation; this file's job
 * is the epic's own AC wording, following the fN-feature register.
 *
 * AC1's no-state-change and AC3's preview-purity proofs are targeted direct DB
 * reads, never a byte-compare or a writeTx spy: the presence heartbeat
 * `openStore` bumps on every command is the standing, documented exception
 * (epic Goals as amended), and neither technique could tell it from a real
 * write. Snapshots deliberately exclude presence, so a snapshot's own
 * byte-identity survives the heartbeat.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/output.js";
import type { RestoreResult, SnapshotResult } from "../../src/core/contract.js";
import { openDatabase } from "../../src/core/db/connection.js";
import { DB_FILE_NAME, STORE_DIR_NAME } from "../../src/core/db/locate.js";
import { MIGRATIONS } from "../../src/core/db/migrations/index.js";
import { SNAPSHOT_TABLES } from "../../src/core/enums.js";
import { PRESENCE_FRESH_MS } from "../../src/core/presence.js";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/core/snapshot/types.js";
import { openStore } from "../../src/core/store.js";
import { runCli } from "../helpers/cli.js";
import type { GitFixture } from "../helpers/fixture.js";
import { createGitRepo } from "../helpers/fixture.js";
import { seedClaim, seedDep, seedEpic, seedLink, seedNote, seedTask } from "../helpers/seed.js";

const CURRENT_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));
const V5_FIXTURE = join(process.cwd(), "test/fixtures/snapshot-v5.jsonl");

let repo: GitFixture;
beforeEach(async () => {
  repo = createGitRepo();
  await runCli(["init"], { cwd: repo.dir });
});
afterEach(() => repo.cleanup());

function dbPathOf(dir: string): string {
  return `${dir}/.git/${STORE_DIR_NAME}/${DB_FILE_NAME}`;
}

/** Row count for every serialized table in the store at `dir`. */
function tableCounts(dir: string): Record<string, number> {
  const { store } = openStore(dir, {});
  try {
    const counts: Record<string, number> = {};
    for (const table of SNAPSHOT_TABLES) {
      counts[table] = (
        store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }
      ).c;
    }
    return counts;
  } finally {
    store.close();
  }
}

describe("F10 — snapshot and restore", () => {
  it("AC1: snapshot writes the pinned header and byte-identical output for an unchanged store", async () => {
    const out = join(repo.dir, "snap.jsonl");
    expect((await runCli(["snapshot", "--out", out], { cwd: repo.dir })).exitCode).toBe(EXIT.ok);
    const first = readFileSync(out, "utf8");

    expect(JSON.parse(first.split("\n")[0] ?? "")).toEqual({
      format: "katra-snapshot",
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });

    // Age presence past the freshness window so the second run's own
    // openStore genuinely rewrites last_seen — the exact condition that made
    // byte-identity false before presence was excluded from snapshots.
    const { store } = openStore(repo.dir, {});
    store.db
      .prepare("UPDATE presence SET last_seen = ?")
      .run(new Date(Date.now() - PRESENCE_FRESH_MS * 2).toISOString());
    store.close();

    expect((await runCli(["snapshot", "--out", out], { cwd: repo.dir })).exitCode).toBe(EXIT.ok);
    expect(readFileSync(out, "utf8")).toBe(first);
  });

  it("AC2: snapshot then restore into an empty store round-trips every table including hostile bytes", async () => {
    // Seed all nine serialized tables in the source, one with a hostile title.
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const hostileTitle = `danger${rlo}${zwsp}payload`;
    {
      const { store } = openStore(repo.dir, {});
      const epic = seedEpic(store, { id: "kt-epic01", title: "epic" });
      const t1 = seedTask(store, { id: "kt-tsk001", title: hostileTitle, parentId: epic });
      const t2 = seedTask(store, { id: "kt-tsk002", title: "second", tags: ["alpha"] });
      seedDep(store, t2, t1);
      seedLink(store, t1, t2);
      seedNote(store, { taskId: t1, body: "a note" });
      seedClaim(store, { taskId: t1, holder: "/repo/wt-a" });
      store.db
        .prepare("INSERT INTO refs (provider, external_id) VALUES (?,?)")
        .run("github", "owner/repo#1");
      const refId = (
        store.db.prepare("SELECT id FROM refs WHERE external_id = ?").get("owner/repo#1") as {
          id: number;
        }
      ).id;
      store.db.prepare("INSERT INTO task_refs (task_id, ref_id) VALUES (?,?)").run(t1, refId);
      store.close();
    }

    const snap = join(repo.dir, "snap.jsonl");
    expect((await runCli(["snapshot", "--out", snap], { cwd: repo.dir })).exitCode).toBe(EXIT.ok);
    const sourceCounts = tableCounts(repo.dir);

    // Fresh target: an empty store, so --apply needs no --force.
    const target = createGitRepo();
    try {
      await runCli(["init"], { cwd: target.dir });
      const applied = await runCli(["restore", snap, "--apply"], { cwd: target.dir });
      expect(applied.exitCode, applied.stderr).toBe(EXIT.ok);

      // Every serialized table's row count matches the source, and the hostile
      // title round-tripped byte-for-byte through the whole snapshot→restore
      // path (no sanitization, ever — it is a backup, not a render).
      expect(tableCounts(target.dir)).toEqual(sourceCounts);
      const restoredTitle = (
        openDatabase(dbPathOf(target.dir))
          .prepare("SELECT title FROM tasks WHERE id = ?")
          .get("kt-tsk001") as { title: string }
      ).title;
      expect(restoredTitle).toBe(hostileTitle);
    } finally {
      target.cleanup();
    }
  });

  it("AC3: preview writes nothing; --apply without --force refuses a non-empty store; .bak survives a forced swap", async () => {
    await runCli(["add", "a source task"], { cwd: repo.dir });
    const snap = join(repo.dir, "snap.jsonl");
    expect((await runCli(["snapshot", "--out", snap], { cwd: repo.dir })).exitCode).toBe(EXIT.ok);

    // A separate populated target.
    const target = createGitRepo();
    try {
      await runCli(["init"], { cwd: target.dir });
      await runCli(["add", "a target task"], { cwd: target.dir });
      const dbPath = dbPathOf(target.dir);
      const before = tableCounts(target.dir);

      // Preview writes nothing: the target's own tables are unchanged and no
      // swap artifact appears (targeted reads, never mtime/byte-compare).
      const preview = await runCli(["restore", snap], { cwd: target.dir });
      expect(preview.exitCode).toBe(EXIT.ok);
      expect(tableCounts(target.dir)).toEqual(before);
      expect(existsSync(`${dbPath}.bak`)).toBe(false);
      expect(existsSync(`${dbPath}.tmp-restore`)).toBe(false);

      // --apply on a non-empty store refuses without --force.
      const refused = await runCli(["restore", snap, "--apply"], { cwd: target.dir });
      expect(refused.exitCode).toBe(EXIT.conflict);
      expect(tableCounts(target.dir)).toEqual(before);

      // --apply --force swaps, and the previous store survives as .bak.
      const forced = await runCli(["restore", snap, "--apply", "--force"], { cwd: target.dir });
      expect(forced.exitCode, forced.stderr).toBe(EXIT.ok);
      expect(existsSync(`${dbPath}.bak`)).toBe(true);
      // The swapped-in store is the source's — a genuinely operational store.
      const board = await runCli(["board", "--json"], { cwd: target.dir });
      expect(board.exitCode).toBe(EXIT.ok);
    } finally {
      target.cleanup();
    }
  });

  it("AC4: the committed v5 snapshot fixture restores and converges with an ordinarily-migrated store", async () => {
    // Restore a snapshot taken at schema v5 into a fresh (current-schema) store.
    const applied = await runCli(["restore", V5_FIXTURE, "--apply"], { cwd: repo.dir });
    expect(applied.exitCode, applied.stderr).toBe(EXIT.ok);

    // Convergence: the restored store's full schema (built at v5, migrated
    // forward) is identical to an ordinarily-migrated fresh store's.
    const ordinary = createGitRepo();
    try {
      await runCli(["init"], { cwd: ordinary.dir });
      const restoredMaster = openDatabase(dbPathOf(repo.dir))
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const ordinaryMaster = openDatabase(dbPathOf(ordinary.dir))
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      expect(restoredMaster).toEqual(ordinaryMaster);
    } finally {
      ordinary.cleanup();
    }

    // Every serialized table came back non-empty — the fixture genuinely
    // exercises all nine, not just tasks (plan-review HIGH-3 / T1 INFO).
    const counts = tableCounts(repo.dir);
    for (const table of SNAPSHOT_TABLES) {
      expect(counts[table], `table ${table} should have restored rows`).toBeGreaterThan(0);
    }
  });

  it("AC5: --json parity for snapshot and restore", async () => {
    await runCli(["add", "a task"], { cwd: repo.dir });
    const snap = join(repo.dir, "snap.jsonl");

    const snapJson = await runCli(["snapshot", "--out", snap, "--json"], { cwd: repo.dir });
    expect(snapJson.exitCode).toBe(EXIT.ok);
    const snapDoc = snapJson.json() as SnapshotResult;
    expect(snapDoc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(snapDoc.tables.find((t) => t.table === "tasks")?.count).toBeGreaterThan(0);

    const target = createGitRepo();
    try {
      await runCli(["init"], { cwd: target.dir });

      const previewJson = await runCli(["restore", snap, "--json"], { cwd: target.dir });
      expect(previewJson.exitCode).toBe(EXIT.ok);
      const previewDoc = previewJson.json() as RestoreResult;
      expect(previewDoc.applied).toBe(false);

      const applyJson = await runCli(["restore", snap, "--apply", "--json"], { cwd: target.dir });
      expect(applyJson.exitCode).toBe(EXIT.ok);
      const applyDoc = applyJson.json() as RestoreResult;
      expect(applyDoc.applied).toBe(true);
      if (!applyDoc.applied) throw new Error("unreachable");
      expect(applyDoc.tables.find((t) => t.table === "tasks")?.count).toBeGreaterThan(0);
    } finally {
      target.cleanup();
    }
  });
});
