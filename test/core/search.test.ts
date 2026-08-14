import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchOptions } from "../../src/core/search.js";
import { readSearch } from "../../src/core/search.js";
import { matchExpression } from "../../src/core/search-query.js";
import type { OpenStore } from "../../src/core/store.js";
import { seedEpic, seedEvent, seedNote, seedTask, seedTime } from "../helpers/seed.js";
import type { StoreFixture } from "../helpers/store.js";
import { createStoreFixture } from "../helpers/store.js";

let fixture: StoreFixture;
beforeEach(() => {
  fixture = createStoreFixture();
});
afterEach(() => fixture.cleanup());

function idsOf(hits: ReturnType<typeof readSearch>["hits"]): string[] {
  return hits.map((h) => h.id);
}

describe("the text path — rollup and tiers", () => {
  it("finds a task by a description-only word and by a note-body-only word, one row each", () => {
    const byDescription = seedTask(fixture.store, {
      title: "unrelated title",
      description: "a lone zephyrus mention",
    });
    const byNote = seedTask(fixture.store, { title: "another unrelated title" });
    seedNote(fixture.store, { taskId: byNote, body: "a quokka shows up here" });

    const descriptionHit = readSearch(fixture.store, { query: "zephyrus" });
    expect(idsOf(descriptionHit.hits)).toEqual([byDescription]);
    expect(descriptionHit.hits[0]?.matchedIn).toBe("task");
    // Pins the auto-column selection (colIndex -1): the match is only in
    // description, and the snippet must come from that column, not title.
    expect(descriptionHit.hits[0]?.snippet).toBe("a lone [zephyrus] mention");

    const noteHit = readSearch(fixture.store, { query: "quokka" });
    expect(idsOf(noteHit.hits)).toEqual([byNote]);
    expect(noteHit.hits[0]?.matchedIn).toBe("note");
  });

  it("rolls three matching notes on one task into a single row with the best score", () => {
    const task = seedTask(fixture.store, {
      title: "roll-up target",
      description: "nothing relevant in the description",
    });
    // Deliberately uneven match strength: one short, dense note and two long,
    // noisy ones — bm25 rewards term frequency relative to document length,
    // so these should not tie (unlike the tied-tier test below, which wants
    // them to).
    seedNote(fixture.store, { taskId: task, body: "marmalade" });
    seedNote(fixture.store, {
      taskId: task,
      body: "a very long note about marmalade buried among many other unrelated words entirely",
    });
    seedNote(fixture.store, {
      taskId: task,
      body: "another long note mentioning marmalade somewhere amid a lot of extra padding text",
    });

    const result = readSearch(fixture.store, { query: "marmalade" });
    const hits = result.hits.filter((h) => h.id === task);
    expect(hits).toHaveLength(1);

    // Independently recompute every note's own bm25 for this query — not the
    // rollup logic under test, only FTS5's built-in bm25() — and assert the
    // rollup actually picked the best (most negative) one, not merely "a"
    // note.
    const expr = matchExpression("marmalade");
    if (expr === null) throw new Error("expected a non-null match expression");
    const noteScores = fixture.store.db
      .prepare(
        `SELECT bm25(notes_fts) AS score
           FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
          WHERE notes_fts MATCH ? AND n.task_id = ?`,
      )
      .all(expr, task) as Array<{ score: number }>;
    expect(noteScores).toHaveLength(3);
    const bestScore = Math.min(...noteScores.map((row) => row.score));

    expect(hits[0]?.score).toBeCloseTo(bestScore, 10);
  });

  it("marks note matches and snippets the winning field", () => {
    const task = seedTask(fixture.store, { title: "no shared words at all" });
    seedNote(fixture.store, { taskId: task, body: "the pangolin curls up defensively" });

    const result = readSearch(fixture.store, { query: "pangolin" });

    expect(idsOf(result.hits)).toEqual([task]);
    expect(result.hits[0]?.matchedIn).toBe("note");
    expect(result.hits[0]?.snippet).not.toBeNull();
    expect(result.hits[0]?.snippet?.length).toBeGreaterThan(0);
  });

  it("orders same-tier hits best-bm25-first", () => {
    // Same tier (both tasks_fts/tier 0) so the tiebreak under test is
    // score ASC, not tier ASC: a short, dense title scores better (more
    // negative) than a long, padded one with the same single occurrence.
    const dense = seedTask(fixture.store, { title: "kraken", description: "" });
    const padded = seedTask(fixture.store, {
      title:
        "a very long padded title that mentions kraken only once among a lot of extra words to dilute the relevance score significantly",
      description: "",
    });

    const result = readSearch(fixture.store, { query: "kraken" });

    expect(idsOf(result.hits)).toEqual([dense, padded]);
    const denseHit = result.hits.find((h) => h.id === dense);
    const paddedHit = result.hits.find((h) => h.id === padded);
    // bm25 is more-negative-is-better; ASC ordering means the better
    // (smaller/more negative) score sorts first.
    expect(denseHit?.score).toBeLessThan(paddedHit?.score as number);
  });

  it("finds a task whose terms are split across title and description", () => {
    // The recall case that kills a column-scoped MATCH design: "auth" lives
    // only in the title, "migration" only in the description, and the query
    // must AND across both without either column satisfying it alone.
    const task = seedTask(fixture.store, {
      title: "auth work",
      description: "write up the migration guide",
    });
    const decoy = seedTask(fixture.store, { title: "totally unrelated gardening notes" });

    const result = readSearch(fixture.store, { query: "auth mig" });

    expect(idsOf(result.hits)).toContain(task);
    expect(idsOf(result.hits)).not.toContain(decoy);
  });

  it("rolls tied-tier note hits to the best-scoring one deterministically", () => {
    const task = seedTask(fixture.store, { title: "tie-break target" });
    // Same token count, same term frequency — structurally identical enough
    // that bm25 should tie (epic risk notes: "identical bm25 scores across
    // two similar-length notes are routine, not hypothetical").
    seedNote(fixture.store, { taskId: task, body: "gadget one two three" });
    seedNote(fixture.store, { taskId: task, body: "gadget four five six" });

    const expr = matchExpression("gadget");
    if (expr === null) throw new Error("expected a non-null match expression");
    const noteRows = fixture.store.db
      .prepare(
        `SELECT n.rowid AS rowid, bm25(notes_fts) AS score
           FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
          WHERE notes_fts MATCH ? AND n.task_id = ?
          ORDER BY n.rowid`,
      )
      .all(expr, task) as Array<{ rowid: number; score: number }>;
    expect(noteRows).toHaveLength(2);
    // Prove the tie exists before relying on it, rather than assuming it.
    expect(noteRows[0]?.score).toBeCloseTo(noteRows[1]?.score as number, 10);
    const [earlier] = noteRows;
    if (earlier === undefined) throw new Error("expected two note rows");

    const result = readSearch(fixture.store, { query: "gadget" });
    const hits = result.hits.filter((h) => h.id === task);
    expect(hits).toHaveLength(1);
    // The earlier-inserted (smaller rowid) note wins the tie. This *alone*
    // does not distinguish "the pinned `src_rowid` tiebreak decided it" from
    // "SQLite's scan just happened to visit rows in insertion order and
    // nothing broke the tie at all" — with only two rows and no `ORDER BY`
    // forcing a different visitation order, both explanations predict the
    // same observed winner, and a behavioral assertion here cannot tell them
    // apart (confirmed directly: dropping the `src_rowid` term from the
    // partition `ORDER BY` still passed this assertion, unchanged, across
    // repeated runs). The structural assertion below is what actually pins
    // the tiebreak; this one only pins the (correct, but weaker) outcome.
    expect(hits[0]?.snippet).toContain("one");
    expect(hits[0]?.snippet).not.toContain("four");
  });

  it("pins the rollup's ORDER BY clauses structurally, not just their observed outcome", () => {
    // Per the note above: no fixture can behaviorally distinguish "ranked by
    // src_rowid" from "coincidentally matches scan order" under this schema
    // — reversing the tiebreak direction (src_rowid DESC) does falsify the
    // behavioral test above, but simply *dropping* the term does not, so a
    // silent removal of the tiebreak term is not guaranteed to be caught by
    // any observable-output test. This test instead pins the exact SQL text
    // the rollup issues, following the same prepare-spy idiom the
    // FTS-elimination test above uses to inspect the real, generated
    // statement rather than a hand-maintained copy of it.
    seedTask(fixture.store, { title: "structural pin seed" });

    const spy = vi.spyOn(Database.prototype, "prepare");
    let textPathCall: unknown[] | undefined;
    try {
      readSearch(fixture.store, { query: "seed" });
      textPathCall = spy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("WITH matches"),
      );
    } finally {
      spy.mockRestore();
    }

    expect(
      textPathCall,
      "expected the text-path rollup SELECT to have been prepared",
    ).toBeDefined();
    const sql = textPathCall?.[0] as string;

    expect(sql).toContain("ORDER BY tier, score, src_rowid) AS rn");
    expect(sql).toContain("ORDER BY r.id_match_any DESC, r.tier ASC, r.score ASC, r.src_rowid ASC");
  });

  it("ranks a task's own description hit above another task's note-only hit and reports task, not note", () => {
    const taskHit = seedTask(fixture.store, {
      title: "unrelated",
      description: "a narwhal surfaces here",
    });
    const noteOnlyTask = seedTask(fixture.store, { title: "also unrelated" });
    seedNote(fixture.store, { taskId: noteOnlyTask, body: "a narwhal mentioned in passing" });

    const result = readSearch(fixture.store, { query: "narwhal" });

    const ids = idsOf(result.hits);
    expect(ids.indexOf(taskHit)).toBeLessThan(ids.indexOf(noteOnlyTask));
    expect(result.hits.find((h) => h.id === taskHit)?.matchedIn).toBe("task");
    expect(result.hits.find((h) => h.id === noteOnlyTask)?.matchedIn).toBe("note");
  });

  it("carries lastActivity on text-path hits, null for an event-less task", () => {
    const touched = seedTask(fixture.store, { description: "an octopus with activity" });
    seedEvent(fixture.store, { entityId: touched, createdAt: seedTime(1000) });
    const untouched = seedTask(fixture.store, { description: "an octopus with no activity" });

    const result = readSearch(fixture.store, { query: "octopus" });

    expect(result.hits.find((h) => h.id === touched)?.lastActivity).not.toBeNull();
    expect(result.hits.find((h) => h.id === untouched)?.lastActivity).toBeNull();
  });
});

describe("the id-fragment branch", () => {
  it("ranks an id-fragment match above text matches and dedupes it", () => {
    // Ids are exactly 6 base36 characters after "kt-" (schema CHECK
    // constraint) — "9zzzzz" is both the whole suffix and a valid fragment.
    const idMatch = seedTask(fixture.store, { id: "kt-9zzzzz", title: "unrelated title" });
    const textMatch = seedTask(fixture.store, { title: "ticket 9zzzzzed renamed" });

    const result = readSearch(fixture.store, { query: "9zzzzz" });

    const ids = idsOf(result.hits);
    expect(ids.filter((id) => id === idMatch)).toHaveLength(1);
    expect(ids.indexOf(idMatch)).toBeLessThan(ids.indexOf(textMatch));
    expect(result.hits.find((h) => h.id === idMatch)?.idMatch).toBe(true);
    expect(result.hits.find((h) => h.id === textMatch)?.idMatch).toBe(false);
  });

  it("keeps idMatch true for a task matching both by id and by text", () => {
    // The any-row-property regression case: this task matches BOTH the id
    // branch (its own id starts with the fragment) and the text branch (the
    // same fragment also appears literally in its title) — a naive "read
    // id_match off the winning row" would read false, because the text
    // branch's row (with a real snippet) wins the per-entity tiebreak.
    const dual = seedTask(fixture.store, {
      id: "kt-8pqrst",
      title: "ticket 8pqrst renamed",
    });

    const result = readSearch(fixture.store, { query: "8pqrst" });

    const hit = result.hits.find((h) => h.id === dual);
    expect(hit).toBeDefined();
    expect(result.hits.filter((h) => h.id === dual)).toHaveLength(1);
    expect(hit?.idMatch).toBe(true);
    // The winning row is the text branch's, proven by a real snippet — an
    // id-only row carries none.
    expect(hit?.snippet).not.toBeNull();
    expect(hit?.matchedIn).toBe("task");
  });

  it("ranks a dual id-and-text match above a text-only competitor even when the dual's own text score is worse", () => {
    // The outer-ORDER-BY regression case, distinct from the any-row-property
    // test above: it is not enough for `idMatch` to *report* true on the
    // winning row — the id_match_any DESC term the outer ORDER BY reads has
    // to actually be what decides the ranking. Rig it so the naive
    // alternative (ordering by the winning row's own, per-row `id_match`
    // instead of the any-row aggregate) would get this wrong: `dual`'s own
    // text hit is deliberately the *weaker* bm25 score of the two, so if
    // ranking fell through to tier/score because both rows' raw `id_match`
    // tied at 0, `textOnly` (the better bm25) would sort first — the wrong
    // order.
    const dual = seedTask(fixture.store, {
      id: "kt-7mnopq",
      title:
        "an extremely long padded title with the word 7mnopq appearing only once among many many words to dilute relevance score significantly for this test case",
    });
    const textOnly = seedTask(fixture.store, { title: "7mnopqzz" });

    const result = readSearch(fixture.store, { query: "7mnopq" });

    const dualHit = result.hits.find((h) => h.id === dual);
    const textOnlyHit = result.hits.find((h) => h.id === textOnly);
    expect(dualHit).toBeDefined();
    expect(textOnlyHit).toBeDefined();
    // Confirm the rigged precondition rather than assuming it: dual's own
    // text-branch score really is worse (less negative) than the
    // competitor's, so the assertion below is not accidentally vacuous.
    expect(dualHit?.score).toBeGreaterThan(textOnlyHit?.score as number);

    expect(idsOf(result.hits)).toEqual([dual, textOnly]);
    expect(dualHit?.idMatch).toBe(true);
    expect(textOnlyHit?.idMatch).toBe(false);
  });
});

describe("the filter-only path", () => {
  it("keeps a task with no events on the filter path with null last activity, sorted last", () => {
    const touched = seedTask(fixture.store, { lane: "Planned" });
    seedEvent(fixture.store, { entityId: touched });
    const untouched = seedTask(fixture.store, { lane: "Planned" });

    const result = readSearch(fixture.store, { lane: "Planned" });

    const ids = idsOf(result.hits);
    expect(ids).toContain(untouched);
    expect(result.hits.find((h) => h.id === untouched)?.lastActivity).toBeNull();
    expect(ids.indexOf(touched)).toBeLessThan(ids.indexOf(untouched));
  });

  it("orders the filter-only path by last activity via the shared fragment", () => {
    const older = seedTask(fixture.store, { title: "older" });
    seedEvent(fixture.store, { entityId: older, createdAt: seedTime(3000) });
    const newer = seedTask(fixture.store, { title: "newer" });
    seedEvent(fixture.store, { entityId: newer, createdAt: seedTime(7000) });

    const result = readSearch(fixture.store, {});

    expect(idsOf(result.hits)).toEqual([newer, older]);
  });

  it("never touches the FTS tables on the filter-only path", () => {
    seedTask(fixture.store, { lane: "Planned" });

    const spy = vi.spyOn(Database.prototype, "prepare");
    let filterCall: unknown[] | undefined;
    try {
      readSearch(fixture.store, { lane: "Planned" });
      // Read the calls out *before* restoring: `mockRestore` also resets the
      // mock's call history (the same as `mockReset`), so reading afterward
      // silently sees zero calls no matter what actually happened.
      filterCall = spy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("FROM tasks t") &&
          !call[0].includes("WITH matches"),
      );
    } finally {
      spy.mockRestore();
    }

    expect(filterCall, "expected the filter-only SELECT to have been prepared").toBeDefined();
    const sql = filterCall?.[0] as string;
    expect(sql).not.toMatch(/tasks_fts|notes_fts/);

    // Belt-and-suspenders: prove the query *plan* never scans the FTS
    // tables either, following the events-index EXPLAIN QUERY PLAN
    // precedent — not just that the SQL text happens not to mention them.
    const paramCount = (sql.match(/\?/g) ?? []).length;
    const plan = fixture.store.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(Array.from({ length: paramCount }, () => "x") as unknown[])) as Array<{
      detail: string;
    }>;
    const detail = plan.map((row) => row.detail).join(" ");
    expect(detail).not.toMatch(/tasks_fts|notes_fts/);
  });
});

describe("filters compose onto both paths", () => {
  function expectNarrows(
    store: OpenStore,
    filterOptions: Omit<SearchOptions, "query">,
    included: string,
    excluded: string,
    textQuery: string,
  ): void {
    for (const query of [undefined, textQuery]) {
      const options: SearchOptions =
        query === undefined ? filterOptions : { ...filterOptions, query };
      const result = readSearch(store, options);
      const ids = idsOf(result.hits);
      const label = `${JSON.stringify(options)}`;
      expect(ids, label).toContain(included);
      expect(ids, label).not.toContain(excluded);
    }
  }

  it("applies each filter on both the text and filter-only paths", () => {
    const epic = seedEpic(fixture.store, { title: "epic one" });
    const otherEpic = seedEpic(fixture.store, { title: "epic two" });

    const match = seedTask(fixture.store, {
      title: "griffin task",
      description: "a griffin roams here",
      lane: "In Progress",
      kind: "fix",
      parentId: epic,
      tags: ["urgent"],
    });
    seedEvent(fixture.store, { entityId: match, createdAt: seedTime(1000) });

    const other = seedTask(fixture.store, {
      title: "griffin decoy",
      description: "a griffin roams elsewhere too",
      lane: "Planned",
      kind: "feat",
      parentId: otherEpic,
      tags: ["low"],
    });
    seedEvent(fixture.store, { entityId: other, createdAt: seedTime(9000) });

    const cutoff = seedTime(5000);

    expectNarrows(fixture.store, { lane: "In Progress" }, match, other, "griffin");
    expectNarrows(fixture.store, { kind: "fix" }, match, other, "griffin");
    expectNarrows(fixture.store, { epic }, match, other, "griffin");
    expectNarrows(fixture.store, { tag: "urgent" }, match, other, "griffin");
    expectNarrows(fixture.store, { updatedBefore: cutoff }, match, other, "griffin");
    expectNarrows(fixture.store, { updatedAfter: cutoff }, other, match, "griffin");

    // level: a third entity, an epic, also matches the text query but must
    // be excluded by `level: "task"` and included by `level: "epic"`.
    const epicHit = seedEpic(fixture.store, {
      title: "griffin epic",
      description: "a griffin epic entry",
    });
    expectNarrows(fixture.store, { level: "epic" }, epicHit, match, "griffin");
    expectNarrows(fixture.store, { level: "task" }, match, epicHit, "griffin");
  });

  it("puts an activity exactly on the cutoff outside both updatedBefore and updatedAfter windows", () => {
    // activityCutoff's pinned boundary (activity.ts, mirroring clock.ts's
    // parseWhen): strictly before/after, never inclusive. An activity
    // landing exactly on the cutoff instant belongs to neither window.
    const cutoff = seedTime(5000);
    const boundary = seedTask(fixture.store, { title: "boundary task" });
    seedEvent(fixture.store, { entityId: boundary, createdAt: cutoff });

    const before = readSearch(fixture.store, { updatedBefore: cutoff });
    const after = readSearch(fixture.store, { updatedAfter: cutoff });

    expect(idsOf(before.hits)).not.toContain(boundary);
    expect(idsOf(after.hits)).not.toContain(boundary);
  });
});

describe("hostile input and bounds", () => {
  // Mirrors T3's HOSTILE_CORPUS (search-query.test.ts) — duplicated rather
  // than imported (that file's fixture is private to its own suite), since
  // this suite's job is proving the SAME inputs also survive the real,
  // migrated multi-table rollup query end to end, not just matchExpression's
  // own construction.
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
    "auth mig",
    " ",
    'auth "',
    "\ud800",
    "",
    "   ",
  ];

  it("survives the hostile corpus end to end", () => {
    seedTask(fixture.store, { title: "a plain seeded task", description: "ordinary text" });

    for (const query of HOSTILE_CORPUS) {
      expect(
        () => readSearch(fixture.store, { query }),
        `query ${JSON.stringify(query)}`,
      ).not.toThrow();
    }
  });

  it("reports truncation and echoes the query", () => {
    seedTask(fixture.store, { title: "beluga one", description: "beluga sighting" });
    seedTask(fixture.store, { title: "beluga two", description: "beluga sighting" });
    seedTask(fixture.store, { title: "beluga three", description: "beluga sighting" });

    const truncatedResult = readSearch(fixture.store, { query: "beluga", limit: 2 });
    expect(truncatedResult.hits).toHaveLength(2);
    expect(truncatedResult.truncated).toBe(true);
    expect(truncatedResult.query).toBe("beluga");

    const fullResult = readSearch(fixture.store, { query: "beluga", limit: 10 });
    expect(fullResult.truncated).toBe(false);
    expect(fullResult.query).toBe("beluga");

    const filterOnlyResult = readSearch(fixture.store, {});
    expect(filterOnlyResult.query).toBe("");
  });
});
