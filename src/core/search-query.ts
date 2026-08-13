/**
 * The one place untrusted search text becomes a piece of SQL syntax:
 * building a safe FTS5 MATCH expression, and classifying text that is
 * plausibly an id fragment rather than search text.
 *
 * Pure string logic — no store or `better-sqlite3` import, deliberately, for
 * the same reason `id-format.ts` stays free of `OpenStore`: this module's
 * declarations are safe to re-export from a store-touching read module (T5)
 * without dragging the database handle into that module's published types.
 * `id-format.ts` / `tasks/ids.ts` is the precedent this split follows.
 *
 * The MATCH scheme below is probe-verified against a real FTS5 table, not
 * derived from the grammar on paper — see the epic's risk-notes comment
 * (katra-9aw.54) for the probe evidence this file encodes.
 */

import { ID_PREFIX, MIN_PREFIX_LENGTH } from "./id-format.js";

/**
 * The lowercase base36 alphabet a katra id is drawn from: `0-9`, `a-z`.
 *
 * Mirrors, rather than imports, `id-format.ts`'s private `ALPHABET` constant
 * — that constant is not exported (only the shape it produces is, via
 * {@link ID_PREFIX} / {@link MIN_PREFIX_LENGTH} / `idPattern`), and this
 * module's write surface does not extend to widening that file's exports.
 * If the id alphabet ever changes, this must change with it.
 */
const BASE36 = /^[0-9a-z]+$/;

/**
 * Hard cap on how many tokens {@link matchExpression} builds a query from.
 *
 * FTS5 MATCH cost is driven by token COUNT, not token length — measured
 * directly against a throwaway table: cost stays roughly linear for a
 * while, then gets markedly worse; 100k tokens took around 35 seconds and
 * 500k did not finish in a reasonable time. An agent pasting a large block
 * of text as a "query" (a whole file, a stack trace) is a real shape for
 * this feature to see, and a read command should not be able to hang on it.
 *
 * Truncating rather than refusing: past this cap the query silently
 * degrades to its first {@link MAX_TOKENS} terms instead of erroring or
 * hanging — a search that is narrower than what was typed, not a usage
 * error. Refusing a long paste outright is a worse experience than
 * searching on its first 32 words, and hanging is worse still. 32 is
 * generous for anything that reads as a search query (ordinary queries are
 * a handful of words) and stays well inside the cheap end of the measured
 * cost curve.
 */
export const MAX_TOKENS = 32;

/**
 * Builds a safe FTS5 MATCH expression from raw, untrusted query text.
 *
 * Scheme (probe-verified, katra-9aw.54 risk notes):
 *   1. Replace any NUL character (U+0000) with a space, then split on
 *      whitespace; drop empty tokens. FTS5 reads each phrase as a
 *      NUL-terminated C string, so a NUL left inside a quoted token
 *      truncates the phrase mid-string and throws "unterminated string" —
 *      probe-verified. A NUL cannot arrive via a CLI argv, but this
 *      function is also reachable as a library call and through the MCP
 *      surface, where a JSON string encodes a NUL without any trouble —
 *      so it is treated as a separator, exactly like ordinary whitespace,
 *      rather than stripped or rejected outright.
 *   2. Phrase-quote EACH token individually: wrap it in double quotes,
 *      doubling any embedded double quote (`"` becomes `""`, FTS5's escape
 *      for a literal quote inside a phrase).
 *   3. Join the quoted tokens with single spaces. Juxtaposed phrases are
 *      FTS5's implicit AND — this is what makes "auth mig" require both
 *      "auth" and something starting with "mig" to appear, without either
 *      needing to be adjacent to the other in the indexed text.
 *   4. Append `*` directly after the FINAL token's closing quote (outside
 *      it, not inside) for a trailing prefix match — "mig" also finds
 *      "migration".
 *   5. Keep at most the first {@link MAX_TOKENS} tokens — see its docstring
 *      for why this truncates rather than refuses.
 *
 * Quoting is per-token, never whole-query. Quoting the entire query as one
 * phrase turns step 3's implicit AND into an adjacency requirement instead —
 * "auth mig" would then only match text where "auth" is immediately followed
 * by a word starting with "mig", breaking the AC 2 case where "migration"
 * appears elsewhere in the same row.
 *
 * The quoting is also what makes every FTS5 operator inert: AND, OR, NOT,
 * NEAR, bare `*`, bare `-`, and parentheses are all just characters once
 * they are inside a quoted phrase, so `mig" OR 1--` becomes the three literal
 * phrases `"mig"""` `"OR"` `"1--"*` rather than an injected boolean OR.
 * Quoting every token — even ones with no operator characters — also avoids
 * FTS5's bareword MATCH throwing on an unescaped hyphen: unquoted `kt-9nfn9v`
 * or `beads-migration` crash with "no such column", because bareword MATCH
 * parses a hyphen as column-filter syntax.
 *
 * No column parameter, on purpose. Scoping MATCH to a single column (as in
 * `title: term`) was probe-tested and rejected: it narrows recall across
 * exactly the columns this feature searches (title, description, note
 * body) rather than usefully filtering results, and the feature already has
 * a separate mechanism for narrowing — the `--lane`/`--kind`/`--epic`/etc.
 * WHERE-clause filters (spec req 5). Do not re-add a column argument here on
 * a "this looks safer/more precise" instinct without re-running that probe:
 * it looks like an obvious improvement and measures as a regression.
 *
 * Returns `null` only when there is no token to search on — an empty or
 * whitespace-only query, the one input FTS5's MATCH throws on for `''`.
 * Every other input, including punctuation-only or emoji-only text, produces
 * a syntactically valid expression: this function does whitespace-splitting,
 * not tokenization, so it has no idea unicode61 will later drop punctuation
 * and emoji as non-word characters. The expression still executes cleanly —
 * it just matches nothing, which is a valid zero-result search (spec AC 5),
 * not a usage error. The one query-shaped usage refusal in this feature is
 * `search` called with neither text nor filters (spec req 5); that decision
 * belongs to the caller, not here — this function never throws.
 */
export function matchExpression(text: string): string | null {
  const tokens = text
    .replaceAll("\u0000", " ")
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .slice(0, MAX_TOKENS);
  if (tokens.length === 0) return null;

  const phrases = tokens.map((token, index) => {
    const quoted = `"${token.replaceAll('"', '""')}"`;
    return index === tokens.length - 1 ? `${quoted}*` : quoted;
  });
  return phrases.join(" ");
}

/**
 * Classifies `text` as a plausible katra id fragment — the check `search`
 * (T5) runs to decide whether a query should also run the separate id-prefix
 * lookup, not a validation of a real, existing id.
 *
 * Strips a leading `kt-` if present, then requires every remaining character
 * to be in {@link BASE36} and the remaining length to be at least
 * {@link MIN_PREFIX_LENGTH}. Case-sensitive throughout: `generateId` never
 * produces uppercase, so `9F` and `KT-9n` are not plausible fragments — they
 * classify as ordinary search text instead.
 *
 * Id lookup never goes through FTS5 MATCH: an id like `kt-9nfn9v` either
 * crashes bareword MATCH on the hyphen or, quoted, tokenizes into noise (the
 * "kt" token alone matches almost everything). A fragment this function
 * accepts is resolved with a separate range-bound query against `tasks.id`
 * — the same measured-range-over-LIKE approach `tasks/ids.ts` already uses —
 * never with {@link matchExpression}.
 *
 * Returns the fragment with any `kt-` prefix already stripped — the id
 * lookup builds its own range bounds from the bare fragment — or `null`
 * when `text` is not plausibly an id.
 */
export function idFragment(text: string): string | null {
  const stripped = text.startsWith(ID_PREFIX) ? text.slice(ID_PREFIX.length) : text;
  if (stripped.length < MIN_PREFIX_LENGTH) return null;
  if (!BASE36.test(stripped)) return null;
  return stripped;
}
