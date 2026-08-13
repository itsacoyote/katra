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
 * "Strictly older than `cutoff`", against {@link activityJoin}'s
 * `a.last_activity` — T2's pinned boundary semantics applied at the read
 * layer: the boundary instant itself is not stale, only what comes strictly
 * before it.
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
export function activityCutoff(cutoff: string): Conditions {
  return { sql: "a.last_activity < ?", params: [cutoff] };
}

/** How many rows a read returns when the caller does not say. */
export const DEFAULT_ACTIVITY_LIMIT = 20;

/** The raw shape SQLite hands back for an activity row. */
interface ActivityRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly level: unknown;
  readonly lane: unknown;
  readonly kind: unknown;
  readonly priority: unknown;
  readonly epic_id: unknown;
  readonly last_activity: unknown;
}

/** Maps one row into a domain object, narrowing every column. */
function rowToHit(row: ActivityRow): ActivityHit {
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

/** The `SELECT` list every read in this module shares. */
const ACTIVITY_COLUMNS = `t.id AS id, t.title AS title, t.level AS level, t.lane AS lane,
       t.kind AS kind, t.priority AS priority, t.parent_id AS epic_id,
       a.last_activity AS last_activity`;

export interface RecentOptions {
  /** Newest-activity-first this many. Defaults to {@link DEFAULT_ACTIVITY_LIMIT}. */
  readonly limit?: number;
}

/**
 * Reads the entities with the most recent activity, newest first.
 *
 * Joins {@link activityJoin}`({outer: false})`: activity is the subject of
 * this read, so an entity that has never had an event has nothing to report
 * and does not appear. Epics are included on equal footing with tasks — see
 * `ActivityHit`'s docs — and a deleted task's surviving events (ADR-008)
 * never surface here, because the query is anchored at `tasks` and that
 * task's row is gone.
 *
 * Over-fetches by one so truncation is knowable, the same idiom `listEvents`
 * and `board`'s `section` use: a bound that cannot report itself is
 * indistinguishable from the end of the data. Wrapped in `readTx` even
 * though this is one statement, so a future second query added here (as
 * `board`'s sections were) inherits one consistent snapshot without a caller
 * having to remember to add it.
 */
export function readRecent(store: OpenStore, options: RecentOptions = {}): RecentResult {
  const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;
  const join = activityJoin({ outer: false });

  return readTx(store.db, () => {
    const rows = store.db
      .prepare(
        `SELECT ${ACTIVITY_COLUMNS}
           FROM tasks t
           ${join.sql}
          ORDER BY a.last_event_id DESC
          LIMIT ?`,
      )
      .all(...join.params, limit + 1) as ActivityRow[];

    return {
      hits: rows.slice(0, limit).map(rowToHit),
      truncated: rows.length > limit,
    };
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
 * Joins {@link activityJoin}`({outer: false})` for the same reason
 * {@link readRecent} does, and additionally excludes terminal lanes: `Done`
 * and `Cancelled` work is not waiting to be remembered. Ordered by
 * `a.last_event_id ASC` — the same total-order column `readRecent` orders
 * by, just ascending — rather than `a.last_activity`, for the reason
 * {@link activityJoin}'s docs state: it is the column that cannot tie
 * between two different entities.
 */
export function readStale(store: OpenStore, options: StaleOptions): StaleResult {
  const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;
  const join = activityJoin({ outer: false });
  const cutoff = activityCutoff(options.olderThan);

  return readTx(store.db, () => {
    const rows = store.db
      .prepare(
        `SELECT ${ACTIVITY_COLUMNS}
           FROM tasks t
           ${join.sql}
          WHERE t.lane NOT IN (${sqlEnum(TERMINAL_LANES)}) AND ${cutoff.sql}
          ORDER BY a.last_event_id ASC
          LIMIT ?`,
      )
      .all(...join.params, ...cutoff.params, limit + 1) as ActivityRow[];

    return {
      hits: rows.slice(0, limit).map(rowToHit),
      truncated: rows.length > limit,
      olderThan: options.olderThan,
    };
  });
}
