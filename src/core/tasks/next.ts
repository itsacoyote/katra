/**
 * `next` — the one task to work on.
 *
 * The command that makes katra useful to an agent rather than merely a place
 * to store tasks. It answers a question the backlog cannot answer by being
 * read: of everything planned, what can actually be started right now?
 *
 * The empty case carries data on purpose. "Nothing is ready" and "there is no
 * work left" are different answers, and an agent that conflates them stops.
 */

import type { BlockedTask, NextResult } from "../contract.js";
import type { Kind, Level } from "../enums.js";
import { sqlEnum, TERMINAL_LANES } from "../enums.js";
import { KatraException } from "../errors.js";
import { listBlockers, READINESS_VIEW } from "../graph/deps.js";
import type { OpenStore } from "../store.js";
import { getTask } from "./repo.js";
import { summarise } from "./types.js";

export type { BlockedTask, NextResult };

/** The lane `next` draws from: work that has been planned but not started. */
export const NEXT_LANE = "Planned";

/**
 * How katra ranks tasks against each other, everywhere.
 *
 * Priority, then oldest first, then `rowid` — the last because two tasks
 * written in the same millisecond are routine and would otherwise come back in
 * an arbitrary order between runs.
 *
 * Exported because `board` ranks three sections by it and this fragment is
 * already hand-written at seven call sites. An eighth and ninth typed by hand
 * is how two commands quietly start disagreeing about what comes first — and
 * `board`'s contract is that its top ready row *is* what `next` returns.
 *
 * The `t.` prefix is part of it: every consumer aliases `tasks` to `t`.
 */
export const TASK_RANKING = "ORDER BY t.priority, t.created_at, t.rowid";

/**
 * {@link TASK_RANKING} with an extra sort key spliced in ahead of priority.
 *
 * The composition point plan-review MEDIUM-6 asked for: `next` leads with
 * "claimed by me first" ({@link OWN_CLAIM_FIRST} below), and T7's board ready
 * section leads with "unclaimed first, other-claimed last" (ADR-012). Both
 * want the same "priority, then oldest, then rowid" tail, and a ninth
 * hand-typed copy of it is exactly the drift {@link TASK_RANKING}'s own docs
 * warn about.
 */
export function rankingWith(prefix: string): string {
  return `ORDER BY ${prefix}, t.priority, t.created_at, t.rowid`;
}

/**
 * The claims join and the "belongs to someone else" test every claim-aware
 * query in this module shares — the one spelling of claim classification
 * (plan-review HIGH-1). A claim is never a filter baked into
 * {@link readyPredicate} or {@link conditionsFor}: only the candidate query in
 * {@link nextTask} applies `CLAIMED_ELSEWHERE` as an exclusion. The blocked
 * branch and `countUntriaged` join nothing and stay exactly as F3 left them.
 *
 * `CLAIMED_ELSEWHERE`'s single `?` binds the caller's own worktree
 * (`store.identity().worktree`) — wherever this fragment lands in a query's
 * text is where that parameter belongs in the bound params array.
 */
export const CLAIMS_JOIN = "LEFT JOIN claims c ON c.task_id = t.id";

/** True when the row's claim belongs to a worktree other than the caller's. */
export const CLAIMED_ELSEWHERE = "(c.task_id IS NOT NULL AND c.holder <> ?)";

/**
 * Ranks the caller's own claim ahead of every other candidate — including a
 * higher-priority unclaimed task — so a session that loses context (`/clear`,
 * crash, restart) resumes exactly where it left off instead of being handed
 * something else (ADR-012). Scoped by construction: this only reorders rows
 * {@link readyPredicate} already admitted into the Planned-and-ready pool, so
 * an own claim that has moved out of `Planned` never re-enters here.
 */
const OWN_CLAIM_FIRST = "CASE WHEN c.holder = ? THEN 0 ELSE 1 END";

export interface NextFilters {
  readonly kind?: Kind;
  readonly level?: Level;
  /** Epic id, already resolved. */
  readonly epic?: string;
}

interface Conditions {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Just the caller's narrowing, without any lane or readiness condition.
 *
 * Split out because the untriaged count below asks a different question of the
 * same subset: not "which planned task is ready" but "how much work is there
 * that nobody has planned yet".
 */
function filtersOnly(filters: NextFilters): Conditions {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (filters.kind !== undefined) {
    parts.push("t.kind = ?");
    params.push(filters.kind);
  }
  if (filters.level !== undefined) {
    parts.push("t.level = ?");
    params.push(filters.level);
  }
  if (filters.epic !== undefined) {
    parts.push("t.parent_id = ?");
    params.push(filters.epic);
  }

  return { sql: parts.join(" AND "), params };
}

/**
 * The lane-and-readiness pair, plus the caller's narrowing.
 *
 * Built on {@link filtersOnly} rather than repeating it: a fourth filter added
 * to one and not the other would make `next` and its untriaged count disagree
 * about which tasks they are talking about, silently.
 *
 * **Epics are excluded here, so both branches inherit it.** `next` used to
 * exclude them from its untriaged count and nowhere else, which meant a
 * `Planned` epic at a low priority number was returned as the task to work on,
 * and a blocked one was listed as work waiting to start. An epic is a
 * container; nobody picks one up. An explicit `--level` still wins, so
 * `next --level epic` asks the literal question.
 *
 * Fixing only the candidate query would have been worse than fixing neither:
 * `next` would refuse to *offer* an epic while still advertising one as blocked
 * work.
 */
function conditionsFor(filters: NextFilters, ready: boolean): Conditions {
  const narrowing = filtersOnly(filters);
  const parts = [
    "t.lane = ?",
    "r.is_ready = ?",
    ...(filters.level === undefined ? ["t.level = 'task'"] : []),
    ...(narrowing.sql === "" ? [] : [narrowing.sql]),
  ];

  return {
    sql: parts.join(" AND "),
    params: [NEXT_LANE, ready ? 1 : 0, ...narrowing.params],
  };
}

/**
 * What "startable" means, as a SQL fragment and its parameters.
 *
 * The real shared surface between `next` and `board`, together with
 * {@link TASK_RANKING}. Board issues its own `SELECT` — it needs `is_ready` per
 * row for the in-flight blocked marker, which this query does not carry — so
 * the two are not one query. They share the *predicate*, which is the thing
 * that would otherwise drift: without it board hand-writes a fourth copy of
 * "planned and unblocked and not an epic" and the first ready row stops
 * agreeing with what `next` returns.
 *
 * The fragment assumes the aliases `t` and `r`, and is parenthesis-free: both
 * consumers concatenate it with `AND`, so a top-level `OR` added here would
 * silently change what every caller means.
 */
export function readyPredicate(filters: NextFilters = {}): Conditions {
  return conditionsFor(filters, true);
}

/**
 * Returns the single highest-priority startable task, or every planned task
 * that is blocked and why.
 *
 * Ranking is priority, then oldest first, then `rowid` — the last because two
 * tasks written in the same millisecond are routine and would otherwise come
 * back in an arbitrary order between runs.
 *
 * Filters narrow the candidate pool; they never turn one result into several.
 */
export function nextTask(store: OpenStore, filters: NextFilters = {}): NextResult {
  const ready = readyPredicate(filters);
  const worktree = store.identity().worktree;
  const candidate = store.db
    .prepare(
      `SELECT t.id AS id FROM tasks t
         JOIN ${READINESS_VIEW} r ON r.id = t.id
         ${CLAIMS_JOIN}
        WHERE ${ready.sql} AND NOT ${CLAIMED_ELSEWHERE}
        ${rankingWith(OWN_CLAIM_FIRST)}
        LIMIT 1`,
    )
    .get(...ready.params, worktree, worktree) as { id: string } | undefined;

  if (candidate !== undefined) {
    const task = getTask(store, candidate.id);
    if (task === undefined) {
      // The row was returned by the query one statement ago. Falling through to
      // the blocked query here, as this used to, would answer "nothing is
      // ready" — indistinguishable from a genuinely stuck backlog, and an agent
      // reading that stops working.
      throw new KatraException({
        code: "not_found",
        message: `task ${candidate.id} disappeared between being selected and being read`,
        id: candidate.id,
      });
    }
    const parent = task.parentId === null ? undefined : getTask(store, task.parentId);
    return {
      status: "found",
      task,
      epic: parent === undefined ? null : summarise(parent),
    };
  }

  // Nothing startable. Say what is planned but blocked, so the answer points
  // at the work that would unblock the most.
  const stuck = conditionsFor(filters, false);
  const blockedRows = store.db
    .prepare(
      `SELECT t.id AS id, t.title AS title FROM tasks t
         JOIN ${READINESS_VIEW} r ON r.id = t.id
        WHERE ${stuck.sql}
        ${TASK_RANKING}`,
    )
    .all(...stuck.params) as Array<{ id: string; title: string }>;

  return {
    status: "none",
    blocked: blockedRows.map((row) => ({
      id: row.id,
      title: row.title,
      blockers: listBlockers(store, row.id),
    })),
    untriaged: countUntriaged(store, filters),
    claimedElsewhere: countClaimedElsewhere(store, filters, worktree),
  };
}

/**
 * How many otherwise-startable tasks are claimed by a worktree other than
 * `worktree`.
 *
 * Only ever asked once the candidate query above has already come back
 * empty — a second question over the same {@link readyPredicate} pool, this
 * time about who holds it rather than whether it is free. What lets an
 * all-claimed backlog answer differently from a genuinely empty one
 * (ADR-012), the same way `untriaged` separates "nothing planned" from
 * "everything planned is blocked".
 */
function countClaimedElsewhere(store: OpenStore, filters: NextFilters, worktree: string): number {
  const ready = readyPredicate(filters);
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks t
         JOIN ${READINESS_VIEW} r ON r.id = t.id
         ${CLAIMS_JOIN}
        WHERE ${ready.sql} AND ${CLAIMED_ELSEWHERE}`,
    )
    .get(...ready.params, worktree) as { c: number };
  return row.c;
}

/**
 * How much unfinished work sits outside the `Planned` lane.
 *
 * "Nothing is planned" and "everything planned is blocked" are different
 * answers, and the first one used to render as a dead end: `add` puts a task
 * in `Defined`, so a fresh store answers `next` with a sentence naming a lane
 * the caller has never heard of and no way forward. This is the number that
 * makes the difference statable — and distinguishes both from a store with no
 * work in it at all.
 *
 * Terminal lanes are excluded: finished and abandoned work is not waiting to
 * be triaged.
 */
function countUntriaged(store: OpenStore, filters: NextFilters): number {
  const narrowing = filtersOnly(filters);
  // Epics are excluded for the same reason `list --ready` excludes them: an
  // epic is a container, not something anyone picks up, so counting one would
  // invite the caller to plan work that does not exist. An explicit `--level`
  // still wins, so `next --level epic` reports about epics.
  const epics = filters.level === undefined ? "AND t.level = 'task'" : "";
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks t
        WHERE t.lane <> ?
          AND t.lane NOT IN (${sqlEnum(TERMINAL_LANES)})
          ${epics}
          ${narrowing.sql === "" ? "" : `AND ${narrowing.sql}`}`,
    )
    .get(NEXT_LANE, ...narrowing.params) as { c: number };
  return row.c;
}
