/**
 * Forward-only schema migration.
 *
 * The current version lives in SQLite's own `user_version` pragma rather than
 * a table katra maintains — it is transactional, costs nothing, and cannot get
 * out of step with the schema it describes.
 *
 * Two processes opening a brand-new store at the same instant is the case that
 * shapes everything here, because it is exactly what happens when two
 * worktrees run their first command together.
 */

import { KatraException } from "../errors.js";
import type { DatabaseHandle } from "./connection.js";
import { writeTx } from "./connection.js";

/** One forward step. There is deliberately no `down`: katra never migrates backwards. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

function isBusy(error: unknown): boolean {
  return String((error as { code?: unknown }).code ?? "").startsWith("SQLITE_BUSY");
}

/** Blocks the thread briefly. better-sqlite3 is synchronous, so this must be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Reads `user_version` without retrying. */
export function readSchemaVersion(db: DatabaseHandle): number {
  return Number(db.pragma("user_version", { simple: true }));
}

/**
 * Reads `user_version`, retrying while the database is busy.
 *
 * A bare pragma read is not automatically safe: two processes racing to open
 * and migrate the same brand-new file can make this throw SQLITE_BUSY before
 * any transaction has started, so `busy_timeout` has nothing to apply to yet.
 * Reproduced roughly one run in ten.
 */
function readSchemaVersionWithRetry(db: DatabaseHandle, attempts = 20): number {
  for (let attempt = 0; ; attempt++) {
    try {
      return readSchemaVersion(db);
    } catch (error) {
      if (attempt >= attempts || !isBusy(error)) throw error;
      sleepSync(10 + attempt * 5);
    }
  }
}

function targetVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((highest, m) => Math.max(highest, m.version), 0);
}

/** Guards the one value that has to be interpolated rather than bound. */
function assertSafeVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new KatraException({
      code: "validation",
      message: `refusing to set a non-integer schema version (${String(version)})`,
      field: "user_version",
      value: version,
    });
  }
}

/**
 * Brings `db` up to the latest version and returns how many steps it applied.
 *
 * Every pending step and the version bump happen inside a **single immediate**
 * transaction, so a crash mid-migration rolls the whole thing back rather than
 * leaving a half-built schema behind a stale version number.
 *
 * The version is read a second time *inside* that transaction. The first read
 * only decides whether to open a transaction at all; between it and the
 * transaction another process may have migrated the store already. Because
 * `BEGIN IMMEDIATE` serialises writers, the second read is authoritative — so
 * of two racing migrators, one applies the work and the other correctly finds
 * nothing to do.
 */
export function migrate(db: DatabaseHandle, migrations: readonly Migration[]): number {
  const target = targetVersion(migrations);
  assertSafeVersion(target);

  // Fast path: the overwhelmingly common case is an already-current store, and
  // it should not open a write transaction just to discover that.
  if (readSchemaVersionWithRetry(db) >= target) return 0;

  return writeTx(db, () => {
    const current = readSchemaVersion(db);
    const pending = migrations
      .filter((m) => m.version > current)
      .sort((a, b) => a.version - b.version);

    if (pending.length === 0) return 0;

    for (const step of pending) db.exec(step.sql);
    db.pragma(`user_version = ${target}`);
    return pending.length;
  });
}
