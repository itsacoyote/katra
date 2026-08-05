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

/** Builds the shared filter clause. Column names are literals; values bind. */
function conditionsFor(filters: NextFilters, ready: boolean): Conditions {
  const parts = [`t.lane = ?`, `r.is_ready = ?`];
  const params: unknown[] = [NEXT_LANE, ready ? 1 : 0];

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
  const ready = conditionsFor(filters, true);
  const candidate = store.db
    .prepare(
      `SELECT t.id AS id FROM tasks t
         JOIN ${READINESS_VIEW} r ON r.id = t.id
        WHERE ${ready.sql}
        ORDER BY t.priority, t.created_at, t.rowid
        LIMIT 1`,
    )
    .get(...ready.params) as { id: string } | undefined;

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
        ORDER BY t.priority, t.created_at, t.rowid`,
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
  };
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
