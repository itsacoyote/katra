import { describe, expect, it } from "vitest";
import { narrowWhen } from "../../src/core/narrow.js";

describe("narrowWhen", () => {
  const now = "2026-08-13T12:00:00.000Z";

  it("narrows a valid relative duration or absolute timestamp to katra's canonical width", () => {
    expect(narrowWhen("2w", "--older-than", now)).toBe("2026-07-30T12:00:00.000Z");
    expect(narrowWhen("2026-08-03", "--updated-before", now)).toBe("2026-08-03T00:00:00.000Z");
  });

  it("narrowWhen names the flag and the accepted forms on refusal", () => {
    try {
      narrowWhen("2weeks", "--older-than", now);
      expect.unreachable("should have thrown");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // The flag name, not core's generic "when", is what the CLI caller
      // needs to see — this is the whole point of the narrow* boundary.
      expect(error.message).toContain("--older-than");
      expect(error.message).toContain("relative duration");
      expect(error.message).toContain("absolute timestamp");
      expect(error.message).toContain("2weeks");
    }
  });

  it("refuses non-string and blank values, naming the flag", () => {
    for (const bad of [undefined, null, 42, "", "   "]) {
      expect(() => narrowWhen(bad, "--updated-after", now), String(bad)).toThrowError(
        /--updated-after/,
      );
    }
  });

  it("accepts a padded duration the way narrowCount accepts padded numbers", () => {
    // parseWhen's grammar is anchored (^...$), so unlike narrowCount — where
    // Number(" 5 ") already ignores the padding — a padded value here would
    // fail the regex gate unless narrowWhen trims before parsing.
    expect(narrowWhen(" 2w ", "--older-than", now)).toBe(narrowWhen("2w", "--older-than", now));
  });
});
