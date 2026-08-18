/**
 * What the GitHub and Linear providers share — kept to exactly the two
 * things both need, not a general provider-utilities dumping ground.
 *
 * `refs/repo.ts`'s `applyRefreshWithin` has its own, deliberately separate
 * copy of the title-sanitizing logic one layer down, at the write seam
 * (belt-and-suspenders across a real trust boundary, not laziness) — this
 * module is the *provider* layer's one shared copy, not a third
 * consolidation target for that one.
 */

import { MAX_CACHED_TITLE_LENGTH } from "../refs/parse.js";
import { CONTROL_CHARS_SOURCE, capText } from "../text.js";

/**
 * Screens every control character out of a title — built once at module
 * load from the imported {@link CONTROL_CHARS_SOURCE}, flagged `/g` for
 * `replaceAll`, never rebuilt per call and never re-derived from
 * `CONTROL_CHARS_PATTERN.source` at call time. The identical construction
 * `refs/repo.ts`'s `applyRefreshWithin` uses for its own, separate copy of
 * this regex — `text.ts`'s own module doc is explicit that a consumer
 * needing `replaceAll` builds its own `/g` pattern from
 * `CONTROL_CHARS_SOURCE` rather than flagging the unflagged
 * `CONTROL_CHARS_PATTERN` export.
 */
const TITLE_CONTROL_CHARS_PATTERN = new RegExp(`[${CONTROL_CHARS_SOURCE}]`, "g");

/**
 * Bounds a provider-supplied title: screened of every control character,
 * then capped to {@link MAX_CACHED_TITLE_LENGTH} code points with
 * `capText`. Never refuses — a control character or an oversized title is
 * a reason to bound what comes out of a resolve, not to fail it outright.
 * A non-string `title` (missing from a response) becomes `null`: "no
 * title" is an ordinary outcome, not a parse failure.
 */
export function sanitizeProviderTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const screened = title.replaceAll(TITLE_CONTROL_CHARS_PATTERN, "");
  return capText(screened, MAX_CACHED_TITLE_LENGTH).text;
}

/**
 * Parses `text` as JSON and requires the result to be a non-null object —
 * the shape both providers' response bodies must have before either
 * narrows further to its own specific fields. Returns `undefined` for
 * anything else (malformed JSON, a bare primitive, `null`), never throws.
 */
export function parseJsonObject(text: string): object | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  return parsed;
}
