/**
 * Store → file: `exportSnapshot` (F10 T2). The other half of `serialize.ts`'s
 * pure functions — this module is where they meet a real database and the
 * filesystem, the deliberate store-touching exception in this directory
 * (`reconcile/repo.ts` vs `reconcile/{types,policy,engine}.ts` is the same
 * split, one level up). It is also the first non-DB file writer in this
 * codebase — no `renameSync`/temp-file precedent exists anywhere in `src/`
 * to copy, which is why this task carries `risk:review-per-task`.
 *
 * **One `readTx` wraps every table's read** (epic requirement 3: a
 * consistent point-in-time image even while another worktree writes) and
 * does nothing else — no file I/O happens inside it. `readTx`'s own docs say
 * to keep the callback short, because a lingering read snapshot stops WAL
 * checkpointing for the whole store, not just this handle; the callback here
 * only runs `SELECT`s and assembles an in-memory string, then returns. The
 * actual write happens after the transaction has already closed.
 *
 * **Atomicity.** The write goes to a temp file in the SAME directory as the
 * target — never `os.tmpdir()`, since a rename across filesystems is not
 * atomic — is `fsync`ed before the rename (a snapshot's whole purpose is
 * surviving a dead machine, so its bytes must reach disk, not just the OS's
 * write cache, before the rename that makes them visible), and is renamed
 * into place only once. A failure at any step cleans up the temp file and
 * leaves the target path exactly as it was: absent if this is the first
 * snapshot, or holding the previous snapshot's bytes if this is a repeat.
 * `renameSync` on one filesystem is POSIX's own atomic-replace primitive, so
 * no observer can ever see a torn or partially-written file at the target
 * path. (On win32, `renameSync` replaces via `MOVEFILE_REPLACE_EXISTING`
 * rather than POSIX `rename(2)` — already correct here, and it throws
 * `EPERM`/`EBUSY` instead of succeeding if the target is open elsewhere,
 * which this module's existing catch-and-cleanup already handles as an
 * ordinary failure.) **The durability claim is scoped to the data, not the
 * rename's own directory entry**: `fsyncSync` guarantees the temp file's
 * bytes are on disk before the rename, but the rename itself is not
 * separately synced — a power loss at the wrong instant can still lose the
 * rename, never the bytes. Either way the outcome is one of the two files
 * that were ever fully written: the previous snapshot if the rename did not
 * survive, the new one if it did — never a torn file, because nothing was
 * ever written to the target path directly. A stale temp file left behind
 * by a prior run that was killed mid-write (`SIGKILL` reaches no `finally`)
 * is swept before this run's own write begins — `.katra/` is a tracked
 * directory, and a stray temp file sitting in it would otherwise get picked
 * up and committed by a later `git add -A`.
 *
 * **Canonical order.** Every table is read with an explicit column list
 * (`SNAPSHOT_ROW_FIELDS`, T1) and an explicit `ORDER BY` over its primary key
 * — every component, for a composite one — never a bare `SELECT *` with
 * whatever order SQLite's query planner happens to choose. That is what
 * makes two exports of one unchanged store byte-identical (epic AC1)
 * regardless of the order rows were originally inserted in.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SnapshotResult, SnapshotTableCount } from "../contract.js";
import type { DatabaseHandle } from "../db/connection.js";
import { readTx } from "../db/connection.js";
import { readSchemaVersion } from "../db/migrate.js";
import { SNAPSHOT_TABLES, type SnapshotTable } from "../enums.js";
import type { OpenStore } from "../store.js";
import { buildHeader, rowToLine } from "./serialize.js";
import type { SnapshotRowByTable } from "./types.js";
import { SNAPSHOT_ROW_FIELDS } from "./types.js";

/**
 * Every table's primary key, in the exact column order its own `ORDER BY`
 * uses — a composite key ordered by all of its components, never just the
 * first. Declared once here rather than folded into `SNAPSHOT_ROW_FIELDS`
 * (T1, `types.ts`): a field-order array pins *serialized* key order, which
 * has nothing to do with which columns happen to form the primary key.
 */
const PRIMARY_KEY: { readonly [T in SnapshotTable]: readonly string[] } = {
  tasks: ["id"],
  deps: ["task_id", "depends_on_id"],
  links: ["a_id", "b_id"],
  tags: ["task_id", "tag"],
  events: ["id"],
  notes: ["id"],
  claims: ["task_id"],
  refs: ["id"],
  task_refs: ["task_id", "ref_id"],
};

/**
 * Reads every row of one table, explicit columns, canonical (primary-key)
 * order. `table` and its column/key lists all come from this codebase's own
 * fixed arrays, never from anything a caller supplies, so interpolating them
 * into SQL text is the same trust level `enums.ts`'s `sqlEnum` already
 * relies on for DDL.
 */
function selectRows<T extends SnapshotTable>(
  db: DatabaseHandle,
  table: T,
): readonly SnapshotRowByTable[T][] {
  const columns = (SNAPSHOT_ROW_FIELDS[table] as readonly string[]).join(", ");
  const order = PRIMARY_KEY[table].join(", ");
  return db
    .prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`)
    .all() as SnapshotRowByTable[T][];
}

/**
 * A temp file older than this is stranded, not in flight: no snapshot write
 * stays open for an hour.
 */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

/**
 * Sweeps this target's own stale temp files before writing a new one — a
 * `SIGKILL`-stranded temp from a run that never reached its own cleanup
 * (nothing runs a `finally` across a kill signal). `.katra/` is a tracked
 * directory, so a name left behind here is one `git add -A` away from being
 * committed as noise the snapshot format never meant to produce.
 *
 * **Age-gated by `STALE_TEMP_AGE_MS`, not swept on name match alone.** A
 * concurrent writer's own in-flight temp matches the identical prefix, and
 * unlinking it out from under that writer would not stop its already-open
 * file descriptor from finishing the write — POSIX keeps the inode alive
 * past an `unlink` — but it removes the directory entry that writer's own
 * `renameSync` needs, so that writer's rename throws `ENOENT` for a file it
 * just finished writing (reviewer-reproduced probe). Skipping anything
 * young enough to plausibly still be in flight is what keeps this sweep
 * from being the exact bug it exists to prevent.
 *
 * Best-effort per entry: a name that matches but is gone by the time this
 * calls `statSync`/`unlinkSync` (another process racing the identical
 * cleanup, or the age check above simply losing a race with that writer's
 * own rename) is not this call's problem to report.
 */
function sweepStaleTemp(dir: string, tempPrefix: string): void {
  const cutoff = Date.now() - STALE_TEMP_AGE_MS;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(tempPrefix)) continue;
    const entryPath = join(dir, entry);
    try {
      // Recent enough to plausibly still be in flight — unlinking it would
      // strand that writer's own rename on ENOENT (function docs above).
      if (statSync(entryPath).mtimeMs > cutoff) continue;
      unlinkSync(entryPath);
    } catch {
      // Raced or already gone — see the function docs above.
    }
  }
}

/**
 * Writes `content` to `outPath` atomically: a temp file beside the target,
 * `fsync`ed, then `renameSync`. Assumes `outPath`'s directory already
 * exists — the caller (the CLI's `snapshot` command) owns creating
 * `.katra/`, the same division `openStore`/`store.ts` draws between "ensure
 * the directory" and "write the file".
 *
 * Every failure path — the open, the write, the `fsync`, or the rename —
 * removes the temp file before rethrowing, so nothing observable is ever
 * left behind except the target path in whatever state it was already in.
 */
function writeAtomic(outPath: string, content: string): void {
  const dir = dirname(outPath);
  const tempPrefix = `.${basename(outPath)}.tmp-`;

  sweepStaleTemp(dir, tempPrefix);

  const tempPath = join(
    dir,
    `${tempPrefix}${String(process.pid)}-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    const fd = openSync(tempPath, "w");
    try {
      writeFileSync(fd, content, "utf8");
      // fsync before rename, not after: the artifact's stated purpose is
      // surviving a dead machine, so its bytes must reach disk — not just
      // the OS's write cache — before the rename that makes them visible at
      // the target path.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, outPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup — openSync/writeFileSync themselves may have
      // failed before the temp file ever existed, in which case
      // unlinkSync's own ENOENT here is expected and not itself worth
      // surfacing over the original error.
    }
    throw error;
  }
}

/**
 * Exports `store`'s entire contents to `outPath` — every source-of-truth
 * table, in `SNAPSHOT_TABLES`' fixed order, canonical row order within each.
 * Returns the per-table counts `katra snapshot` reports.
 */
export function exportSnapshot(store: OpenStore, outPath: string): SnapshotResult {
  const { content, schemaVersion, tables } = readTx(store.db, () => {
    const version = readSchemaVersion(store.db);
    const lines: string[] = [buildHeader(version)];
    const counts: SnapshotTableCount[] = [];

    for (const table of SNAPSHOT_TABLES) {
      const rows = selectRows(store.db, table);
      counts.push({ table, count: rows.length });
      for (const row of rows) lines.push(rowToLine(table, row));
    }

    return { content: `${lines.join("\n")}\n`, schemaVersion: version, tables: counts };
  });

  writeAtomic(outPath, content);

  return { path: outPath, schemaVersion, tables };
}
