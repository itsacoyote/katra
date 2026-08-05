/**
 * Turning untrusted values into katra's fixed types.
 *
 * Two boundaries need this and must agree: strings arriving from the command
 * line, and columns read back out of the database. Both are untrusted — the
 * store is written by concurrent processes and potentially by older builds —
 * so both narrow through a predicate rather than asserting with `as`.
 */

import type { EventType, Kind, Lane, Level, NoteKind, Priority } from "./enums.js";
import {
  EVENT_TYPES,
  isEventType,
  isKind,
  isLane,
  isLevel,
  isNoteKind,
  isPriority,
  KINDS,
  LANES,
  LEVELS,
  NOTE_KINDS,
  PRIORITIES,
} from "./enums.js";
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

export function narrowEventType(value: unknown): EventType {
  return isEventType(value) ? value : invalid("event type", value, EVENT_TYPES);
}

/**
 * Narrows a *note's* kind — `general`/`handoff`/… — not a task's.
 *
 * The field is called "note kind" rather than "kind" so the refusal says which
 * of the two sets it means. {@link narrowKind} is the other one; nothing wires
 * them together and no value belongs to both.
 */
export function narrowNoteKind(value: unknown): NoteKind {
  return isNoteKind(value) ? value : invalid("note kind", value, NOTE_KINDS);
}

export function narrowPriority(value: unknown): Priority {
  // Command-line values arrive as strings; a numeric one is the same priority.
  const candidate = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return isPriority(candidate) ? candidate : invalid("priority", value, PRIORITIES);
}

/**
 * The largest count any `--limit` accepts.
 *
 * Far above any real backlog, and low enough that the value always binds
 * cleanly as a SQLite integer.
 */
export const MAX_COUNT = 1_000_000;

/**
 * Narrows a command-line count — a `--limit`, and whatever follows it.
 *
 * Command-line values arrive as strings, and `Number("")`, `Number(" ")` and
 * `Number("[]")` are all `0` rather than `NaN` — so a blank or nonsense value
 * would silently mean "return nothing" instead of being refused. Zero itself
 * is a legitimate answer, which is why it cannot double as the rejection.
 */
export function narrowCount(value: unknown, field: string): number {
  const candidate = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  // `Number.isSafeInteger`, not `isInteger`: 1e21 satisfies the latter, then
  // better-sqlite3 refuses to bind it and the failure surfaces as `internal`
  // and exit 4 — telling an agent to escalate a broken machine over a typo
  // (ADR-005). Anything past 2^53 also loses precision silently on the way in.
  if (
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_COUNT
  ) {
    return candidate;
  }
  throw new KatraException({
    code: "validation",
    message:
      `${field} must be a whole number of items between 0 and ${MAX_COUNT} — ` +
      `got ${JSON.stringify(value)}`,
    field,
    value,
  });
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
