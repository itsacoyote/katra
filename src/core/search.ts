/**
 * `search` — full-text over task titles, descriptions and note bodies, folded
 * together with structured filters and partial-id matching (F6 T5).
 *
 * Composes T1's `tasks_fts`/`notes_fts` index (migration 0004), T3's
 * `matchExpression`/`idFragment` (`search-query.ts`), and T4's
 * {@link activityJoin} (`activity.ts`) — this module holds none of that logic
 * itself, only the store-touching read that wires them together.
 *
 * **Two structurally separate SQL paths, never one.** A conditional MATCH —
 * `(? IS NULL OR fts MATCH ?)` — throws "unable to use function MATCH in the
 * requested context" the moment text is present (probe-verified, epic
 * katra-9aw.54's risk notes). {@link readSearch} therefore branches in
 * TypeScript, not in SQL: {@link textPathRows} runs only when
 * {@link matchExpression} produced a usable expression; {@link filterPathRows}
 * runs otherwise, and its query never references `tasks_fts` or `notes_fts` at
 * all — not "references them but the planner elides it", genuinely does not
 * mention them, so there is nothing for a future refactor to accidentally
 * reference back in (test: "never touches the FTS tables on the filter-only
 * path", EXPLAIN QUERY PLAN — following the events-index test precedent).
 *
 * **The text path is two tiers, both UNSCOPED.** `tasks_fts` (tier 0) is
 * matched with no column restriction — a query with terms split across title
 * and description still matches, which a `title:`/`description:`-scoped MATCH
 * would lose (plan-review iteration-3 HIGH-1: column-scoped branches
 * probe-verifiably lose exactly this cross-column case, the common shape on
 * this corpus's short titles, and the spec never asks for a title/description
 * distinction). `snippet(tasks_fts, -1, ...)` auto-picks whichever column
 * actually matched (probe-verified). `notes_fts` (tier 1) joins back to its
 * owning task through `notes.task_id` — spec req 3's rollup: three matching
 * notes on one task still produce one row for that task, not three.
 *
 * **The id-fragment branch, when the query classifies** ({@link idFragment}
 * non-null), unions in as a third arm: a range-bound query against `tasks.id`
 * (`tasks/ids.ts`'s measured range-scan-over-LIKE technique), never LIKE,
 * never FTS — an id like `kt-9nfn9v` either crashes bareword MATCH on the
 * hyphen or, quoted, tokenizes into id-format noise. It carries
 * {@link ID_BRANCH_TIER}, deliberately **worse** than both text tiers — see
 * the property-rule docs below for why that, not "better", is what makes a
 * dual id-and-text match behave correctly.
 *
 * **The rollup — one row per entity, pinned SQL shape (plan-review
 * iterations 3–4, both hazards probe-verified).** The three branches (or two,
 * with no id-fragment) union into `matches`, then `ranked` computes, as
 * window functions over `PARTITION BY entity_id`:
 *
 * - `MAX(id_match) OVER (...)` → `id_match_any` — true the instant *any*
 *   branch matched this entity by id.
 * - `ROW_NUMBER() OVER (... ORDER BY tier, score, src_rowid)` → `rn` — which
 *   single row represents this entity's best hit, filtered to `rn = 1`.
 *
 * **The property rule this pins (state it, don't rediscover it under a
 * failing test): `idMatch` is an any-row property; `snippet`, `score` and the
 * internal `tier` are winning-row properties.** Concretely: a task whose id
 * *and* text both match produces two rows in `matches` — the id branch's
 * (tier {@link ID_BRANCH_TIER}, no snippet) and the text branch's (tier 0 or
 * 1, a real snippet and bm25 score). Because the id branch's tier is the
 * *worse* one, the text row wins `rn = 1` — the winning row that actually
 * carries a snippet is the one selected for display. Reading `id_match` off
 * that same winning row would then read `0`, silently losing the true fact
 * that this entity also matched by id (spec req 4 / AC 3's exact regression:
 * "`rn = 1` alone destroys it"). `id_match_any` is computed as a window
 * function over the *whole partition*, before the `rn = 1` filter ever
 * narrows it, so it survives regardless of which row wins.
 *
 * **Two designs this rejected, both worth naming so they don't resurface:**
 * (a) `GROUP BY entity_id` with bare `MIN(...)`-style columns picks an
 * *arbitrary* row for every column not itself wrapped in the aggregate — the
 * snippet and matched-in marker would not reliably belong to the row the
 * score came from. (b) Flattening a single FTS arm's MATCH+bm25 into this
 * query's own top level (rather than each branch computing its own `bm25()`
 * inside a `SELECT` that also holds that branch's own `MATCH`) pushes `bm25()`
 * into a context SQLite does not accept it in — it must be evaluated in the
 * same simple `SELECT` as the `MATCH` constraint it scores, which is exactly
 * why each branch below is a self-contained `SELECT ... WHERE <fts> MATCH ?`
 * and the window functions run one layer above that, over already-materialized
 * REAL columns.
 *
 * **Outer ranking**, on the winning rows only:
 * `ORDER BY id_match_any DESC, tier ASC, score ASC, src_rowid ASC`. Never the
 * winning row's own `id_match` — that is the exact regression the property
 * rule above exists to prevent. `score ASC` is correct, not backwards: bm25
 * is more-negative-is-better, so ascending is best-first (epic risk notes).
 * bm25 is compared only **within** one tier — cross-table magnitudes between
 * `tasks_fts` and `notes_fts` are not commensurable (two different indexes
 * over different content), which `tier ASC` ahead of `score ASC` already
 * guarantees: two rows never reach the `score` tiebreak unless they share a
 * tier. `src_rowid` — the source table's rowid the winning row came from —
 * is the deterministic tail both here and in the partition ordering above:
 * identical bm25 scores between two similar-length notes are routine, not
 * hypothetical (probe showed byte-identical scores on this corpus), so
 * without it two ties would resolve to whatever order SQLite's sort happened
 * to preserve.
 *
 * **Both paths compose `activityJoin({outer: true})`** (`activity.ts`, T4) —
 * never the inner form `readRecent`/`readStale` use. A text-matching task
 * with zero events must still appear, with `lastActivity: null` (spec req 10
 * puts it on every hit); a filter narrows the candidate set, it never deletes
 * a row the filters didn't touch (the same rule `activityJoin`'s own docs
 * state for the filter-only path, iteration-2 MEDIUM-2 / plan-review HIGH-3).
 *
 * **The six filters** (`lane`, `kind`, `level`, `epic` via
 * {@link requireEpicId}, `tag` via `EXISTS`, `updatedBefore`/`updatedAfter`
 * against `activityJoin`'s `a.last_activity`) compose onto **either** path,
 * applied once at the outer level after the rollup — a task's lane does not
 * vary by which branch found it, so filtering post-rollup is both correct and
 * the only place that needs to know about all six. `updatedBefore` reuses
 * `parseWhen`'s pinned boundary (`clock.ts`): strictly before, `<`, never
 * `<=`. `updatedAfter` is that same strict rule mirrored — strictly after,
 * `>`, never `>=` — an activity landing exactly on the cutoff instant is
 * outside *both* windows, not inside either.
 *
 * **Positional binding follows SQL text order** (`board.ts`'s precedent): the
 * `WITH` clause's own `?`s (id-branch range bounds, then each MATCH
 * expression) come first because they sit first in the rendered SQL, then the
 * outer `WHERE`'s filter params, then `LIMIT ?` last. Nothing in this query's
 * `SELECT` list itself binds a parameter, unlike `board.ts`'s
 * `CLAIMED_ELSEWHERE` alias — so the only ordering discipline needed is
 * "build `params` in the order each branch/clause is appended to the SQL
 * text", which {@link textPathRows} and {@link filterPathRows} both do.
 *
 * **The usage refusal ("no query text and no filters") is not this module's
 * job.** It is a CLI-level gate (T6): a punctuation-only or emoji-only query
 * is a legitimate zero-hit search (spec AC 5), and {@link matchExpression}
 * already returns a valid, safe expression for exactly that case. This module
 * only has to decide *which path* to run, never whether to refuse.
 *
 * `readTx` wraps the whole read (board/activity precedent): one snapshot for
 * the epic resolution ({@link requireEpicId}, when `--epic` is given) and the
 * rollup query together.
 */

import {
  ACTIVITY_COLUMNS,
  type ActivityRow,
  activityCutoff,
  activityJoin,
  DEFAULT_ACTIVITY_LIMIT,
  rowToHit,
} from "./activity.js";
import type { SearchHit, SearchResult } from "./contract.js";
import { readTx } from "./db/connection.js";
import type { Kind, Lane, Level } from "./enums.js";
import { KatraException } from "./errors.js";
import { ID_PREFIX } from "./id-format.js";
import { narrowNullableText } from "./narrow.js";
import { idFragment, matchExpression } from "./search-query.js";
import type { OpenStore } from "./store.js";
import { requireEpicId } from "./tasks/repo.js";

export interface SearchOptions {
  /** Raw, untrusted query text. Absent or blank routes to the filter-only path. */
  readonly query?: string;
  readonly lane?: Lane;
  readonly kind?: Kind;
  readonly level?: Level;
  /** A full or partial epic id, resolved via {@link requireEpicId}. */
  readonly epic?: string;
  readonly tag?: string;
  /**
   * Already-resolved cutoffs (T2's `parseWhen`, at the CLI boundary) — not
   * parsed here, the same trust `activityCutoff` extends its caller.
   */
  readonly updatedBefore?: string;
  readonly updatedAfter?: string;
  /** Best-hits-first this many. Defaults to {@link DEFAULT_ACTIVITY_LIMIT} — the one bound this read family shares. */
  readonly limit?: number;
}

/**
 * The id branch's tier — deliberately worse (numerically greater) than both
 * text tiers (0, 1). See this module's docstring for why: it is what lets a
 * real text hit's snippet win the per-entity row when a task matches both
 * ways, while `id_match_any` still reports the id match truthfully.
 */
const ID_BRANCH_TIER = 2;

/** Marks {@link snippetSql}'s excerpt. Display-best-effort, per this module's docstring — not structural. */
const SNIPPET_MARK_START = "[";
const SNIPPET_MARK_END = "]";
const SNIPPET_ELLIPSIS = "…";

/** How many tokens of context {@link snippetSql} keeps around a match. */
const SNIPPET_MAX_TOKENS = 8;

/**
 * Builds the `snippet()` call one text branch uses.
 *
 * `-1` for the column index: FTS5 auto-selects whichever column actually
 * matched (probe-verified) — the mechanism that makes {@link TASK_BRANCH_SQL}
 * safe to leave column-unscoped in its own `MATCH` while still snippeting the
 * one field that hit.
 */
function snippetSql(table: string): string {
  return `snippet(${table}, -1, '${SNIPPET_MARK_START}', '${SNIPPET_MARK_END}', '${SNIPPET_ELLIPSIS}', ${SNIPPET_MAX_TOKENS})`;
}

/** Every branch below shares this column shape, in this order — the `UNION ALL`'s implicit contract. */
const ID_BRANCH_SQL = `SELECT t.id AS entity_id, ${ID_BRANCH_TIER} AS tier, NULL AS score, NULL AS snippet,
         'task' AS matched_in, 1 AS id_match, t.rowid AS src_rowid
    FROM tasks t
   WHERE t.id >= ? AND t.id < ?`;

const TASK_BRANCH_SQL = `SELECT t.id AS entity_id, 0 AS tier, bm25(tasks_fts) AS score,
         ${snippetSql("tasks_fts")} AS snippet, 'task' AS matched_in, 0 AS id_match, t.rowid AS src_rowid
    FROM tasks_fts
    JOIN tasks t ON t.rowid = tasks_fts.rowid
   WHERE tasks_fts MATCH ?`;

const NOTE_BRANCH_SQL = `SELECT n.task_id AS entity_id, 1 AS tier, bm25(notes_fts) AS score,
         ${snippetSql("notes_fts")} AS snippet, 'note' AS matched_in, 0 AS id_match, n.rowid AS src_rowid
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
   WHERE notes_fts MATCH ?`;

/**
 * A list of `AND`-joinable SQL conditions and the parameters they bind, in
 * text order.
 *
 * Deliberately not `activity.ts`'s `Conditions` shape (a single `sql: string`
 * fragment): {@link buildFilterConditions} composes zero or more independent
 * conditions that either path joins with `AND` and prefixes with its own
 * `WHERE`/`AND` keyword, so the list stays unjoined until each path knows
 * which prefix it needs.
 */
interface FilterConditions {
  readonly sql: readonly string[];
  readonly params: readonly unknown[];
}

/**
 * Builds the six filters (spec req 5) as a list of `AND`-joinable conditions
 * plus their params, in the order they are appended — the order `params` must
 * bind in, whichever path composes them.
 *
 * Applied once, at the outer level, on **both** paths: a task's lane, kind,
 * tags and last activity do not vary by which branch (if any) found it, so
 * filtering after the rollup is both correct and the only place that needs to
 * know about all six at once.
 */
function buildFilterConditions(store: OpenStore, options: SearchOptions): FilterConditions {
  const sql: string[] = [];
  const params: unknown[] = [];

  const eq = (column: string, value: unknown): void => {
    sql.push(`${column} = ?`);
    params.push(value);
  };

  if (options.lane !== undefined) eq("t.lane", options.lane);
  if (options.kind !== undefined) eq("t.kind", options.kind);
  if (options.level !== undefined) eq("t.level", options.level);
  if (options.epic !== undefined) eq("t.parent_id", requireEpicId(store, options.epic));
  if (options.tag !== undefined) {
    sql.push("EXISTS (SELECT 1 FROM tags g WHERE g.task_id = t.id AND g.tag = ?)");
    params.push(options.tag);
  }
  // activityCutoff's pinned boundary (activity.ts, mirroring clock.ts's
  // parseWhen): strictly before/after, `<`/`>`, never `<=`/`>=` — an
  // activity landing exactly on the cutoff is outside both windows, not
  // inside either. Reused rather than duplicated inline, so `--updated-after`
  // isn't a third hand-written spelling of the same boundary rule.
  if (options.updatedBefore !== undefined) {
    const cutoff = activityCutoff(options.updatedBefore, "before");
    sql.push(cutoff.sql);
    params.push(...cutoff.params);
  }
  if (options.updatedAfter !== undefined) {
    const cutoff = activityCutoff(options.updatedAfter, "after");
    sql.push(cutoff.sql);
    params.push(...cutoff.params);
  }

  return { sql, params };
}

/**
 * The raw shape both paths' final query returns — `activity.ts`'s
 * {@link ActivityRow} (the seven columns {@link ACTIVITY_COLUMNS} selects)
 * plus this module's own hit-specific columns.
 */
interface SearchRow extends ActivityRow {
  readonly snippet: unknown;
  readonly score: unknown;
  readonly matched_in: unknown;
  readonly id_match: unknown;
}

function invalidColumn(field: string, value: unknown): never {
  // This module authors matched_in/id_match/score itself (never user input),
  // so a value outside what it can produce means the row is malformed —
  // narrow.ts's narrowText applies the identical "validation, not internal"
  // reasoning to a malformed *stored* column; this is the same call for a
  // malformed *computed* one.
  throw new KatraException({
    code: "validation",
    message: `search's own ${field} column produced an unexpected value: ${JSON.stringify(value)}`,
    field,
    value,
  });
}

function narrowMatchedIn(value: unknown): "task" | "note" {
  if (value === "task" || value === "note") return value;
  return invalidColumn("matched_in", value);
}

function narrowIdMatch(value: unknown): boolean {
  if (value === 0 || value === 1) return value === 1;
  return invalidColumn("id_match", value);
}

function narrowNullableScore(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number") return value;
  return invalidColumn("score", value);
}

/**
 * Maps one row into a domain object.
 *
 * Reuses `activity.ts`'s {@link rowToHit} for the seven fields `SearchHit`
 * shares with `ActivityHit` — id, title, level, lane, kind, priority, epicId,
 * lastActivity — rather than restating their narrowing a second time, and
 * narrows only this module's own four additions on top.
 */
function rowToSearchHit(row: SearchRow): SearchHit {
  return {
    ...rowToHit(row),
    snippet: narrowNullableText(row.snippet, "snippet"),
    score: narrowNullableScore(row.score),
    matchedIn: narrowMatchedIn(row.matched_in),
    idMatch: narrowIdMatch(row.id_match),
  };
}

/**
 * Runs the text path: the two-tier `tasks_fts`/`notes_fts` union, plus the
 * id-fragment branch when `idFrag` is non-null, rolled up per entity and
 * ranked — see this module's docstring for the full shape and the property
 * rule it pins.
 *
 * Over-fetches by one (`limit + 1`), the `readActivityRows`/`section` idiom
 * this codebase uses everywhere a bound has to report whether it cut the
 * result short.
 */
function textPathRows(
  store: OpenStore,
  expr: string,
  idFrag: string | null,
  filters: FilterConditions,
  limit: number,
): SearchRow[] {
  const branches: string[] = [];
  const params: unknown[] = [];

  if (idFrag !== null) {
    const lower = `${ID_PREFIX}${idFrag}`;
    // U+FFFF sits above every character the id alphabet can produce — the
    // same exclusive upper bound `tasks/ids.ts`'s resolveIdAmong uses.
    const upper = `${lower}￿`;
    branches.push(ID_BRANCH_SQL);
    params.push(lower, upper);
  }

  branches.push(TASK_BRANCH_SQL);
  params.push(expr);
  branches.push(NOTE_BRANCH_SQL);
  params.push(expr);

  const join = activityJoin({ outer: true });
  const where = filters.sql.length === 0 ? "" : `AND ${filters.sql.join(" AND ")}`;

  const sql = `
WITH matches AS (
  ${branches.join("\n  UNION ALL\n  ")}
),
ranked AS (
  SELECT *,
         MAX(id_match) OVER (PARTITION BY entity_id) AS id_match_any,
         ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY tier, score, src_rowid) AS rn
    FROM matches
)
SELECT ${ACTIVITY_COLUMNS},
       r.snippet AS snippet, r.score AS score, r.matched_in AS matched_in, r.id_match_any AS id_match
  FROM ranked r
  JOIN tasks t ON t.id = r.entity_id
  ${join.sql}
 WHERE r.rn = 1
 ${where}
 ORDER BY r.id_match_any DESC, r.tier ASC, r.score ASC, r.src_rowid ASC
 LIMIT ?`;

  return store.db
    .prepare(sql)
    .all(...params, ...join.params, ...filters.params, limit + 1) as SearchRow[];
}

/**
 * Runs the filter-only path: `listTasks`-style dynamic `WHERE`, ordered by
 * last activity — never referencing `tasks_fts`/`notes_fts` at all (the
 * EXPLAIN-verified elimination this module's docstring describes only holds
 * "by construction" because the query never mentions them in the first
 * place).
 *
 * `activityJoin({outer: true})` — a filter narrows, it never deletes: a task
 * matching every filter but never touched still has to appear, with
 * `lastActivity: null`, sorted last. Ordered by `a.last_event_id DESC`, the
 * same total-order column `readRecent` uses and for the identical reason
 * (`activity.ts`'s docs): two rows never share a real event id, so a NULL
 * (event-less) row sorts after every touched one automatically, and `t.rowid`
 * is the deterministic tail among ties within that NULL group.
 */
function filterPathRows(store: OpenStore, filters: FilterConditions, limit: number): SearchRow[] {
  const join = activityJoin({ outer: true });
  const where = filters.sql.length === 0 ? "" : `WHERE ${filters.sql.join(" AND ")}`;

  const sql = `
    SELECT ${ACTIVITY_COLUMNS},
           NULL AS snippet, NULL AS score, 'task' AS matched_in, 0 AS id_match
      FROM tasks t
      ${join.sql}
      ${where}
     ORDER BY a.last_event_id DESC, t.rowid
     LIMIT ?`;

  return store.db.prepare(sql).all(...join.params, ...filters.params, limit + 1) as SearchRow[];
}

/**
 * Reads `search`'s results: full-text over task titles/descriptions and note
 * bodies when `options.query` yields a usable {@link matchExpression}, dynamic
 * filters over `tasks` otherwise. See this module's docstring for the full
 * shape of both paths and the rollup between them.
 *
 * The path choice reads `matchExpression(options.query)`, not merely whether
 * `options.query` is present: a blank or whitespace-only query produces `null`
 * (the one input FTS5's `MATCH` throws on for `''`), and routing that down the
 * text path would mean building a `MATCH` this module knows will throw. Such a
 * query is treated exactly like no query at all — the filter-only path runs,
 * same as `options.query` being absent — leaving the CLI's usage refusal
 * (T6) as the only place that distinguishes "meant to search for nothing" from
 * "gave no query".
 */
export function readSearch(store: OpenStore, options: SearchOptions = {}): SearchResult {
  const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;
  const query = options.query;

  return readTx(store.db, () => {
    const filters = buildFilterConditions(store, options);

    let rows: SearchRow[];
    if (query !== undefined) {
      const expr = matchExpression(query);
      // idFragment gets the trimmed query: matchExpression already splits on
      // whitespace, so a padded query builds the same MATCH expression
      // either way, but idFragment tests the WHOLE string against BASE36 in
      // one shot — an untrimmed trailing space ("kt-9x ") fails that test
      // outright and silently drops the id branch a bare "kt-9x" would have
      // gotten.
      rows =
        expr === null
          ? filterPathRows(store, filters, limit)
          : textPathRows(store, expr, idFragment(query.trim()), filters, limit);
    } else {
      rows = filterPathRows(store, filters, limit);
    }

    return {
      query: query ?? "",
      hits: rows.slice(0, limit).map(rowToSearchHit),
      truncated: rows.length > limit,
    };
  });
}
