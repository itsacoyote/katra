/**
 * The one place katra produces a timestamp.
 *
 * `created_at` and `updated_at` are stored as SQLite `TEXT` and sorted as text,
 * so lexicographic order has to equal chronological order. That holds only for
 * a fixed-width, zero-padded, UTC format — which is exactly what
 * `Date.prototype.toISOString()` emits. Pinning it in one helper is what stops
 * four call sites from each picking something slightly different.
 *
 * Millisecond precision is deliberate, not incidental: at second precision,
 * two rows written in the same request would routinely share a timestamp, and
 * every `created_at` tie-break would depend on the `rowid` fallback.
 */

import { KatraException } from "./errors.js";

/** Width of every timestamp katra writes: `2026-08-03T09:05:00.007Z`. */
export const ISO_TIMESTAMP_LENGTH = 24;

/** Formats an instant in katra's canonical timestamp format. */
export function toIso(date: Date): string {
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new KatraException({
      code: "validation",
      message: "cannot format an invalid Date as a timestamp",
      field: "date",
      value: date,
    });
  }
  return date.toISOString();
}

/**
 * The current instant.
 *
 * Callers inside a transaction should take this **once** and thread the same
 * value through every row they write, so entities created together share a
 * timestamp rather than drifting by a millisecond mid-write.
 */
export function nowIso(): string {
  return toIso(new Date());
}
