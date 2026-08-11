/**
 * The heartbeat: presence bumped as a side effect of every `openStore` call.
 *
 * ADR-011 makes this hook-free by design — every katra invocation opens a
 * store, so bumping `last_seen` there, rather than at each write path, is the
 * one place that sees every command including the read-only ones a session
 * spends most of its life running. `openStore` calls {@link bumpPresence}
 * itself, after migrations have run and before the store is handed back, so
 * the presence table always exists by the time this touches it and no command
 * can slip through without paying the bump.
 *
 * Three properties keep the bump from becoming the thing it exists to guard
 * against:
 *
 * - **Worktree-keyed freshness, never the branch.** The skip check reads
 *   `presence` by `worktree` alone. `Identity.branch()` spawns `git`, and the
 *   whole point of splitting worktree from branch in F4 T2 was so a bump that
 *   is about to skip never pays for a spawn it will not use (plan-review
 *   MEDIUM-3). The branch resolves only on the path that is actually going to
 *   write.
 * - **Its own short busy budget.** The presence UPSERT still goes through
 *   {@link writeTx} — every write does — but the connection's `busy_timeout`
 *   is lowered to {@link PRESENCE_BUSY_TIMEOUT_MS} for exactly that one
 *   transaction and restored immediately after, win or lose. The restore reads
 *   the previous value back from the connection rather than assuming it —
 *   the connection's normal budget is `BUSY_TIMEOUT_MS`, but asserting that
 *   here would be a second, driftable copy of a fact the connection already
 *   knows. `board` and `brief` are the commands agents poll in a loop; queuing
 *   one of them behind another session's full busy timeout would make the
 *   heartbeat cost more than the read it rides on.
 * - **Non-fatal, end to end.** Identity resolution and the write itself are
 *   one `try`: a failure of either warns and returns, and the store this was
 *   called from is already built and about to be handed back regardless. A
 *   read that failed because telemetry could not be written would invert the
 *   priorities ADR-011 sets out.
 *
 * The warning is `process.emitWarning`, not the `StoreWarning[]` returned
 * alongside a store. That channel is for structured, per-invocation findings
 * the CLI renders next to a command's own output (`locate.ts`'s ambient-dir
 * check); a presence failure is not part of any command's result and does not
 * belong in its JSON. It is also deliberately **once per process**, not once
 * per call: `runCli`'s in-process harness can open a store many times inside
 * one worker, and a session whose git is simply broken would otherwise print
 * the same warning on every single command.
 */

import { writeTx } from "./db/connection.js";
import type { OpenStore } from "./store.js";

/**
 * How long a presence row stays fresh before the next command rewrites it.
 *
 * Worktree-keyed, per the module docs: a branch change inside the window is
 * picked up by the next write that does happen, so it is at most this stale in
 * a display that reports minutes (ADR-011).
 */
export const PRESENCE_FRESH_MS = 30_000;

/**
 * The presence UPSERT's own busy budget — never the connection's normal
 * `busy_timeout` ({@link ./db/connection.js!BUSY_TIMEOUT_MS}).
 *
 * Short on purpose: a writer that cannot get the lock inside this window backs
 * off and lets the command it is riding on proceed with no heartbeat this
 * time, rather than making six worktrees polling `board` queue behind one
 * another's full 7.5s connection timeout.
 */
export const PRESENCE_BUSY_TIMEOUT_MS = 200;

const UPSERT_PRESENCE_SQL = `
  INSERT INTO presence (worktree, branch, last_seen) VALUES (?, ?, ?)
  ON CONFLICT(worktree) DO UPDATE SET branch = excluded.branch, last_seen = excluded.last_seen
`;

/** One process warns at most once, however many times a bump fails inside it. */
let warned = false;

function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  const detail = error instanceof Error ? error.message : String(error);
  process.emitWarning(
    `katra: could not update presence (${detail}). The command continues; a contended ` +
      "claim may show a stale last-seen until the next successful heartbeat.",
    { type: "KatraPresenceWarning" },
  );
}

/** What `presence` holds for one worktree. */
export interface PresenceRecord {
  readonly worktree: string;
  readonly branch: string;
  readonly lastSeen: string;
}

interface PresenceRow {
  readonly branch: string;
  readonly last_seen: string;
}

/**
 * Bumps `last_seen` for this invocation's worktree, unless the existing row is
 * still fresh.
 *
 * **Never throws.** Every failure — resolving the identity, reading the
 * existing row, taking the write lock — is caught and warned once per process
 * (see the module docs); the store this is called from is unaffected either
 * way.
 *
 * Called from {@link ./store.js openStore} itself, the one door every command
 * passes, `init` included, so nothing needs to remember to call this. Not
 * exported for callers to invoke a second time on the same store — `readPresence`
 * is the read side for consumers that just want to display it.
 */
export function bumpPresence(store: OpenStore): void {
  try {
    const { db } = store;
    const worktree = store.identity().worktree;

    const existing = db
      .prepare("SELECT last_seen FROM presence WHERE worktree = ?")
      .get(worktree) as { last_seen: string } | undefined;

    if (existing !== undefined) {
      const threshold = new Date(Date.now() - PRESENCE_FRESH_MS).toISOString();
      // Fresh: skip the write, and — because `.branch()` is never called on
      // this path — the git spawn it would pay for.
      if (existing.last_seen > threshold) return;
    }

    const branch = store.identity().branch();

    // Read the connection's current budget back rather than assuming
    // BUSY_TIMEOUT_MS: restoring a hardcoded constant would silently drift
    // from reality the moment anything ever opened this connection with a
    // different one, quietly widening or narrowing every write after this
    // one for the rest of the command.
    const previousBusyTimeoutMs = db.pragma("busy_timeout", { simple: true }) as number;
    db.pragma(`busy_timeout = ${PRESENCE_BUSY_TIMEOUT_MS}`);
    try {
      writeTx(db, (now) => {
        db.prepare(UPSERT_PRESENCE_SQL).run(worktree, branch, now);
      });
    } finally {
      db.pragma(`busy_timeout = ${previousBusyTimeoutMs}`);
    }
  } catch (error) {
    warnOnce(error);
  }
}

/**
 * Reads the presence row for `worktree`, or `null` when none has been
 * recorded yet.
 *
 * A plain read, not wrapped in {@link ./db/connection.js readTx}: one row, one
 * statement, nothing else it must agree with — the same reasoning that keeps
 * `getTask` unwrapped. For claim display (T7/T12), joined against `claims.holder`.
 */
export function readPresence(store: OpenStore, worktree: string): PresenceRecord | null {
  const row = store.db
    .prepare("SELECT branch, last_seen FROM presence WHERE worktree = ?")
    .get(worktree) as PresenceRow | undefined;
  if (row === undefined) return null;
  return { worktree, branch: row.branch, lastSeen: row.last_seen };
}
