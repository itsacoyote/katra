/**
 * katra's public API.
 *
 * This is the package's `main`/`exports` contract: an export list, not a place
 * logic gets written. A later MCP surface imports from here rather than
 * reaching into `src/core/`.
 *
 * **What this is useful for today: reading katra's `--json` output.** Every
 * type below describes a document one of the twelve commands prints, so a
 * consumer can `JSON.parse` a command's stdout and hold the result in a checked
 * shape. The functions are the ones that need no store to run — the value sets,
 * their predicates, and the error types.
 *
 * Note what is deliberately absent: `openStore` and everything that takes an
 * `OpenStore`. Those carry the `better-sqlite3` handle, so publishing them
 * would make the storage engine's concrete type part of katra's API and force a
 * consumer to have better-sqlite3's types resolvable just to call katra. The
 * in-process API lands when there is a store handle worth publishing; until
 * then the CLI is the interface and these types describe what it says.
 */

export type { StoreWarning } from "./core/db/locate.js";
// The fixed value sets and their derived types.
export {
  isKind,
  isLane,
  isLevel,
  isPriority,
  isTerminal,
  KINDS,
  type Kind,
  LANES,
  type Lane,
  LEVELS,
  type Level,
  PRIORITIES,
  PRIORITY_DEFAULT,
  PRIORITY_MAX,
  PRIORITY_MIN,
  type Priority,
  TERMINAL_LANES,
  type TerminalLane,
} from "./core/enums.js";
// Errors — a consumer catches these and reads the structured detail.
export {
  isKatraException,
  KATRA_ERROR_CODES,
  type KatraErrorCode,
  type KatraErrorDetail,
  KatraException,
} from "./core/errors.js";
// A blocker, as `next` and `show` report one. Readiness itself is defined once
// by the task_readiness view created with the schema; nothing re-derives it.
export type { Blocker } from "./core/graph/deps.js";
// What `delete` prints.
export type { DeleteResult } from "./core/tasks/delete.js";
// Identity. `resolveId` and `requireId` are not re-exported: they take an
// `OpenStore`, so publishing them would put the storage handle into the public
// API through a parameter. `generateId` needs no store and is genuinely usable.
export { generateId, ID_PREFIX, ID_SUFFIX_LENGTH, MIN_PREFIX_LENGTH } from "./core/tasks/ids.js";
// What `close`, `cancel` and `reopen` print.
export type { LifecycleResult } from "./core/tasks/lifecycle.js";
// What `next` prints — a discriminated union, so the empty case still carries
// the blocked tasks rather than being indistinguishable from "no work left".
export type { BlockedTask, NextResult } from "./core/tasks/next.js";
// What `list` prints.
export type { TaskList } from "./core/tasks/repo.js";
// The task model: what `add` and `show` print.
export type { Task, TaskDetail, TaskSummary } from "./core/tasks/types.js";
export { VERSION } from "./version.js";
