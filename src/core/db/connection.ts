/**
 * Opening a connection, and the only sanctioned way to write through one.
 *
 * Two settings here are per-connection, not per-database: `busy_timeout` and
 * `foreign_keys` live in the connection, not the file header, so every process
 * that opens the store must set them again. That is why {@link openDatabase} is
 * the single door — a handle obtained any other way silently loses foreign-key
 * enforcement.
 *
 * `journal_mode` is the exception: WAL is recorded in the file header and
 * persists, so setting it once would suffice. It is set on every open anyway,
 * because doing so is cheap and the alternative is a store whose durability
 * depends on which process happened to create it.
 */

import Database from "better-sqlite3";
import { nowIso } from "../clock.js";
import { KatraException } from "../errors.js";
import { withBusyRetry } from "./retry.js";

type DatabaseHandle = Database.Database;

/**
 * How long a blocked writer waits before giving up.
 *
 * Named rather than inlined so the six-process contention test and the runtime
 * cannot drift apart, and so a CI runner under load has one value to tune.
 *
 * Deliberately **not** 5000, which is better-sqlite3's own default: a test
 * asserting the pragma took effect could not fail while the two agreed, and
 * deleting the pragma entirely left the suite green.
 */
export const BUSY_TIMEOUT_MS = 7500;

/** Recognises the SQLite error codes that mean "this file is not a usable store". */
function isUnreadableStore(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT";
}

/**
 * Opens the store at `dbPath` with katra's required pragmas.
 *
 * The caller is responsible for the directory existing; this function does not
 * create it, so that `init` stays the only thing that brings a store into being.
 */
export function openDatabase(dbPath: string): DatabaseHandle {
  const db = new Database(dbPath);

  try {
    // A corrupt or non-SQLite file does not fail at construction — SQLite is
    // lazy — so the first pragma is where it surfaces.
    //
    // It is also where concurrent opens collide. Setting WAL needs a momentary
    // exclusive lock and does **not** go through SQLite's busy handler, so
    // `busy_timeout` cannot help here however generous it is; the retry has to
    // be explicit. Without it, six processes opening one new store lose at
    // least one of themselves to "database is locked" about a third of the
    // time.
    const mode = withBusyRetry(() => db.pragma("journal_mode = WAL", { simple: true }));
    if (mode !== "wal") {
      db.close();
      throw new KatraException({
        code: "validation",
        message:
          `could not enable WAL mode on ${dbPath} (journal_mode is "${String(mode)}"). ` +
          "katra needs WAL so worktrees can read and write concurrently.",
        field: "journal_mode",
        value: mode,
      });
    }

    // Never assume the default. This better-sqlite3 build happens to compile
    // with DEFAULT_FOREIGN_KEYS so the pragma already reads 1, but that is a
    // distribution-specific flag, not portable, and the dependency floats.
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

    return db;
  } catch (error) {
    db.close();
    if (error instanceof KatraException) throw error;
    if (isUnreadableStore(error)) {
      throw new KatraException({
        code: "validation",
        message:
          `the katra store at ${dbPath} is not a readable database. ` +
          "This version has no restore command, so the store must be deleted and " +
          "re-initialised — its task history will be lost.",
        field: "store",
        value: (error as { code?: unknown }).code,
      });
    }
    throw error;
  }
}

/**
 * Runs `fn` inside one `BEGIN IMMEDIATE` transaction. Every write goes through
 * here.
 *
 * The default transaction is `BEGIN DEFERRED`, which takes no lock until its
 * first access. Two processes can therefore both begin, both read, and both
 * try to upgrade to a write — and one loses with `SQLITE_BUSY` even under WAL,
 * even with a generous `busy_timeout`, because the timeout has nothing
 * coherent to wait on. Measured across six concurrent processes doing
 * read-then-write, the deferred default lost about a third of all writes;
 * `IMMEDIATE` lost none.
 *
 * `IMMEDIATE` takes the write lock up front, which serialises writers at the
 * start of the transaction where `busy_timeout` can absorb the wait. It is not
 * `EXCLUSIVE`, which would also block readers — the thing WAL exists to avoid.
 *
 * The callback receives the transaction's timestamp so every row written
 * together shares one value rather than drifting by a millisecond mid-write.
 *
 * That timestamp is taken **inside** the callback, where the write lock is
 * already held. Passing `nowIso()` as an argument to `.immediate()` reads the
 * clock before `BEGIN IMMEDIATE` has even attempted the lock, so a writer that
 * then queues behind another commits later while carrying an earlier stamp —
 * `created_at` order stops agreeing with commit order. Nothing in F1 depended
 * on the two agreeing; the event stream does.
 */
export function writeTx<T>(db: DatabaseHandle, fn: (now: string) => T): T {
  const runner = db.transaction(() => fn(nowIso()));
  return runner.immediate();
}

export type { DatabaseHandle };
