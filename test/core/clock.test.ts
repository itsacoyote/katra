import { describe, expect, it } from "vitest";
import { ISO_TIMESTAMP_LENGTH, nowIso, toIso } from "../../src/core/clock.js";

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
