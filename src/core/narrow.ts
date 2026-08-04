/**
 * Turning untrusted values into katra's fixed types.
 *
 * Two boundaries need this and must agree: strings arriving from the command
 * line, and columns read back out of the database. Both are untrusted — the
 * store is written by concurrent processes and potentially by older builds —
 * so both narrow through a predicate rather than asserting with `as`.
 */

import type { Kind, Lane, Level, Priority } from "./enums.js";
import { isKind, isLane, isLevel, isPriority, KINDS, LANES, LEVELS, PRIORITIES } from "./enums.js";
import { KatraException } from "./errors.js";

function invalid(field: string, value: unknown, allowed: readonly (string | number)[]): never {
  throw new KatraException({
    code: "validation",
    message: `${field} must be one of ${allowed.join(", ")} — got ${JSON.stringify(value)}`,
    field,
    value,
  });
}

export function narrowLevel(value: unknown): Level {
  return isLevel(value) ? value : invalid("level", value, LEVELS);
}

export function narrowKind(value: unknown): Kind {
  return isKind(value) ? value : invalid("kind", value, KINDS);
}

export function narrowLane(value: unknown): Lane {
  return isLane(value) ? value : invalid("lane", value, LANES);
}

export function narrowPriority(value: unknown): Priority {
  // Command-line values arrive as strings; a numeric one is the same priority.
  const candidate = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return isPriority(candidate) ? candidate : invalid("priority", value, PRIORITIES);
}

/**
 * Narrows a column that must hold text.
 *
 * The four enum columns above are checked because their *values* are
 * constrained. These are checked because their *type* is: SQLite's affinity
 * rules let a BLOB sit happily in a `TEXT NOT NULL` column, and better-sqlite3
 * hands one back as a Buffer. A cast would then let it reach `formatTaskDetail`,
 * where `.trim()` throws a TypeError that surfaces as `internal` and exit 4 —
 * telling an agent to escalate a broken machine when the truth is one malformed
 * row. Under `--json` it serialises as `{"type":"Buffer","data":[…]}`, which
 * type-checks against nothing katra publishes.
 */
export function narrowText(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new KatraException({
    code: "validation",
    message: `${field} must be text — the stored value is ${typeof value}, so this row is malformed`,
    field,
    value,
  });
}

/** The same, for a column that may legitimately be NULL. */
export function narrowNullableText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : narrowText(value, field);
}
