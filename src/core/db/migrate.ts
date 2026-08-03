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
import { withBusyRetry } from "./retry.js";

/** One forward step. There is deliberately no `down`: katra never migrates backwards. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Reads `user_version` without retrying. */
export function readSchemaVersion(db: DatabaseHandle): number {
  return Number(db.pragma("user_version", { simple: true }));
}

function targetVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((highest, m) => Math.max(highest, m.version), 0);
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
 * of several racing migrators, one applies the work and the rest correctly
 * find nothing to do.
 *
 * The first read is retried: a bare pragma read can raise SQLITE_BUSY on a
 * brand-new file, before any transaction exists for `busy_timeout` to apply to.
 */
export function migrate(db: DatabaseHandle, migrations: readonly Migration[]): number {
  const target = targetVersion(migrations);
  const current = withBusyRetry(() => readSchemaVersion(db));

  // A store from a future build. Proceeding would read and write a schema this
  // version does not understand — plausible with one worktree on a global
  // install and another on a local build, or after a rollback.
  if (current > target) {
    throw new KatraException({
      code: "validation",
      message:
        `this store was created by a newer katra (schema v${current}; ` +
        `this build understands v${target}). Upgrade katra to open it.`,
      field: "user_version",
      value: current,
    });
  }

  // Fast path: an already-current store should not open a write transaction
  // just to discover that.
  if (current === target) return 0;

  return writeTx(db, () => {
    const inTransaction = readSchemaVersion(db);
    const pending = migrations
      .filter((m) => m.version > inTransaction)
      .sort((a, b) => a.version - b.version);

    if (pending.length === 0) return 0;

    for (const step of pending) db.exec(step.sql);
    db.pragma(`user_version = ${target}`);
    return pending.length;
  });
}
