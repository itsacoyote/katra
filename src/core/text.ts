/**
 * Cutting stored text to a length, without cutting a character in half.
 *
 * In `core/` rather than beside the formatters that also use it, because the
 * cap that matters most happens **before** rendering: `brief` bounds a handoff
 * body inside its assembly, so the bound is part of the `--json` document, and
 * `--json` never passes through `cli/format.ts`. Core imports nothing from the
 * CLI — the dependency runs one way — so a helper living there would be
 * unreachable from the module that needs it.
 *
 * Nothing here sanitises. Stripping control characters is a rendering concern
 * and stays in `cli/format.ts`, where `--json` deliberately does not go: a
 * value altered on the way out would no longer be what was stored.
 */

/**
 * How long a string is, in characters a reader would count.
 *
 * `String.length` counts UTF-16 code units, so a single emoji measures two and
 * a column sized by it pads every other row to twice the width it needs. This
 * is the unit {@link capText} cuts in, and the two must agree: a cap measured
 * in code points against a width measured in code units misaligns exactly the
 * rows that contain the interesting characters.
 *
 * Still an approximation of *display* width — a combining sequence counts once
 * per code point, and East Asian characters occupy two terminal columns while
 * counting as one. Both are improvements over code units, and neither is worth
 * a grapheme segmenter here: the consequence is a slightly ragged column, not
 * a broken character.
 */
export function textWidth(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Text cut to a length, and whether anything was lost doing it. */
export interface CappedText {
  readonly text: string;
  /**
   * True when the cap removed something.
   *
   * Reported rather than left for the caller to infer from the length, for the
   * reason every bound in katra reports itself: a bound that cannot say so is
   * indistinguishable from the end of the data. Here that means a handoff note
   * that looks complete and is not — worse than an absent one, because a reader
   * acts on it.
   */
  readonly truncated: boolean;
}

/**
 * Cuts `text` to at most `max` characters, never mid-character.
 *
 * The naive `text.slice(0, max)` splits a surrogate pair — an emoji, a rarer
 * CJK ideograph, a mathematical symbol — and emits a lone surrogate, which
 * renders as a broken glyph and is not valid Unicode even though a JavaScript
 * string will happily hold one. That matters most exactly where this is used:
 * `brief` caps pasted transcripts thousands of characters long, so a non-BMP
 * character landing on the boundary is likely rather than exotic, and `--json`
 * is a contract another agent parses.
 *
 * Iterating by code point costs a pass over the string. Given the alternative
 * is a corrupt character in the one field the whole feature exists to hand to
 * another session, that is not a trade worth making.
 */
export function capText(text: string, max: number): CappedText {
  // A width that is negative or NaN would otherwise never satisfy the
  // `kept.length === max` test below, so the string would come back whole and
  // `clamp` would append an ellipsis to it — returning something *wider* than
  // the width it was given, from the helper whose job is bounding text.
  // Also rejects a non-integer: `kept.length === 2.5` can never fire, so a
  // fractional cap would let the whole string through with `truncated: false` —
  // the same failure the negative and NaN cases produce. Infinity is the one
  // non-integer that means something here.
  if (!(max >= 0) || (max !== Number.POSITIVE_INFINITY && !Number.isInteger(max))) {
    return { text: "", truncated: text !== "" };
  }

  // Code units are never fewer than code points, so a string that fits by this
  // measure fits by the real one. It is what keeps `--full` — where `max` is
  // Infinity — from building a throwaway array of every character in a 200 KB
  // paste just to discard it and return the input.
  if (text.length <= max) return { text, truncated: false };

  const kept: string[] = [];
  for (const char of text) {
    if (kept.length === max) return { text: kept.join(""), truncated: true };
    kept.push(char);
  }
  return { text, truncated: false };
}
