/**
 * The documents katra's commands print — the `--json` contract, as types.
 *
 * These live apart from the modules that produce them for one reason: **this
 * file must never reach the storage engine.** TypeScript emits one declaration
 * file per source file, so a type re-exported from `src/index.ts` drags its
 * whole import graph into the published `.d.ts`. Declaring `DeleteResult` next
 * to `deleteTask` meant `dist/index.d.ts` → `delete.d.ts` → `store.d.ts` →
 * `connection.d.ts` → `import Database from "better-sqlite3"`, whose types are
 * a devDependency. A consumer with `skipLibCheck: false` — TypeScript's own
 * default — could not compile against katra at all:
 *
 * ```
 * dist/core/db/connection.d.ts(15,22): error TS7016: Could not find a
 *   declaration file for module 'better-sqlite3'.
 * ```
 *
 * Nothing here may import from `store.ts`, `db/`, or any module that does.
 * `enums.ts` and `tasks/types.ts` are the only permitted dependencies, and
 * neither touches the database.
 */

import type { Lane } from "./enums.js";
import type { Task, TaskSummary } from "./tasks/types.js";

/**
 * Something worth telling the user that is not fatal.
 *
 * Declared here rather than beside the code that raises it, for the same
 * reason as the rest of this file: `locate.ts` types its options with
 * `NodeJS.ProcessEnv`, so publishing anything from that module would put
 * `@types/node` into every consumer's required type graph.
 */
export interface StoreWarning {
  readonly code: "ambient-git-dir";
  readonly message: string;
}

/** A task standing between another task and readiness. */
export interface Blocker {
  readonly id: string;
  readonly title: string;
  readonly lane: Lane;
}

/** What `list` prints. */
export interface TaskList {
  readonly tasks: readonly Task[];
}

/** What `close`, `cancel` and `reopen` print. */
export interface LifecycleResult {
  readonly task: Task;
  /**
   * Tasks that became ready because of this transition.
   *
   * Reported rather than left to be discovered: releasing dependents is the
   * consequence a reader is least likely to predict, and for `cancel` it is
   * the whole reason the lane exists.
   */
  readonly unblocked: readonly TaskSummary[];
  /**
   * Tasks that stopped being ready because of this transition.
   *
   * The inverse surprise, and `reopen`'s alone: reviving a blocker takes work
   * away from whoever was about to start it. Always empty for `close` and
   * `cancel`, which can only release.
   */
  readonly reblocked: readonly TaskSummary[];
}

/** What `delete` prints. */
export interface DeleteResult {
  readonly id: string;
  readonly title: string;
  /**
   * Tasks that became ready because this one is gone.
   *
   * `ON DELETE CASCADE` removes the dependency rows, which silently makes
   * dependents startable — the same consequence `cancel` reports, and just as
   * easy to miss.
   */
  readonly unblocked: readonly TaskSummary[];
}

/** A planned task that cannot be started, and what stands in its way. */
export interface BlockedTask {
  readonly id: string;
  readonly title: string;
  readonly blockers: readonly Blocker[];
}

/**
 * What `next` prints.
 *
 * Deliberately a discriminated union rather than `Task | null`: the empty case
 * has to carry the blockers, or the caller learns only that it got nothing —
 * and an agent that reads "nothing" as "no work left" stops working.
 */
export type NextResult =
  | { readonly status: "found"; readonly task: Task; readonly epic: TaskSummary | null }
  | { readonly status: "none"; readonly blocked: readonly BlockedTask[] };

/**
 * Any command's document, as it is actually printed.
 *
 * `warnings` is merged into the top level of every `--json` document when the
 * store had something non-fatal to say — an ambient `GIT_DIR` redirect, today.
 * It is part of the contract, so the published types have to admit it rather
 * than describing a shape the CLI never quite emits.
 */
export type JsonDocument<T> = T & { readonly warnings?: readonly StoreWarning[] };
