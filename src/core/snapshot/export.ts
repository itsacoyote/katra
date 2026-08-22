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
 * atomic — and is renamed into place only once fully written. A failure at
 * either the write or the rename cleans up the temp file and leaves the
 * target path exactly as it was: absent if this is the first snapshot, or
 * holding the previous snapshot's bytes if this is a repeat. `renameSync` on
 * one filesystem is POSIX's own atomic-replace primitive, so no observer can
 * ever see a torn or partially-written file at the target path.
 *
 * **Canonical order.** Every table is read with an explicit column list
 * (`SNAPSHOT_ROW_FIELDS`, T1) and an explicit `ORDER BY` over its primary key
 * — every component, for a composite one — never a bare `SELECT *` with
 * whatever order SQLite's query planner happens to choose. That is what
 * makes two exports of one unchanged store byte-identical (epic AC1)
 * regardless of the order rows were originally inserted in.
 */

import { renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  presence: ["worktree"],
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
 * Writes `content` to `outPath` atomically: a temp file beside the target,
 * then `renameSync`. Assumes `outPath`'s directory already exists — the
 * caller (the CLI's `snapshot` command) owns creating `.katra/`, the same
 * division `openStore`/`store.ts` draws between "ensure the directory" and
 * "write the file".
 *
 * Every failure path — the write itself, or the rename — removes the temp
 * file before rethrowing, so nothing observable is ever left behind except
 * the target path in whatever state it was already in.
 */
function writeAtomic(outPath: string, content: string): void {
  const dir = dirname(outPath);
  const tempPath = join(
    dir,
    `.${basename(outPath)}.tmp-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, outPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup — writeFileSync itself may have failed before the
      // temp file ever existed, in which case unlinkSync's own ENOENT here is
      // expected and not itself worth surfacing over the original error.
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
