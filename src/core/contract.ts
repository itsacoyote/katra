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

import type { LoggedEvent } from "./events/types.js";
import type { Note } from "./notes/types.js";
import type { Blocker, Task, TaskDetail, TaskSummary } from "./tasks/types.js";

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

/**
 * A task standing between another task and readiness.
 *
 * Defined in `tasks/types.ts` and re-exported here so this file stays the one
 * place to read the `--json` contract. It moved there because `TaskDetail`
 * needs it, and this module already imports that one.
 */
export type { Blocker };

/**
 * What `update` prints.
 *
 * An envelope rather than a bare {@link TaskDetail}, and deliberately the same
 * shape for one id as for ten: `update` takes a variable number of ids, and a
 * script passing a list it did not count must not get a different document
 * back depending on how many it happened to contain. Human output still adapts
 * — one task is worth printing in full, ten are worth printing as a list.
 */
export interface UpdateResult {
  readonly tasks: readonly TaskDetail[];
}

/**
 * What `log` prints.
 *
 * An envelope for the same reason `update`'s is one: the count varies, and a
 * document whose shape depends on how much happened is not a contract.
 */
export interface EventLog {
  readonly events: readonly LoggedEvent[];
  /**
   * True when the bound cut the result short.
   *
   * `list` is unbounded precisely because a default cap would have to report
   * truncating; `log` *is* bounded, so it owes the same report. Silence here
   * is worse than anywhere else in katra: this is the read F3's session digest
   * builds on, and a partial history that looks complete is one an agent acts
   * on.
   */
  readonly truncated: boolean;
}

/** What `note list` prints. */
export interface NoteList {
  readonly notes: readonly Note[];
}

/** What `list` prints. */
export interface TaskList {
  readonly tasks: readonly Task[];
}

/** What `init` prints. */
export interface InitResult {
  readonly path: string;
  readonly created: boolean;
}

/** What `dep` prints. */
export interface DependencyResult {
  readonly action: "added" | "removed";
  readonly taskId: string;
  readonly dependsOnId: string;
  /** Whether the dependent is unblocked after the change. */
  readonly ready: boolean;
  /** What still stands in its way, so the answer is actionable. */
  readonly blockers: readonly Blocker[];
}

/** What `link` prints. */
export interface LinkResult {
  readonly action: "linked" | "unlinked";
  readonly a: string;
  readonly b: string;
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
  | {
      readonly status: "none";
      readonly blocked: readonly BlockedTask[];
      /**
       * Unfinished work outside the `Planned` lane.
       *
       * Three answers hide behind "nothing to do", and an agent needs to tell
       * them apart: everything planned is blocked (`blocked` is non-empty),
       * nothing has been triaged yet (`blocked` empty, this above zero), or
       * there is genuinely no work left (both zero). The middle one used to
       * render as a dead end — `add` puts a task in `Defined`, so a fresh
       * store answered with a lane the caller had never heard of.
       */
      readonly untriaged: number;
    };

/** What `--help --json` prints: the usage screen, as data. */
export interface HelpDocument {
  readonly help: string;
}

/** What `--version --json` prints. */
export interface VersionDocument {
  readonly version: string;
}

/**
 * Any command's document, as it is actually printed.
 *
 * `warnings` is merged into the top level of every `--json` document when the
 * store had something non-fatal to say — an ambient `GIT_DIR` redirect, today.
 * It is part of the contract, so the published types have to admit it rather
 * than describing a shape the CLI never quite emits.
 */
export type JsonDocument<T> = T & { readonly warnings?: readonly StoreWarning[] };
