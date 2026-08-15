/**
 * The shared "last activity per live entity" fragment, and the `recent`/
 * `stale` reads built on it (F6 T4).
 *
 * At the core root rather than under `tasks/`, mirroring `board.ts`: this
 * composes `tasks` with `events` from above, so it belongs to neither
 * directory. `search`'s filter path (T5) and ranking (both text and filter
 * paths) reuse {@link activityJoin} rather than hand-writing a second
 * "last activity" query — the exact drift `tasks/next.ts`'s `RANKING_TAIL`
 * doctrine warns about: a second spelling is how two commands quietly
 * disagree about what "last touched" means.
 */

import type { ActivityHit, RecentResult, StaleResult } from "./contract.js";
import { readTx } from "./db/connection.js";
import { sqlEnum, TERMINAL_LANES } from "./enums.js";
import {
  narrowKind,
  narrowLane,
  narrowLevel,
  narrowNullableText,
  narrowPriority,
  narrowText,
} from "./narrow.js";
import type { OpenStore } from "./store.js";

/** A SQL fragment and the parameters it binds, in text order — `next.ts`'s `Conditions` shape. */
interface Conditions {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The one spelling of "last activity per live entity", as a join clause.
 *
 * **Assumes the caller's `FROM` is `tasks t`** — every consumer in this
 * codebase aliases `tasks` to `t` (`next.ts`'s own docs state the rule), and
 * this fragment is written to be concatenated straight after it. It produces
 * its own alias, `a`, over a per-entity aggregate against `events e`:
 *
 * - `a.last_event_id` = `MAX(e.id)` — `events.id` is katra's total order,
 *   assigned inside the write transaction, so two events landing in the same
 *   millisecond still rank correctly. Every ordering in this module reads
 *   this column, never the timestamp.
 * - `a.last_activity` = `MAX(e.created_at)` — the canonical timestamp a
 *   caller compares a cutoff against (see {@link activityCutoff}). A cutoff
 *   compared against an integer id would be meaningless, and an id compared
 *   for a total order is exactly right — the two columns are deliberately
 *   not interchangeable.
 *
 * **Both join modes are load-bearing.** `{outer: false}` (INNER) is what
 * `readRecent`/`readStale` use below: activity *is* the subject of those
 * reads, so an entity with zero events has nothing to report and must not
 * appear. Because the query is anchored at `tasks`, a deleted task can never
 * surface either way — its row is gone, however many events still name it
 * (ADR-008) — INNER additionally requires "and it has at least one event".
 * `{outer: true}` (LEFT) is what search's filter path (T5) needs instead: a
 * filter narrows, it never deletes, so a task that matches the filters but
 * was never touched must still appear, with `lastActivity: null`, sorted
 * last. Probe-verified during F6 research: using INNER there silently
 * dropped matching rows — exactly the bug a "just always use INNER" shortcut
 * would reintroduce.
 *
 * Returns `{sql, params}` rather than a bare string constant (`next.ts`'s
 * `TASK_RANKING`), even though this particular fragment binds nothing of its
 * own: the join mode is a runtime choice a string cannot carry, and this
 * shape matches {@link activityCutoff}, which does bind a parameter — a
 * caller composing the two needs both to answer `{sql, params}` the same
 * way. `params` is always `[]` here, so it never shifts a composed query's
 * bind order by itself.
 */
export function activityJoin({ outer }: { outer: boolean }): Conditions {
  return {
    sql: `${outer ? "LEFT" : "INNER"} JOIN (
        SELECT e.entity_id AS entity_id,
               MAX(e.id) AS last_event_id,
               MAX(e.created_at) AS last_activity
          FROM events e
         GROUP BY e.entity_id
      ) a ON a.entity_id = t.id`,
    params: [],
  };
}

/**
 * "Strictly older than" or "strictly newer than" `cutoff`, against
 * {@link activityJoin}'s `a.last_activity` — T2's pinned boundary semantics
 * applied at the read layer: the boundary instant itself belongs to
 * *neither* window, only what comes strictly before or strictly after it
 * does (`clock.ts`'s `parseWhen`: "Callers compare with `<`, never `<=`" —
 * mirrored here as `>`, never `>=`, for the `"after"` direction, so an
 * activity landing exactly on the cutoff is outside both, not inside
 * either).
 *
 * `direction` defaults to `"before"` — every caller until search's
 * `--updated-after` (T5) only ever needed that side, so widening this rather
 * than adding a second, near-identical function gives the mirrored `>` form
 * an owner instead of a third spelling of the same boundary rule.
 *
 * `cutoff` arrives already in katra's canonical timestamp format. Nothing
 * here parses it — T2's `parseWhen`/`narrowWhen` are the CLI-facing parser;
 * this function trusts its caller the same way `next.ts`'s `conditionsFor`
 * trusts an already-resolved epic id.
 *
 * One `?`, binding `cutoff`. {@link activityJoin} binds nothing, so a caller
 * that concatenates this fragment straight after it keeps binding in text
 * order automatically; concatenated after any other `?`-bearing fragment,
 * `cutoff` has to sit at the matching position in the final params array —
 * the positional-binding trap `board.ts`'s `section` documents.
 */
export function activityCutoff(
  cutoff: string,
  direction: "before" | "after" = "before",
): Conditions {
  return { sql: `a.last_activity ${direction === "before" ? "<" : ">"} ?`, params: [cutoff] };
}

/** How many rows a read returns when the caller does not say. */
export const DEFAULT_ACTIVITY_LIMIT = 20;

/**
 * The raw shape SQLite hands back for an activity row — exported so
 * `search.ts` (T5) can extend it with its own hit-specific columns
 * (`SearchRow extends ActivityRow`) rather than re-declaring the same seven
 * field names a second time.
 */
export interface ActivityRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly level: unknown;
  readonly lane: unknown;
  readonly kind: unknown;
  readonly priority: unknown;
  readonly epic_id: unknown;
  readonly last_activity: unknown;
}

/**
 * Maps one row into a domain object, narrowing every column.
 *
 * Exported for the same reason as {@link ActivityRow}: `search.ts`'s
 * `SearchHit` extends `ActivityHit`, and its own row-mapper spreads this
 * function's result rather than re-narrowing the seven fields the two
 * shapes share.
 */
export function rowToHit(row: ActivityRow): ActivityHit {
  return {
    id: narrowText(row.id, "id"),
    title: narrowText(row.title, "title"),
    level: narrowLevel(row.level),
    lane: narrowLane(row.lane),
    kind: narrowKind(row.kind),
    priority: narrowPriority(row.priority),
    epicId: narrowNullableText(row.epic_id, "epic_id"),
    lastActivity: narrowNullableText(row.last_activity, "last_activity"),
  };
}

/**
 * The `SELECT` list every read in this module shares — exported so
 * `search.ts` (T5) composes its own `SELECT` from the identical column list
 * plus its hit-specific columns, rather than a second, easily-drifting copy
 * of these exact seven aliases.
 */
export const ACTIVITY_COLUMNS = `t.id AS id, t.title AS title, t.level AS level, t.lane AS lane,
       t.kind AS kind, t.priority AS priority, t.parent_id AS epic_id,
       a.last_activity AS last_activity`;

/**
 * Runs one activity-shaped query — the skeleton `readRecent` and `readStale`
 * both need (join, `SELECT` prefix, over-fetch-by-one, slice, truncation
 * report) — the same shape `board.ts`'s `section` absorbs for its own
 * sections, cited in both callers' docs below and now factored the same way.
 *
 * Always joins {@link activityJoin}`({outer: false})`: every caller in this
 * module wants activity to be the subject of its read (an entity with zero
 * events has nothing to report and must not appear), so INNER is not a
 * parameter here — a caller wanting the outer form composes
 * {@link activityJoin} directly instead of going through this helper (see
 * `search.ts`, T5).
 *
 * `where` is optional and, when given, is assumed already `AND`-joined by
 * the caller (`readStale`'s lane exclusion plus its cutoff). Bind order
 * follows the SQL text: {@link activityJoin}'s own params (`[]` today)
 * first, then `params` — which back `where` — then `limit + 1` last, since
 * `LIMIT ?` is the final `?` in the statement.
 */
function readActivityRows(
  store: OpenStore,
  options: {
    readonly where?: string;
    readonly params?: readonly unknown[];
    readonly orderBy: string;
    readonly limit: number;
  },
): { readonly rows: readonly ActivityHit[]; readonly truncated: boolean } {
  const join = activityJoin({ outer: false });
  const params = options.params ?? [];

  const rows = store.db
    .prepare(
      `SELECT ${ACTIVITY_COLUMNS}
         FROM tasks t
         ${join.sql}
         ${options.where === undefined ? "" : `WHERE ${options.where}`}
        ORDER BY ${options.orderBy}
        LIMIT ?`,
    )
    .all(...join.params, ...params, options.limit + 1) as ActivityRow[];

  return {
    rows: rows.slice(0, options.limit).map(rowToHit),
    truncated: rows.length > options.limit,
  };
}

export interface RecentOptions {
  /** Newest-activity-first this many. Defaults to {@link DEFAULT_ACTIVITY_LIMIT}. */
  readonly limit?: number;
}

/**
 * Reads the entities with the most recent activity, newest first.
 *
 * Epics are included on equal footing with tasks — see `ActivityHit`'s docs
 * — and a deleted task's surviving events (ADR-008) never surface here,
 * because {@link readActivityRows}'s query is anchored at `tasks` and that
 * task's row is gone. Ordered by `a.last_event_id DESC` — see
 * {@link activityJoin}'s docs for why the id column, not the timestamp.
 *
 * Wrapped in `readTx` even though `readActivityRows` issues one statement,
 * so a future second query added here (as `board`'s sections were) inherits
 * one consistent snapshot without a caller having to remember to add it.
 */
export function readRecent(store: OpenStore, options: RecentOptions = {}): RecentResult {
  const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;

  return readTx(store.db, () => {
    const { rows, truncated } = readActivityRows(store, { orderBy: "a.last_event_id DESC", limit });
    return { hits: rows, truncated };
  });
}

export interface StaleOptions {
  /**
   * The cutoff, already resolved to katra's canonical timestamp format
   * (T2's `parseWhen` at the CLI boundary). Not parsed here — see
   * {@link activityCutoff}.
   */
  readonly olderThan: string;
  /** Most-forgotten-first this many. Defaults to {@link DEFAULT_ACTIVITY_LIMIT}. */
  readonly limit?: number;
}

/**
 * Reads open (non-terminal) entities whose last activity is strictly older
 * than `olderThan`, oldest first — most-forgotten first, so the item nothing
 * has touched the longest leads.
 *
 * Excludes terminal lanes: `Done` and `Cancelled` work is not waiting to be
 * remembered. Ordered by `a.last_event_id ASC` — the same total-order column
 * `readRecent` orders by, just ascending — rather than `a.last_activity`,
 * for the reason {@link activityJoin}'s docs state: it is the column that
 * cannot tie between two different entities.
 */
export function readStale(store: OpenStore, options: StaleOptions): StaleResult {
  const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;
  const cutoff = activityCutoff(options.olderThan);

  return readTx(store.db, () => {
    const { rows, truncated } = readActivityRows(store, {
      where: `t.lane NOT IN (${sqlEnum(TERMINAL_LANES)}) AND ${cutoff.sql}`,
      params: cutoff.params,
      orderBy: "a.last_event_id ASC",
      limit,
    });
    return { hits: rows, truncated, olderThan: options.olderThan };
  });
}
