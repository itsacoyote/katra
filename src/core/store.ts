/**
 * The one way to obtain a katra store.
 *
 * Locate, open, migrate, heartbeat — in that order, behind a single function.
 * Nothing else in the codebase constructs a database handle, because the
 * pragmas that make a connection safe are per-connection: a handle obtained
 * elsewhere would silently lose foreign-key enforcement and its busy timeout.
 * The heartbeat (F4 T3, ADR-011) rides here rather than at each command's own
 * entry point for the same reason: this is the one function every command
 * passes through, `init` included, and it runs after migrations so the
 * presence table always exists by the time it is touched.
 */

import { existsSync, mkdirSync } from "node:fs";
import type { Identity } from "./actor.js";
import { actorFromIdentity, createIdentityResolver } from "./actor.js";
import type { DatabaseHandle } from "./db/connection.js";
import { openDatabase } from "./db/connection.js";
import type { StoreWarning } from "./db/locate.js";
import { resolveStoreLocation } from "./db/locate.js";
import { migrate } from "./db/migrate.js";
import { MIGRATIONS } from "./db/migrations/index.js";
import { KatraException } from "./errors.js";
import { bumpPresence } from "./presence.js";

/**
 * A store, as the outside world sees it.
 *
 * Deliberately does **not** expose the database handle. This is the type
 * `src/index.ts` publishes, and putting `db` on it would make
 * better-sqlite3's `Database` structurally part of katra's public API — a
 * consumer would need better-sqlite3's types resolvable just to hold a store,
 * and swapping the storage engine would become a breaking change.
 */
export interface Store {
  /** Absolute path to the database file. */
  readonly dbPath: string;
  /** Absolute path to the git common dir this store belongs to. */
  readonly commonDir: string;
  /**
   * Releases the connection.
   *
   * Not optional housekeeping: a lingering read snapshot stops WAL
   * checkpointing entirely, so the log grows without bound until every handle
   * is closed.
   */
  close(): void;
}

/**
 * A store plus its connection, for modules inside `core/`.
 *
 * Internal signatures take this; the public surface takes {@link Store}. The
 * separation is a type boundary rather than a comment asking people to behave.
 */
export interface OpenStore extends Store {
  readonly db: DatabaseHandle;
  /**
   * Who is writing, per ADR-007. Every event and note stamps it.
   *
   * On the store rather than threaded through `createTask`, `updateTask`,
   * `transition` and `deleteTask` as a parameter: the actor belongs to the
   * invocation, exactly like the store handle does, and four extra parameters
   * carrying one unchanging value is noise at every call site.
   *
   * A function, not a value, so it stays lazy — resolving it costs two
   * subprocess spawns, and `list`, `show` and `next` must not pay for an actor
   * they never stamp. Memoised, so a command writing several events resolves
   * once. Composed from {@link identity}'s own resolution rather than
   * resolving independently, so asking for both never spawns git twice for
   * the same worktree-and-branch pair.
   */
  readonly actor: () => string;
  /**
   * The worktree and branch this invocation is running as, split into their
   * own laziness (F4 T2): the worktree resolves the moment `identity()` is
   * called at all — presence (F4 T3) keys its heartbeat on it — while the
   * branch stays behind `identity().branch()` for consumers that need it only
   * to write, the claim/release CAS chiefly.
   *
   * Memoised per store context, exactly like {@link actor}: never at module
   * scope, because `runCli` builds a fresh context per test inside one worker
   * process, and a module-level cache would hand one test's identity to the
   * next.
   */
  readonly identity: () => Identity;
}

export interface OpenStoreResult {
  readonly store: OpenStore;
  /**
   * True when this call brought the store into being.
   *
   * Derived from the migration actually being applied rather than from a
   * pre-open `existsSync`, which every racer would answer the same way — under
   * a concurrent first run, all of them would claim to have created it.
   */
  readonly created: boolean;
  /**
   * Non-fatal findings from locating the store, carried out to the CLI.
   *
   * Every command opens a store, so dropping these here would mean only
   * `init` could ever report an ambient `GIT_COMMON_DIR` redirect.
   */
  readonly warnings: readonly StoreWarning[];
}

export interface OpenStoreOptions {
  /** Environment for the git invocations. Defaults to the current process's. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Create the store when it does not exist yet. Only `init` passes true —
   * every other command should tell the user to run `init` rather than
   * silently conjuring an empty backlog in the wrong repository.
   */
  readonly createIfMissing?: boolean;
  /**
   * Who to record as the writer. Defaults to composing it from `identity`.
   *
   * The CLI passes its own per-invocation resolver so one command resolves
   * once however many stores or events it touches; a test passes a fixed
   * string when the actor is the thing being asserted.
   */
  readonly actor?: () => string;
  /**
   * The worktree (eager) and branch (lazy) this invocation is running as.
   * Defaults to resolving both from `cwd`, exactly like `actor`.
   *
   * Threaded independently from `actor` rather than always deriving one from
   * the other, so a test can pin a fixed actor string without also faking out
   * git for `identity`, and a future caller can pin `identity` — for the race
   * tests across two linked worktrees — without also faking `actor`.
   */
  readonly identity?: () => Identity;
}

/**
 * Opens (and optionally creates) the store for the repository containing `cwd`.
 *
 * Works from the repo root, any subdirectory, and any linked worktree — all
 * three resolve to the same file, which is what lets parallel sessions share
 * one backlog.
 */
export function openStore(cwd: string, options: OpenStoreOptions = {}): OpenStoreResult {
  const location = resolveStoreLocation(cwd, options.env === undefined ? {} : { env: options.env });
  const existed = existsSync(location.dbPath);

  if (!existed && options.createIfMissing !== true) {
    throw new KatraException({
      code: "not_found",
      message:
        `no katra store in this repository (expected ${location.dbPath}). ` +
        "Run `katra init` to create one.",
      id: location.dbPath,
    });
  }

  mkdirSync(location.storeDir, { recursive: true });
  const db = openDatabase(location.dbPath);

  let applied: number;
  try {
    applied = migrate(db, MIGRATIONS);
  } catch (error) {
    db.close();
    throw error;
  }

  const identity =
    options.identity ??
    createIdentityResolver(options.env === undefined ? { cwd } : { cwd, env: options.env });

  const store: OpenStore = {
    dbPath: location.dbPath,
    commonDir: location.commonDir,
    db,
    identity,
    actor: options.actor ?? (() => actorFromIdentity(identity())),
    close: () => db.close(),
  };

  // ADR-011: every command bumps presence, reads included. Non-fatal — see
  // `presence.ts` — so a failure here never stops the store from being handed
  // back.
  bumpPresence(store);

  return {
    store,
    created: applied > 0,
    warnings: location.warnings,
  };
}
