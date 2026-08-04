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
