import { describe, expect, it } from "vitest";
import { ISO_TIMESTAMP_LENGTH, nowIso, parseWhen, timeAgo, toIso } from "../../src/core/clock.js";

describe("clock", () => {
  it("produces a fixed-width ISO-8601 timestamp ending in Z", () => {
    const stamp = nowIso();

    expect(stamp).toHaveLength(ISO_TIMESTAMP_LENGTH);
    expect(stamp).toHaveLength(24);
    expect(stamp.endsWith("Z")).toBe(true);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("produces timestamps that sort lexicographically in chronological order", () => {
    // created_at is stored as TEXT and sorted as text, so lexicographic order
    // must equal chronological order. A variable-width or non-padded format
    // would silently produce the wrong order — this is the whole reason the
    // format is pinned rather than left to the call site.
    const chronological = [
      toIso(new Date("1999-12-31T23:59:59.999Z")),
      toIso(new Date("2000-01-01T00:00:00.000Z")),
      toIso(new Date("2026-08-03T09:05:00.007Z")),
      toIso(new Date("2026-08-03T09:05:00.070Z")),
      toIso(new Date("2026-08-03T10:00:00.000Z")),
      toIso(new Date("2026-12-31T23:59:59.999Z")),
    ];

    const lexicographic = [...chronological].sort();

    expect(lexicographic).toEqual(chronological);
  });

  it("pads every component so widths never vary", () => {
    // Single-digit months, days, and sub-100ms values are where an unpadded
    // format breaks sorting.
    expect(toIso(new Date(Date.UTC(2026, 0, 5, 4, 3, 2, 7)))).toBe("2026-01-05T04:03:02.007Z");
  });

  it("normalises a non-UTC input to UTC", () => {
    // Date holds an instant, not a zone. Two Dates for the same instant must
    // render identically regardless of how they were constructed.
    const fromEpoch = toIso(new Date(1_770_000_000_000));
    const fromOffsetString = toIso(new Date("2026-02-02T02:40:00.000+02:00"));

    // Compared against a literal, not against `toIso` of an equivalent Date:
    // the latter is the function under test on both sides, so any
    // deterministic implementation — including one that never converts to UTC
    // at all — satisfies it.
    expect(fromEpoch.endsWith("Z")).toBe(true);
    expect(fromOffsetString).toBe("2026-02-02T00:40:00.000Z");
  });

  it("rejects an invalid date rather than emitting 'Invalid Date'", () => {
    expect(() => toIso(new Date("not a date"))).toThrow();
  });
});

describe("timeAgo", () => {
  const now = "2026-08-11T12:00:00.000Z";

  it("describes ages in minutes, hours and days", () => {
    expect(timeAgo("2026-08-11T11:59:30.000Z", now)).toBe("just now");
    expect(timeAgo("2026-08-11T11:55:00.000Z", now)).toBe("5m ago");
    expect(timeAgo("2026-08-11T11:00:01.000Z", now)).toBe("59m ago");
    expect(timeAgo("2026-08-11T10:00:00.000Z", now)).toBe("2h ago");
    expect(timeAgo("2026-08-10T13:00:00.000Z", now)).toBe("23h ago");
    expect(timeAgo("2026-08-09T12:00:00.000Z", now)).toBe("2d ago");
    expect(timeAgo("2026-07-01T12:00:00.000Z", now)).toBe("41d ago");
  });

  it("treats a future last-seen as just now", () => {
    // Clock skew between the reader and the writer, or a presence row bumped
    // after `now` was captured, can put `iso` at or after `now`. A negative
    // duration would read as a bug rather than jitter.
    expect(timeAgo("2026-08-11T12:00:00.000Z", now)).toBe("just now");
    expect(timeAgo("2026-08-11T13:00:00.000Z", now)).toBe("just now");
  });
});

describe("parseWhen", () => {
  const now = "2026-08-13T12:00:00.000Z";

  it("parses relative durations against the supplied now", () => {
    // now minus duration, computed off the passed `now` — never an internal
    // clock read, so the same input always produces the same output.
    expect(parseWhen("2w", now)).toBe("2026-07-30T12:00:00.000Z");
    expect(parseWhen("3d", now)).toBe("2026-08-10T12:00:00.000Z");
    expect(parseWhen("12h", now)).toBe("2026-08-13T00:00:00.000Z");
    expect(parseWhen("30m", now)).toBe("2026-08-13T11:30:00.000Z");

    // Case-insensitive unit letters.
    expect(parseWhen("2W", now)).toBe(parseWhen("2w", now));
    expect(parseWhen("3D", now)).toBe(parseWhen("3d", now));
    expect(parseWhen("12H", now)).toBe(parseWhen("12h", now));
    expect(parseWhen("30M", now)).toBe(parseWhen("30m", now));
  });

  it("parses canonical ISO and bare dates to the canonical width", () => {
    const canonical = parseWhen("2026-08-03T09:05:00.007Z", now);
    expect(canonical).toBe("2026-08-03T09:05:00.007Z");
    expect(canonical).toHaveLength(ISO_TIMESTAMP_LENGTH);

    const bareDate = parseWhen("2026-08-03", now);
    expect(bareDate).toBe("2026-08-03T00:00:00.000Z");
    expect(bareDate).toHaveLength(ISO_TIMESTAMP_LENGTH);
  });

  it("refuses zero, negative, unitless and misspelled durations naming the accepted forms", () => {
    for (const bad of ["0d", "0w", "-3d", "-1h", "5", "2weeks", "3 days", "2w3d", "d", "w12"]) {
      expect(() => parseWhen(bad, now), bad).toThrowError(/relative duration|absolute timestamp/);
    }
  });

  it("refuses expanded-year and locale-grammar timestamps", () => {
    // Same F5 lesson as beads/mapping.ts's normalizeTimestamp: Date.parse
    // alone accepts ECMA-262's expanded year and falls back to a
    // host-locale-dependent grammar for anything else. This gate must never
    // let either reach Date.parse.
    for (const bad of [
      "+275760-09-13T00:00:00.000Z",
      "Dec 25 1995",
      "2026-08-03T09:05:00Z", // second-precision — not katra's canonical width
      "08/03/2026",
      "2026-08-03T09:05:00.00Z", // 2-digit ms, not the canonical 3
      "2026-13-01", // month 13 — the Date.parse-returns-NaN refusal path
      "2026-13-01T00:00:00.000Z",
    ]) {
      expect(() => parseWhen(bad, now), bad).toThrowError(/relative duration|absolute timestamp/);
    }
  });

  it("refuses a calendar day that does not exist, even though Date.parse would silently roll it forward", () => {
    // Date.parse does not refuse an out-of-range day, it rolls it into the
    // following month: "2026-02-30" parses to March 2nd, "2026-04-31" to May
    // 1st (roundTripsCalendarDay's docstring has the probe evidence). The
    // shape gate alone cannot catch this — both inputs match BARE_DATE_PATTERN
    // exactly, and the rolled-over result is a valid instant, not NaN.
    for (const bad of ["2026-02-30", "2026-04-31"]) {
      expect(() => parseWhen(bad, now), bad).toThrowError(/relative duration|absolute timestamp/);
    }

    // Real calendar dates, including a leap day, still accept — the guard
    // rejects only inputs whose parsed instant lands on a different day than
    // the one typed.
    expect(parseWhen("2026-02-28", now)).toBe("2026-02-28T00:00:00.000Z");
    expect(parseWhen("2028-02-29", now)).toBe("2028-02-29T00:00:00.000Z");
  });

  it("refuses garbage input, naming the accepted forms", () => {
    for (const bad of ["", "not a date", "tomorrow"]) {
      expect(() => parseWhen(bad, now), bad).toThrowError(/relative duration|absolute timestamp/);
    }
  });
});
