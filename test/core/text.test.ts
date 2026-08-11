import { describe, expect, it } from "vitest";
import { capText, textWidth } from "../../src/core/text.js";

/** A non-BMP character: two UTF-16 code units, one code point. */
const EMOJI = "🜃";

describe("capText", () => {
  it("leaves a string shorter than the cap exactly as it was", () => {
    expect(capText("short", 20)).toEqual({ text: "short", truncated: false });
  });

  it("leaves a string exactly at the cap alone", () => {
    // Off-by-one here would report truncation on a body that lost nothing, and
    // `brief` prints that report as prose telling the reader to go look for the
    // rest of a note that is already whole.
    expect(capText("12345", 5)).toEqual({ text: "12345", truncated: false });
  });

  it("reports truncation only when it actually cut", () => {
    expect(capText("123456", 5).truncated).toBe(true);
    expect(capText("12345", 5).truncated).toBe(false);
    expect(capText("", 5).truncated).toBe(false);
  });

  it("caps on a code-point boundary rather than mid-surrogate", () => {
    // The failure a raw `.slice()` produces: an emoji is two UTF-16 code units,
    // so cutting between them emits a lone surrogate. `brief`'s handoff cap
    // runs over pasted transcripts thousands of characters long, where a
    // non-BMP character sitting on the boundary is likely rather than exotic.
    const body = `${EMOJI.repeat(10)}tail`;

    const capped = capText(body, 5).text;

    expect(capped).toBe(EMOJI.repeat(5));
    // No lone surrogate survived: every code unit pairs up.
    expect(capped).toBe(capped.replaceAll(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/gu, "?"));
    expect(capped).toBe(capped.replaceAll(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "?"));
  });

  it("counts a non-BMP character as one, not two", () => {
    // The unit the whole task turns on. Ten emoji are twenty code units; a
    // cap of ten must keep all ten characters.
    expect(capText(EMOJI.repeat(10), 10)).toEqual({
      text: EMOJI.repeat(10),
      truncated: false,
    });
  });

  it("survives a UTF-8 round-trip without replacement characters", () => {
    // `--json` is the agent-facing contract, and a lone surrogate is not valid
    // Unicode however tolerant JS strings are about holding one. A JSON
    // round-trip cannot detect one — `JSON.stringify` escapes a lone surrogate
    // losslessly, so the first version of this test passed against a naive
    // `.slice()`. UTF-8 is the honest probe: `TextEncoder` replaces a lone
    // surrogate with U+FFFD, so encode-decode changes the string exactly when
    // the cap cut inside a pair.
    const capped = capText(`${EMOJI.repeat(10)}tail`, 7).text;

    expect(new TextDecoder().decode(new TextEncoder().encode(capped))).toBe(capped);
    expect(capped).not.toMatch(/�/u);
  });

  it("treats a cap of zero as keeping nothing", () => {
    expect(capText("anything", 0)).toEqual({ text: "", truncated: true });
  });
});

describe("textWidth", () => {
  it("measures in the same unit capText cuts in", () => {
    // The trap that makes this function exist. Column widths were computed with
    // `.length` — UTF-16 code units — while the cap counts code points. A title
    // of 44 emoji then measures 88 and pads every ASCII row in the log to 88
    // characters, so fixing the cap alone would break alignment everywhere.
    const title = EMOJI.repeat(44);

    expect(textWidth(title)).toBe(44);
    expect(title.length).toBe(88);
    expect(textWidth(capText(title, 44).text)).toBe(44);
  });

  it("agrees with length for ASCII", () => {
    expect(textWidth("plain ascii")).toBe("plain ascii".length);
  });
});

describe("clamp's boundary, through the log renderer", () => {
  it("keeps a title of exactly the column width whole", async () => {
    // The regression a naive `capText(text, width - 1)` introduces: asking the
    // shortened cap whether it truncated ellipsizes a string that fitted
    // exactly, so a boundary-length title silently loses its last character.
    const { formatEventLog } = await import("../../src/cli/format.js");
    const TITLE_WIDTH = 44;
    const stamp = "2026-01-01T00:00:00.000Z";
    const row = (title: string) => ({
      id: 1,
      type: "created" as const,
      entityId: "kt-aaaaaa",
      epicId: null,
      actor: "main @ /repo",
      fromLane: null,
      toLane: null,
      ref: null,
      reason: null,
      title,
      priorActor: null,
      entityTitle: title,
      createdAt: stamp,
    });

    const exact = "x".repeat(TITLE_WIDTH);
    const over = "x".repeat(TITLE_WIDTH + 1);

    expect(formatEventLog([row(exact)], false)).toContain(exact);
    expect(formatEventLog([row(exact)], false)).not.toContain("…");
    expect(formatEventLog([row(over)], false)).toContain("…");
  });
});

describe("capText at degenerate widths", () => {
  it("keeps nothing at a negative or NaN width, rather than everything", () => {
    // Both would otherwise never satisfy `kept.length === max`, so the string
    // came back whole with `truncated: false` — and `clamp` then appended an
    // ellipsis, returning something wider than the width it was given.
    expect(capText("ab", -1)).toEqual({ text: "", truncated: true });
    expect(capText("ab", Number.NaN)).toEqual({ text: "", truncated: true });
    expect(capText("", -1)).toEqual({ text: "", truncated: false });
  });

  it("returns a long body unchanged at an infinite cap without copying it", () => {
    // What `--full` passes. The fast path matters here: iterating would build a
    // throwaway array of every character in a 200 KB paste to return the input.
    const body = "x".repeat(200_000);

    expect(capText(body, Number.POSITIVE_INFINITY)).toEqual({ text: body, truncated: false });
  });
});

describe("capText rejects a fractional cap", () => {
  it("keeps nothing at a non-integer width", () => {
    // `kept.length === 2.5` can never fire, so a fractional cap would let the
    // whole string through with `truncated: false` — the same hole the negative
    // and NaN cases have. Infinity is the one non-integer that means something.
    expect(capText("abc", 2.5)).toEqual({ text: "", truncated: true });
    expect(capText("abc", Number.POSITIVE_INFINITY).truncated).toBe(false);
  });
});
