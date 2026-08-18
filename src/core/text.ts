/**
 * Cutting stored text to a length without splitting a character, plus the
 * control-character vocabulary every consumer of untrusted text shares.
 *
 * In `core/` rather than beside the formatters that also use it, because the
 * cap that matters most happens **before** rendering: `brief` bounds a handoff
 * body inside its assembly, so the bound is part of the `--json` document, and
 * `--json` never passes through `cli/format.ts`. Core imports nothing from the
 * CLI — the dependency runs one way — so a helper living there would be
 * unreachable from the module that needs it.
 *
 * {@link CONTROL_CHARS_SOURCE} and {@link CONTROL_CHARS_PATTERN} draw the same
 * line: this module owns the *vocabulary* of what counts as a control
 * character, never the *policy* of what to do about one. Stripping is a
 * rendering concern (`cli/format.ts`'s `oneLine` and its layout-preserving
 * variant); refusing outright is a validation concern (`core/refs/parse.ts`
 * today, `core/providers/` from T3/T4 on) — both stay with the consumer that
 * makes the call, not here. Before this export existed, `parse.ts` and
 * `format.ts` each carried their own copy of the same character class; new
 * consumers import this one instead of writing a third.
 */

/**
 * Regex source text for the control-character class body — C0 (NUL through
 * Unit Separator), DEL through the C1 controls, and the two Unicode line
 * separators (LINE SEPARATOR / PARAGRAPH SEPARATOR) — without the enclosing
 * `[...]`. A consumer wraps it in brackets and picks its own flags, rather
 * than parsing {@link CONTROL_CHARS_PATTERN}'s source back apart to get a
 * differently-flagged copy.
 */
export const CONTROL_CHARS_SOURCE = "\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029";

/**
 * Matches one control character from {@link CONTROL_CHARS_SOURCE}.
 *
 * **Deliberately unflagged.** A `/g`-flagged pattern is stateful across
 * `.test()` calls — each call resumes from `lastIndex`, so testing the exact
 * same string twice in a row can answer `true` then `false` even though
 * nothing about the string changed between the two calls. Every current use
 * of this export is a yes/no refusal check, where that statefulness would be
 * a silent, call-order-dependent bug rather than a performance detail. A
 * consumer that needs `replaceAll` — `cli/format.ts`'s `oneLine` — builds its
 * own `/g` regex from {@link CONTROL_CHARS_SOURCE} instead of flagging this
 * one. `cli/format.ts`'s `CONTROLS_KEEPING_LAYOUT` (tab and newline excluded,
 * for text rendered across several lines) stays a separate, deliberately
 * different class for that reason — not a derivative of this one, which
 * matches tab and newline like every other control character.
 */
export const CONTROL_CHARS_PATTERN = new RegExp(`[${CONTROL_CHARS_SOURCE}]`);

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
