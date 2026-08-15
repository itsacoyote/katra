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

/** Milliseconds in the units {@link timeAgo} and {@link parseWhen} step through. */
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

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

// ---------------------------------------------------------------------------
// "When" parsing — the shared grammar for time-window flags
// ---------------------------------------------------------------------------

/**
 * A relative duration: an integer count and one unit letter — `w`/`d`/`h`/`m`,
 * case-insensitive — `2w`, `3d`, `12h`, `30m`. No sign, no fractional count,
 * no combined units (`2w3d`): the whole input must match this shape or it
 * falls through to the absolute-timestamp checks in {@link parseWhen} and
 * ultimately refuses.
 */
const RELATIVE_DURATION_PATTERN = /^(\d+)([wdhm])$/i;

/** Milliseconds per unit letter {@link RELATIVE_DURATION_PATTERN} accepts. */
const DURATION_UNIT_MS: Record<string, number> = {
  w: MS_PER_WEEK,
  d: MS_PER_DAY,
  h: MS_PER_HOUR,
  m: MS_PER_MINUTE,
};

/**
 * katra's own canonical timestamp shape (module docstring; {@link toIso}) —
 * the only absolute form {@link parseWhen} accepts at full width:
 * `YYYY-MM-DDTHH:MM:SS.sssZ`, exactly 24 characters, exactly 3-digit
 * milliseconds.
 *
 * Gating on this before ever calling `Date.parse` is the same discipline
 * `beads/mapping.ts`'s `normalizeTimestamp` established for F5 (read it
 * before changing this): `Date.parse` alone also accepts ECMA-262's
 * *expanded* year (`"+275760-09-13T...Z"`, a 6-digit year with a leading
 * sign) and, for anything outside the standard grammar, silently falls back
 * to an implementation-defined, host-locale-dependent parser
 * (`Date.parse("Dec 25 1995")`) — either would make the same input parse to
 * a different result on a different machine, or produce a timestamp of the
 * wrong width. Matching this pattern first means only one, unambiguous,
 * UTC-anchored shape ever reaches `Date.parse`; everything else — expanded
 * years, locale-grammar strings, garbage — refuses without `Date.parse`
 * ever seeing it.
 */
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A bare calendar date — `YYYY-MM-DD` — the second absolute form
 * {@link parseWhen} accepts, normalized to midnight UTC on that date.
 */
const BARE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The forms {@link parseWhen} accepts, named in every refusal it raises. */
export const WHEN_ACCEPTED_FORMS =
  "a relative duration (2w, 3d, 12h, 30m) or an absolute timestamp " +
  "(YYYY-MM-DDTHH:MM:SS.sssZ or YYYY-MM-DD)";

/**
 * True when `ms`'s UTC calendar date matches the year/month/day literally
 * written in `input` — the first ten characters of either absolute form
 * {@link parseWhen} accepts (`YYYY-MM-DD`, always at that fixed offset in
 * both {@link CANONICAL_TIMESTAMP_PATTERN} and {@link BARE_DATE_PATTERN}).
 *
 * `Date.parse` does not refuse an out-of-range day, it silently **rolls it
 * into the following month**: `"2026-02-30"` parses to March 2nd, and
 * `"2026-04-31"` parses to May 1st (probe-verified) — exactly the
 * same-input-different-meaning leniency this module exists to keep out of a
 * stored timestamp ({@link CANONICAL_TIMESTAMP_PATTERN}'s own docs cover the
 * identical `Date.parse` leniency for *shape*; this is the calendar-validity
 * counterpart). The shape gate alone cannot catch it: `"2026-02-30"` matches
 * {@link BARE_DATE_PATTERN} exactly, and the rolled-over result is a
 * perfectly valid instant, not `NaN`. This is the second, narrower gate that
 * runs after `Date.parse` succeeds: the parsed instant's own calendar date
 * has to still be the one that was typed, or the day never existed and the
 * input refuses.
 */
function roundTripsCalendarDay(input: string, ms: number): boolean {
  const date = new Date(ms);
  return (
    date.getUTCFullYear() === Number(input.slice(0, 4)) &&
    date.getUTCMonth() + 1 === Number(input.slice(5, 7)) &&
    date.getUTCDate() === Number(input.slice(8, 10))
  );
}

function refuseWhen(input: string): never {
  throw new KatraException({
    code: "validation",
    message: `when must be ${WHEN_ACCEPTED_FORMS} — got ${JSON.stringify(input)}`,
    field: "when",
    value: input,
  });
}

/**
 * Parses a "when" value — the shared grammar behind `--older-than`,
 * `--updated-before`, and `--updated-after` (spec req 8: "stale/updated-
 * before/after all share this parser") — into katra's canonical timestamp.
 *
 * Two shapes are accepted:
 * - A **relative duration**: `2w`, `3d`, `12h`, `30m` — an integer count and
 *   one unit letter, case-insensitive. Means "now minus duration"; zero and
 *   negative counts refuse; unit arithmetic reuses the same `MS_PER_*`
 *   constants {@link timeAgo} steps through.
 * - An **absolute timestamp**: either katra's own canonical 24-char form or a
 *   bare `YYYY-MM-DD` date (widened to midnight UTC). Both route through
 *   {@link CANONICAL_TIMESTAMP_PATTERN} or {@link BARE_DATE_PATTERN}'s strict
 *   gate before `Date.parse` ever runs — no `Date.parse` leniency, no
 *   expanded years, no locale grammar; see {@link CANONICAL_TIMESTAMP_PATTERN}'s
 *   docstring for why that matters. A day that passes the shape gate but does
 *   not exist on the calendar — `2026-02-30`, `2026-04-31` — still refuses:
 *   {@link roundTripsCalendarDay} catches the rollover `Date.parse` would
 *   otherwise apply silently (its own docstring has the probe evidence).
 *
 * `now` is the caller's own clock reading (typically {@link nowIso}'s
 * output), threaded through rather than read internally — this function is
 * pure and deterministic, so a given `input`/`now` pair always produces the
 * same result.
 *
 * **Boundary semantics, pinned once here:** the value this returns is a
 * comparison cutoff every caller (`stale`, `--updated-before`,
 * `--updated-after`) uses as **strictly older than** — an item whose
 * activity lands exactly on the cutoff instant is *not* stale. Callers
 * compare with `<`, never `<=`.
 */
export function parseWhen(input: string, now: string): string {
  const relative = RELATIVE_DURATION_PATTERN.exec(input);
  if (relative) {
    const countText = relative[1];
    const unitText = relative[2];
    const count = countText !== undefined ? Number(countText) : Number.NaN;
    const unitMs = unitText !== undefined ? DURATION_UNIT_MS[unitText.toLowerCase()] : undefined;
    if (count > 0 && unitMs !== undefined) {
      return toIso(new Date(Date.parse(now) - count * unitMs));
    }
    refuseWhen(input);
  }

  if (CANONICAL_TIMESTAMP_PATTERN.test(input) || BARE_DATE_PATTERN.test(input)) {
    const dateText = BARE_DATE_PATTERN.test(input) ? `${input}T00:00:00.000Z` : input;
    const ms = Date.parse(dateText);
    if (!Number.isNaN(ms) && roundTripsCalendarDay(input, ms)) return toIso(new Date(ms));
    refuseWhen(input);
  }

  refuseWhen(input);
}
