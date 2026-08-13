import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ID_PREFIX, MIN_PREFIX_LENGTH } from "../../src/core/id-format.js";
import { idFragment, matchExpression } from "../../src/core/search-query.js";

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
];

describe("matchExpression", () => {
  it("builds expressions that execute for every corpus entry", () => {
    const db = ftsTable();
    try {
      for (const input of HOSTILE_CORPUS) {
        const expression = matchExpression(input);
        expect(expression, `expected an expression for ${JSON.stringify(input)}`).not.toBeNull();
        expect(
          () => matchCount(db, unwrap(expression)),
          `MATCH threw for ${JSON.stringify(input)} -> ${JSON.stringify(expression)}`,
        ).not.toThrow();
      }
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

    // Uppercase: generateId never produces it, so it is not a plausible
    // fragment — and the kt- prefix match itself is case-sensitive.
    expect(idFragment("9F")).toBeNull();
    expect(idFragment("KT-9n")).toBeNull();

    // base36 boundary characters: digits and letters at both ends accepted.
    expect(idFragment("09")).toBe("09");
    expect(idFragment("az")).toBe("az");
    expect(idFragment("zz")).toBe("zz");

    // Non-base36 characters anywhere in the fragment reject the whole thing.
    expect(idFragment("9n-f")).toBeNull();
    expect(idFragment("9n f")).toBeNull();
    expect(idFragment("9n!")).toBeNull();
    expect(idFragment("")).toBeNull();
  });
});
