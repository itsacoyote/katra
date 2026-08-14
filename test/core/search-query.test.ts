import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ID_PREFIX, MIN_PREFIX_LENGTH } from "../../src/core/id-format.js";
import { idFragment, MAX_TOKENS, matchExpression } from "../../src/core/search-query.js";

type DB = Database.Database;

/**
 * A throwaway FTS5 table, independent of migration 0004 — this module is
 * pure string logic and the hostile-corpus test exists to prove the built
 * expressions execute against a *real* FTS5 engine, not merely that they
 * look plausible. One unscoped column is enough: `matchExpression` builds no
 * column-scoped syntax (its docstring explains why), so a multi-column table
 * would test a shape this module never produces.
 */
function ftsTable(): DB {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
  return db;
}

function seed(db: DB, body: string): void {
  db.prepare("INSERT INTO docs (body) VALUES (?)").run(body);
}

function matchCount(db: DB, expression: string): number {
  return (
    db.prepare("SELECT count(*) AS n FROM docs WHERE docs MATCH ?").get(expression) as { n: number }
  ).n;
}

/** Asserts non-null and narrows, for callers that need the string. */
function unwrap(expression: string | null): string {
  if (expression === null) throw new Error("expected a non-null expression");
  return expression;
}

/**
 * Every entry must build an expression that executes against real FTS5
 * without throwing — FTS5 operators, embedded quotes, hyphens (the bareword
 * MATCH crash from the risk notes), punctuation-only, emoji-only, CJK, and
 * mixes of all of it.
 */
const HOSTILE_CORPUS: readonly string[] = [
  "auth mig",
  "kt-9nfn9v",
  "beads-migration",
  '" OR 1--',
  'mig" OR 1--',
  "NEAR(a, b)",
  "term*",
  "-term",
  "term OR other",
  "(parens) AND [brackets]",
  '"already quoted"',
  "trailing-hyphen-",
  "--double-hyphen",
  "!!!",
  "????",
  "😀😀😀",
  "🔥🚀✨",
  "日本語 テスト",
  "mix 日本語 and text with a-hyphen",
  "col: value",
  // Embedded NUL mid-token: pre-fix, this stays inside one bareword-quoted
  // token and FTS5's NUL-terminated C-string handling truncates the phrase
  // mid-string ("unterminated string"). Post-fix it is a separator, so this
  // becomes the ordinary two-token "auth" / "mig"* case.
  "auth\u0000mig",
  // A lone NUL: same crash pre-fix. Post-fix it is treated as whitespace,
  // like the all-whitespace case, and collapses to null -- a legitimate
  // no-search outcome, not something the loop below executes.
  "\u0000",
  // A bare double quote as the FINAL token exercises the `""* ` path: the
  // token's own content doubles to nothing, producing an empty phrase
  // immediately followed by the prefix star.
  'auth "',
  // A lone (unpaired) UTF-16 surrogate: not valid on its own in UTF-8, and
  // exercises the boundary between "safe to quote" and "safe to bind".
  "\ud800",
];

describe("matchExpression", () => {
  it("builds expressions that execute for every corpus entry", () => {
    const db = ftsTable();
    try {
      for (const input of HOSTILE_CORPUS) {
        let expression: string | null = null;
        expect(
          () => {
            expression = matchExpression(input);
          },
          `matchExpression threw building for ${JSON.stringify(input)}`,
        ).not.toThrow();

        // A lone NUL collapses to null -- treated as whitespace by the fix
        // for the embedded-NUL crash below -- which is a legitimate
        // "nothing to search on" outcome, not something to execute.
        if (expression === null) continue;

        expect(
          () => matchCount(db, expression as string),
          `MATCH threw for ${JSON.stringify(input)} -> ${JSON.stringify(expression)}`,
        ).not.toThrow();
      }
    } finally {
      db.close();
    }
  });

  it("caps an oversized query to MAX_TOKENS terms", () => {
    const db = ftsTable();
    try {
      seed(db, "filler row unrelated to any generated token");

      const manyTokens = Array.from({ length: MAX_TOKENS * 2 }, (_, i) => `tok${i}`).join(" ");
      const expression = unwrap(matchExpression(manyTokens));

      // Cleanest assertable form of the cap: quoted-phrase count. Splitting
      // on a plain space is exact here because none of the synthetic
      // tok<N> tokens contains a space or a quote to be doubled.
      expect(expression.split(" ")).toHaveLength(MAX_TOKENS);

      // The cap must not silently strip the trailing prefix star along with
      // the discarded tokens -- a future slice/map reorder could keep the
      // count right while losing the star on the (new) last kept token.
      expect(expression.endsWith(`"tok${MAX_TOKENS - 1}"*`)).toBe(true);

      expect(() => matchCount(db, expression)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("ANDs terms and prefix-matches only the final token", () => {
    const db = ftsTable();
    try {
      // "auth" and "migration" are NOT adjacent here — the row only matches
      // under implicit AND across two separate phrases, not under a single
      // adjacency-requiring phrase. This is the case a whole-query-quoting
      // regression fails.
      seed(db, "auth documentation for the migration guide");
      seed(db, "totally unrelated content about gardening");

      const expression = unwrap(matchExpression("auth mig"));
      expect(expression).toBe('"auth" "mig"*');
      expect(matchCount(db, expression)).toBe(1);

      // The trailing star only applies to the FINAL token: a query with an
      // extra term that is not itself a prefix of anything in the row must
      // not match, proving the star did not leak onto the first token.
      const noMatch = unwrap(matchExpression("auth zzzznotaword"));
      expect(matchCount(db, noMatch)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("treats operator syntax as literal text", () => {
    const db = ftsTable();
    try {
      seed(db, "please read the OR clause before you continue");
      seed(db, "an unrelated sentence sharing only the word clause");
      seed(db, "call NEAR(a, b) directly in the driver code");
      seed(db, "some other function call entirely");

      // If OR were interpreted as FTS5's boolean operator, "OR clause" would
      // either be a malformed query or match anything containing "clause" —
      // literal semantics requires BOTH "OR" and a "clause"-prefixed word.
      const orExpression = unwrap(matchExpression("OR clause"));
      expect(matchCount(db, orExpression)).toBe(1);

      // A literal NEAR(...) call must match as text, not be parsed as FTS5's
      // NEAR proximity operator (which has entirely different syntax).
      const nearExpression = unwrap(matchExpression("NEAR(a, b)"));
      expect(matchCount(db, nearExpression)).toBe(1);

      // A bare hyphenated token must not crash and must not silently drop
      // half the query the way an unescaped bareword MATCH would.
      seed(db, "the beads-migration finished cleanly");
      const hyphenExpression = unwrap(matchExpression("beads-migration"));
      expect(() => matchCount(db, hyphenExpression)).not.toThrow();
      expect(matchCount(db, hyphenExpression)).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it("returns null only for empty and whitespace-only input", () => {
    expect(matchExpression("")).toBeNull();
    expect(matchExpression(" ")).toBeNull();
    expect(matchExpression("   ")).toBeNull();
    expect(matchExpression("\t")).toBeNull();
    expect(matchExpression("\n \t \n")).toBeNull();

    // Punctuation is not whitespace: a query of only punctuation still has a
    // token to build a (zero-hit) expression from.
    expect(matchExpression("!!!")).not.toBeNull();
    expect(matchExpression("a")).not.toBeNull();
  });

  it("builds valid zero-hit expressions for punctuation-only and emoji-only queries", () => {
    const db = ftsTable();
    try {
      seed(db, "some perfectly ordinary searchable sentence");

      for (const input of ["!!!", "????", "...", "😀😀😀", "🔥🚀✨"]) {
        const expression = unwrap(matchExpression(input));
        expect(() => matchCount(db, expression)).not.toThrow();
        expect(matchCount(db, expression)).toBe(0);
      }
    } finally {
      db.close();
    }
  });
});

describe("idFragment", () => {
  it("classifies plausible id fragments and rejects the rest", () => {
    // Accepted: kt- prefix stripped, bare fragment, and the full form.
    expect(idFragment("kt-9n")).toBe("9n");
    expect(idFragment("9nf")).toBe("9nf");
    expect(idFragment(`${ID_PREFIX}9nfn9v`)).toBe("9nfn9v");

    // kt- alone: stripping the prefix leaves nothing to classify.
    expect(idFragment("kt-")).toBeNull();
    expect(idFragment(ID_PREFIX)).toBeNull();

    // 1-char: below MIN_PREFIX_LENGTH, with or without the prefix.
    expect(idFragment("9")).toBeNull();
    expect(idFragment("kt-9")).toBeNull();
    expect(MIN_PREFIX_LENGTH).toBeGreaterThan(1);

    // The split minimum (senior review MEDIUM): an explicit kt- prefix is a
    // declared intent and keeps MIN_PREFIX_LENGTH; bare input needs one
    // character more, or an ordinary two-letter word ("db", "to", ...)
    // classifies as a plausible id fragment and hijacks rank position 1 with
    // a snippet-less row on an unrelated text search.
    expect(idFragment("kt-9x")).toBe("9x");
    expect(idFragment("db")).toBeNull();
    expect(idFragment("9xs")).toBe("9xs");

    // Uppercase: generateId never produces it, so it is not a plausible
    // fragment — and the kt- prefix match itself is case-sensitive.
    expect(idFragment("9F")).toBeNull();
    expect(idFragment("KT-9n")).toBeNull();

    // base36 boundary characters: digits and letters at both ends accepted.
    // Three-char bare fragments, since bare input needs MIN_PREFIX_LENGTH + 1.
    expect(idFragment("090")).toBe("090");
    expect(idFragment("aza")).toBe("aza");
    expect(idFragment("zzz")).toBe("zzz");

    // Non-base36 characters anywhere in the fragment reject the whole thing.
    expect(idFragment("9n-f")).toBeNull();
    expect(idFragment("9n f")).toBeNull();
    expect(idFragment("9n!")).toBeNull();
    expect(idFragment("")).toBeNull();
  });
});
