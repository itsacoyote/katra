/**
 * katra's public API.
 *
 * This is the package's `main`/`exports` contract: an export list, not a place
 * logic gets written. A later MCP surface imports from here rather than
 * reaching into `src/core/`.
 *
 * Note what is deliberately absent: `OpenStore` and the `better-sqlite3`
 * handle it carries. Publishing those would make the storage engine's concrete
 * type part of katra's API, so a consumer would need better-sqlite3's types
 * resolvable just to hold a store.
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

// The store handle, as a type only.
//
// `openStore` is deliberately NOT re-exported yet: it returns an `OpenStore`,
// which carries the better-sqlite3 handle, so publishing it would put the
// storage engine's concrete type back into the public API through the return
// value — the exact leak this barrel exists to prevent. A public entry point
// lands alongside the task API, once there is something for a consumer to do
// with a store.
export type { Store } from "./core/store.js";
export { VERSION } from "./version.js";
