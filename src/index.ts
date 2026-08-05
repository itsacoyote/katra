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

// The `--json` documents, and the warning envelope every one of them can
// carry. They live in `core/contract.ts`, which imports nothing that touches
// the database — declarations are emitted per file, so a type re-exported from
// here drags its whole import graph into the published `.d.ts`. Sourcing these
// from the modules that produce them put `import Database from "better-sqlite3"`
// into `dist/index.d.ts` by way of `OpenStore`, breaking any consumer that had
// not set `skipLibCheck`.
export type {
  BlockedTask,
  Blocker,
  DeleteResult,
  DependencyResult,
  EventLog,
  HelpDocument,
  InitResult,
  JsonDocument,
  LifecycleResult,
  LinkResult,
  NextResult,
  NoteList,
  StoreWarning,
  TaskList,
  UpdateResult,
  VersionDocument,
} from "./core/contract.js";
// The fixed value sets and their derived types.
export {
  EVENT_TYPES,
  type EventType,
  isEventType,
  isKind,
  isLane,
  isLevel,
  isNoteKind,
  isPriority,
  isTerminal,
  KINDS,
  type Kind,
  LANES,
  type Lane,
  LEVELS,
  type Level,
  NOTE_KIND_DEFAULT,
  NOTE_KINDS,
  type NoteKind,
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
// The event stream's shapes. `events/types.ts` imports only from `enums.ts`,
// so it joins the published graph without dragging the storage engine in.
export type { LoggedEvent, NewEvent, StoredEvent } from "./core/events/types.js";
// Identity. `resolveId` and `requireId` are not re-exported: they take an
// `OpenStore`, so publishing them would put the storage handle into the public
// API through a parameter. `generateId` needs no store and is genuinely usable.
export {
  generateId,
  ID_PREFIX,
  ID_SUFFIX_LENGTH,
  MIN_PREFIX_LENGTH,
} from "./core/id-format.js";
// The note model: what `note add` and `note list` print.
export type { NewNote, Note, NoteFilters } from "./core/notes/types.js";
// The task model: what `add` and `show` print.
export type { Task, TaskDetail, TaskSummary } from "./core/tasks/types.js";
export { VERSION } from "./version.js";
