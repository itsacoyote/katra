/**
 * Retrying operations that SQLite's own busy handler cannot cover.
 *
 * `busy_timeout` absorbs contention *inside* a transaction, but some
 * statements sit outside its reach. `PRAGMA journal_mode = WAL` is the
 * important one: it needs a momentary exclusive lock and does not route
 * through the busy handler at all, so two processes opening a brand-new store
 * together can leave one of them holding a raw "database is locked" error —
 * measured at roughly one round in three with six processes, and that is the
 * exact scenario of two worktrees running their first katra command at once.
 *
 * Reading `user_version` on a fresh file has the same shape.
 */

/** True for any flavour of SQLITE_BUSY, including SQLITE_BUSY_SNAPSHOT. */
export function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/** Blocks the thread. better-sqlite3 is synchronous, so waiting must be too. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface BusyRetryOptions {
  /** How many times to retry before giving up. */
  readonly attempts?: number;
  /** Base delay; each attempt waits a little longer than the last. */
  readonly baseDelayMs?: number;
}

/**
 * Runs `fn`, retrying while SQLite reports the database is busy.
 *
 * Any other error propagates immediately — retrying a genuine fault would turn
 * a clear failure into a slow one.
 */
export function withBusyRetry<T>(fn: () => T, options: BusyRetryOptions = {}): T {
  const attempts = options.attempts ?? 20;
  const baseDelayMs = options.baseDelayMs ?? 10;

  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (attempt >= attempts || !isBusyError(error)) throw error;
      sleepSync(baseDelayMs + attempt * 5);
    }
  }
}
