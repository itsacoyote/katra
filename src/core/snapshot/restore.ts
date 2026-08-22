/**
 * File → store: `restoreSnapshot` (F10 T3, `katra-9aw.67.3`). The
 * destructive half of snapshot/restore, and ADR-018's home: row loading uses
 * raw, parameterized, explicit-column INSERTs — no domain seam, no id
 * minting, no event appended — because restore's job is reproducing katra's
 * own prior data exactly, not admitting new data (ADR-018's "reproduce, don't
 * admit" distinction). Read that ADR before changing anything here.
 *
 * **Ownership contract — fixed, not this module's to renegotiate.**
 * {@link restoreSnapshot} takes **paths only, never a store handle**: it must
 * not be able to close a connection it did not itself open. Every connection
 * this function touches (the temp build, the live checkpoint) is opened and
 * closed entirely inside this call. A caller that already holds the live
 * store open (T4's `apply` path) must close its own handle *before* calling
 * this — mirroring `cli/commands/init.ts`'s direct-`openStore`-plus-its-own-
 * `try/finally` shape, never `withStore`, whose `finally` would double-close
 * a handle this function also tries to manage.
 *
 * **Stage order, every stage's failure leaving the live store untouched and
 * the temp file cleaned up — including a failed *first* rename in stage 7,
 * the one case that is not simply "before the swap" but is still safe to
 * unwind (see stage 7):**
 *
 * 1. Read the file (`readBoundedExportFile`) and validate the *whole* thing —
 *    the header and every row line — before any database work happens at
 *    all. A file that is going to fail must fail here, not three-quarters of
 *    the way through a load with a temp file already dirtied.
 * 2. `openDatabase(tempPath)` — **never `openStore`**, which would resolve
 *    against the wrong root and bump a presence heartbeat neither belongs
 *    here — build the schema at the snapshot's own recorded version.
 * 3. Load every row with a raw, parameterized, explicit-column `INSERT` per
 *    table, inside one transaction. Schema `CHECK`s, foreign keys and `GLOB`
 *    patterns still apply — the rows land in a real schema built by the real
 *    migration chain — so a violating row refuses, naming its table and
 *    source line, never its content.
 * 4. Migrate the temp database forward to the current version.
 * 5. Integrity: `PRAGMA foreign_key_check`, then `wal_checkpoint(TRUNCATE)`
 *    and close, asserting no `-wal`/`-shm` sidecar survives. (The FTS index
 *    needs no separate step: its triggers fire on the ordinary `INSERT`s in
 *    stage 3 exactly as they would for any other write, and migrating through
 *    0004 for an older snapshot backfills it the same way an upgraded
 *    installation's does.)
 * 6. Checkpoint and close the **live** connection (opened and closed here,
 *    not reused from the caller), then clear stale sidecars for both the
 *    live path and the path its `.bak` is about to occupy.
 * 7. The swap: `rename(live, live + ".bak")`, then `rename(temp, live)` — back
 *    to back, the smallest window achievable. The **first** rename still
 *    fails safely — a fully-built, fully-validated temp file that was never
 *    landed is waste, not risk, and its own failure (permissions, disk full,
 *    a concurrent reader holding `.bak`) still cleans it up. **The crash
 *    window between the two renames is ADR-018's named, accepted
 *    residual**: nothing past the first rename attempts to roll back a
 *    partial swap, and a crash there leaves the live path briefly empty with
 *    the good data sitting in `.bak`.
 */

import { lstatSync, renameSync, unlinkSync } from "node:fs";
import type { SnapshotTableCount } from "../contract.js";
import type { DatabaseHandle } from "../db/connection.js";
import { openDatabase, writeTx } from "../db/connection.js";
import { migrate, targetVersion } from "../db/migrate.js";
import { MIGRATIONS } from "../db/migrations/index.js";
import { readBoundedExportFile } from "../db/read-export.js";
import { SNAPSHOT_TABLES, type SnapshotTable } from "../enums.js";
import { KatraException } from "../errors.js";
import { isPlainObject, lineToRow, malformedLine, parseHeader } from "./serialize.js";
import type { SnapshotHeader } from "./types.js";
import { SNAPSHOT_ROW_FIELDS } from "./types.js";

/**
 * Hard ceiling on a snapshot file's size, refused before it is even read.
 *
 * Far above `migrate.ts`'s `MAX_FROM_BYTES` (32 MiB, sized for a beads
 * export): a snapshot carries the whole store, `events` included, and that
 * table is append-only and only ever grows. 256 MiB is generous headroom for
 * a real project's full history while still refusing a garbage file before
 * it is ever materialized in memory.
 */
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

/** What {@link restoreSnapshot} returns: per-table loaded counts and the schema versions traversed. */
export interface RestoreSnapshotResult {
  /** One entry per {@link SnapshotTable}, `SNAPSHOT_TABLES`' own order, `0` for an empty table rather than an absent entry. */
  readonly tables: readonly SnapshotTableCount[];
  /** The snapshot's own recorded `schemaVersion` — where the temp database was built before migrating forward. */
  readonly fromSchemaVersion: number;
  /** The version the restored store ends on — always the running build's own `targetVersion`. */
  readonly toSchemaVersion: number;
}

/** One validated row, still keyed loosely — `lineToRow` already narrowed and copied it through T1's own field whitelist. */
interface ParsedEntry {
  readonly lineNo: number;
  readonly row: Record<string, unknown>;
}

type RowsByTable = { [T in SnapshotTable]: ParsedEntry[] };

function emptyRowsByTable(): RowsByTable {
  const result = {} as RowsByTable;
  for (const table of SNAPSHOT_TABLES) result[table] = [];
  return result;
}

/**
 * Determines which table a parsed line's own key set describes — epic
 * requirement 2's "self-describing" row, made concrete: every table's
 * `SNAPSHOT_ROW_FIELDS` entry is a distinct combination of column names (no
 * two tables share one), so a line's exact key set identifies its table with
 * no need for the file to carry a separate marker, and with no dependence on
 * which order the lines actually appear in.
 */
function tableForKeys(keys: ReadonlySet<string>, lineNo: number): SnapshotTable {
  for (const table of SNAPSHOT_TABLES) {
    const fields = SNAPSHOT_ROW_FIELDS[table] as readonly string[];
    if (fields.length === keys.size && fields.every((field) => keys.has(field))) return table;
  }
  malformedLine(lineNo, "does not match any known table's row shape");
}

interface ParsedSnapshot {
  readonly header: SnapshotHeader;
  readonly rowsByTable: RowsByTable;
}

/**
 * Parses and validates the *entire* file — header plus every row line —
 * before returning. Nothing here touches a filesystem path or a database:
 * a malformed line anywhere in the file throws before stage 2 of the
 * module docs ever runs, which is what "a malformed line aborts before any
 * DB file is created" means operationally.
 *
 * Blank lines (including the trailing one every snapshot file's final
 * newline produces) are skipped without consuming a table slot — the same
 * discipline `beads/extract.ts` uses, so line numbers in a refusal always
 * match the file's own physical lines.
 */
function parseSnapshotFile(text: string, knownSchemaVersion: number): ParsedSnapshot {
  const lines = text.split("\n");
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") {
    malformedLine(1, "missing header line");
  }
  const header = parseHeader(headerLine, knownSchemaVersion);

  const rowsByTable = emptyRowsByTable();
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const lineNo = index + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLine(lineNo, "invalid JSON");
    }
    if (!isPlainObject(parsed)) {
      malformedLine(lineNo, "not a JSON object");
    }

    const table = tableForKeys(new Set(Object.keys(parsed)), lineNo);
    const row = lineToRow(table, line, lineNo) as unknown as Record<string, unknown>;
    rowsByTable[table].push({ lineNo, row });
  }

  return { header, rowsByTable };
}

/**
 * Orders `tasks` rows so every parentless row (every epic, per the schema's
 * own `CHECK (level <> 'epic' OR parent_id IS NULL)`, and any top-level task)
 * lands before any row whose `parent_id` names one — migration 0001's
 * `BEFORE INSERT` trigger checks the parent's existence immediately, with no
 * `DEFERRABLE` escape hatch available for a trigger (unlike a native foreign
 * key, `PRAGMA defer_foreign_keys` does not touch it). katra's hierarchy is
 * exactly two levels deep (an epic's own `parent_id` is always `NULL`), so
 * one partition is a complete topological sort — no general graph algorithm
 * earns its complexity here.
 */
function orderTasksForInsert(entries: readonly ParsedEntry[]): readonly ParsedEntry[] {
  const parentless = entries.filter((entry) => entry.row.parent_id === null);
  const parented = entries.filter((entry) => entry.row.parent_id !== null);
  return [...parentless, ...parented];
}

/**
 * Refuses a non-scalar column value instead of letting it shift the row's
 * binds.
 *
 * better-sqlite3 splices an *array-valued* positional argument into the bind
 * list at that position — `stmt.run('A', [], 'C', ['X', 'Y'])` against four
 * `?` placeholders binds exactly four values (`'A'`, `'C'`, `'X'`, `'Y'`),
 * because the empty array contributes zero and the two-element array
 * contributes two: the count still balances, so there is no arity error and
 * SQLite never sees anything wrong — it just receives `'C'` for the column
 * meant to hold the (invalid) empty array, and every column after it shifted
 * one to the left (verified: this is real, reproducible better-sqlite3
 * behavior, not a hypothetical). A row whose JSON happens to carry an array
 * or object for one field — malformed input, hand-edited, or truncated —
 * would otherwise load *successfully*, silently, with every later column in
 * that row holding the wrong value: exactly the failure mode that defeats a
 * restore preview, since nothing about the count or the exit code would say
 * anything went wrong. Every schema column here is TEXT or INTEGER, so
 * string, number, and null are the only legal bind values; anything else
 * refuses here, before it ever reaches `stmt.run`.
 */
function bindable(
  value: unknown,
  table: SnapshotTable,
  field: string,
  lineNo: number,
): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  throw new KatraException({
    code: "validation",
    field: "row",
    value: { table, line: lineNo, column: field },
    message:
      `snapshot line ${lineNo} (table "${table}") holds a non-scalar value for column ` +
      `"${field}" — only text, number, or null bind safely, and anything else would silently ` +
      "shift every later column's value",
  });
}

/**
 * Inserts every row for one table with one prepared, parameterized,
 * explicit-column statement (ADR-018) — columns and value order both taken
 * from `SNAPSHOT_ROW_FIELDS[table]`, the same fixed array `export.ts`'s
 * `selectRows` reads with, so a table's on-disk column order can never
 * silently disagree between the two directions.
 *
 * A `CHECK`/foreign-key/`GLOB` violation at insert time refuses naming the
 * table and the row's original source line — never the row's own content,
 * which may carry hostile bytes from an untrusted file.
 */
function loadTable(
  db: DatabaseHandle,
  table: SnapshotTable,
  entries: readonly ParsedEntry[],
): number {
  const fields = SNAPSHOT_ROW_FIELDS[table] as readonly string[];
  const columns = fields.join(", ");
  const placeholders = fields.map(() => "?").join(", ");
  const stmt = db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`);

  for (const { lineNo, row } of entries) {
    const values = fields.map((field) => bindable(row[field], table, field, lineNo));
    try {
      stmt.run(...values);
    } catch (error) {
      throw new KatraException({
        code: "validation",
        field: "row",
        value: { table, line: lineNo },
        message:
          `snapshot line ${lineNo} (table "${table}") violates the live schema — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return entries.length;
}

/** Loads every table's rows inside one transaction, `SNAPSHOT_TABLES`' own foreign-key-safe order. */
function loadAllRows(db: DatabaseHandle, rowsByTable: RowsByTable): readonly SnapshotTableCount[] {
  return writeTx(db, () => {
    const counts: SnapshotTableCount[] = [];
    for (const table of SNAPSHOT_TABLES) {
      const entries =
        table === "tasks" ? orderTasksForInsert(rowsByTable.tasks) : rowsByTable[table];
      counts.push({ table, count: loadTable(db, table, entries) });
    }
    return counts;
  });
}

/**
 * Removes whatever sits at `path`, including a dangling symlink.
 *
 * `existsSync` follows symlinks: a dangling one (its target missing) reads
 * as *absent*, even though the link itself is a real filesystem entry
 * sitting exactly where this module is about to build a fresh database. Left
 * in place, `openDatabase(tempPath)` would silently build the restore at
 * wherever the link points — potentially outside the store's own directory —
 * and stage 7's `renameSync` would then move that same link onto the live
 * path, not a real database file. `lstatSync` reports on the link itself,
 * never the target it points to, so a dangling link is correctly seen as
 * present here and removed by `unlinkSync`, which likewise never follows it.
 */
function removeIfExists(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  unlinkSync(path);
}

function sidecarsFor(path: string): readonly [string, string] {
  return [`${path}-wal`, `${path}-shm`];
}

/** Removes `path`'s `-wal`/`-shm` sidecars if present — including a dangling symlink, via {@link removeIfExists}. Idempotent. */
function clearSidecars(path: string): void {
  for (const sidecar of sidecarsFor(path)) removeIfExists(sidecar);
}

/** One row of `PRAGMA wal_checkpoint(TRUNCATE)`'s result. */
interface WalCheckpointRow {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

/**
 * Runs `PRAGMA wal_checkpoint(TRUNCATE)` and refuses if it could not fully
 * checkpoint. `busy !== 0` means some other connection held a lock the
 * checkpoint needed, so the WAL is not guaranteed fully flushed — this is
 * the "assert its `-wal`/`-shm` are gone" the module docs promise, made
 * real: without checking the result, a checkpoint that silently left WAL
 * content behind would slip straight past a comment that only claimed to
 * assert it. Never called on its own — always immediately followed by
 * `clearSidecars`, which removes whatever the checkpoint left clean.
 */
function checkpointOrThrow(db: DatabaseHandle, message: string): void {
  const [result] = db.pragma("wal_checkpoint(TRUNCATE)") as readonly WalCheckpointRow[];
  if ((result?.busy ?? 0) !== 0) {
    throw new KatraException({ code: "conflict", reason: "wal-checkpoint-busy", message });
  }
}

/** Best-effort teardown of a temp build that will never be used — every failure path before the swap runs this. */
function cleanupTemp(tempPath: string): void {
  removeIfExists(tempPath);
  clearSidecars(tempPath);
}

/**
 * `cleanupTemp`, but its own failure never masks the real refusal that led
 * here — `export.ts`'s `writeAtomic` precedent for the same shape: a failed
 * refusal is what a caller needs to see, and an unlink error encountered
 * while cleaning up after it is, at most, a second problem worth noting, not
 * one that should replace the first.
 */
function safeCleanupTemp(tempPath: string): void {
  try {
    cleanupTemp(tempPath);
  } catch {
    // Best-effort — see the docstring above.
  }
}

/**
 * Rebuilds the store at `liveDbPath` from the snapshot at `snapshotPath`.
 *
 * See the module docs for the ownership contract (paths only, this function
 * opens and closes every connection it touches) and the full stage order.
 * Every failure before the final two `rename`s leaves `liveDbPath` completely
 * untouched and removes the temp file; the crash window between those two
 * renames is ADR-018's named, accepted residual, not something this function
 * tries to paper over.
 */
export function restoreSnapshot(snapshotPath: string, liveDbPath: string): RestoreSnapshotResult {
  const text = readBoundedExportFile(snapshotPath, {
    field: "file",
    maxBytes: MAX_SNAPSHOT_BYTES,
    notFoundHint: (path) =>
      `snapshot at ${path} — check the path, or run \`katra snapshot\` on the machine that ` +
      "has the data to create one",
    kindHint: "a katra snapshot written to disk",
    flagLabel: "the snapshot file",
    readerHint: "katra restore",
  });

  // Stage 1: whole-file validation, before any database work at all.
  const currentVersion = targetVersion(MIGRATIONS);
  const { header, rowsByTable } = parseSnapshotFile(text, currentVersion);

  const tempPath = `${liveDbPath}.tmp-restore`;
  let tables: readonly SnapshotTableCount[];

  try {
    // A stale temp file from a previously-crashed restore must not be
    // reopened as though it were a fresh build.
    cleanupTemp(tempPath);

    const tempDb = openDatabase(tempPath);
    try {
      // Stage 2: build at the snapshot's own recorded version.
      migrate(
        tempDb,
        MIGRATIONS.filter((m) => m.version <= header.schemaVersion),
      );

      // Stage 3: raw, parameterized, explicit-column loading (ADR-018).
      tables = loadAllRows(tempDb, rowsByTable);

      // Stage 4: forward to current.
      migrate(tempDb, MIGRATIONS);

      // Stage 5: integrity. The FTS index needs no separate step — see the
      // module docs.
      const violations = tempDb.pragma("foreign_key_check") as readonly unknown[];
      if (violations.length > 0) {
        throw new KatraException({
          code: "validation",
          field: "file",
          value: violations.length,
          message:
            `the loaded snapshot fails a foreign-key check (${String(violations.length)} ` +
            "violation(s)) after migrating forward — the file may be corrupt or from an " +
            "incompatible build",
        });
      }

      checkpointOrThrow(
        tempDb,
        "the just-built restore database could not be fully checkpointed — something else has " +
          "the temp file open, which should not happen for a private build. Restore refuses " +
          "rather than swap in a store that might not be fully flushed.",
      );
    } finally {
      tempDb.close();
    }
    // The temp file must be fully self-contained before the swap.
    clearSidecars(tempPath);

    // Stage 6: checkpoint and close the live connection — opened and closed
    // entirely here, never a handle the caller passed in (the ownership
    // contract above).
    const liveDb = openDatabase(liveDbPath);
    try {
      checkpointOrThrow(
        liveDb,
        "another session has the store open — the .bak may be incomplete if the swap proceeds " +
          "regardless. Close other katra sessions in this repository and try again.",
      );
    } finally {
      liveDb.close();
    }
    clearSidecars(liveDbPath);
    clearSidecars(`${liveDbPath}.bak`);
  } catch (error) {
    safeCleanupTemp(tempPath);
    throw error;
  }

  // Stage 7: the swap. The first rename still fails safely: a temp file
  // fully built and validated but never landed is waste, not risk, so its
  // own failure (permissions, disk full, a concurrent .bak already held
  // open) still cleans it up rather than leaking it. The second is where
  // recovery ends — once the live path is gone, the only way forward is
  // landing the replacement, and that crash window is ADR-018's named,
  // accepted residual (data safe in .bak either way).
  try {
    renameSync(liveDbPath, `${liveDbPath}.bak`);
  } catch (error) {
    safeCleanupTemp(tempPath);
    throw error;
  }
  renameSync(tempPath, liveDbPath);

  return { tables, fromSchemaVersion: header.schemaVersion, toSchemaVersion: currentVersion };
}
