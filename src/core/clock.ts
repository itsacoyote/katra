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

/** Milliseconds in the units {@link timeAgo} steps through. */
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * How long ago `iso` was, relative to `now`, in the coarse unit a person
 * reads at a glance rather than an exact duration: minutes, then hours, then
 * days.
 *
 * Owned here rather than in a CLI renderer because F4's claim conflict needs
 * the age **in the exception message itself** (`claims/repo.ts`) — core
 * cannot import from `cli/`, so the formatter has to live on this side of
 * that boundary. T12's board/brief/show renderers defer to this rather than
 * reimplementing it, so a claimed task's staleness reads identically
 * wherever it is shown.
 *
 * **Never negative.** `lastSeen` is somebody else's clock: skew between the
 * writer and the reader, or a presence row bumped after this instant was
 * captured, can put `iso` at or after `now`. Reporting a negative duration
 * would read as a bug rather than jitter, so anything at or after `now`
 * reads "just now" — the same instinct as clamping a countdown at zero
 * rather than letting it run past.
 *
 * Both arguments are katra's own timestamp format ({@link toIso}), not
 * `Date` objects: every caller already holds one — a transaction's `now`, or
 * a stored `last_seen` — and passing the string through avoids a redundant
 * parse-then-format round trip at each call site.
 */
export function timeAgo(iso: string, now: string): string {
  const then = Date.parse(iso);
  const current = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(current)) {
    throw new KatraException({
      code: "validation",
      message: "cannot compute an age from an unparseable timestamp",
      field: "iso",
      value: Number.isNaN(then) ? iso : now,
    });
  }

  const diffMs = current - then;
  if (diffMs < MS_PER_MINUTE) return "just now";
  if (diffMs < MS_PER_HOUR) return `${String(Math.floor(diffMs / MS_PER_MINUTE))}m ago`;
  if (diffMs < MS_PER_DAY) return `${String(Math.floor(diffMs / MS_PER_HOUR))}h ago`;
  return `${String(Math.floor(diffMs / MS_PER_DAY))}d ago`;
}

/**
 * {@link timeAgo}, but `null` instead of a thrown exception when `iso`
 * cannot be parsed — for stored values katra reads back, not ones it just
 * wrote.
 *
 * `timeAgo` stays strict for its ordinary callers, who hand it a timestamp
 * this process produced moments ago. A value read back out of the store —
 * `presence.last_seen`, a claim's `claimed_at` — comes from a row this
 * process does not fully control and should not fully trust: written by
 * another process, possibly an older build, possibly corrupted. Letting
 * `timeAgo`'s exception propagate from a rendering path would turn a
 * malformed stored timestamp into an unrelated command failure; this gives
 * the caller an honest "I don't know" to fall back on instead.
 */
export function timeAgoOrNull(iso: string, now: string): string | null {
  try {
    return timeAgo(iso, now);
  } catch {
    return null;
  }
}
