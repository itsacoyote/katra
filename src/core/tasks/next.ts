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

import type { Kind, Level } from "../enums.js";
import { KatraException } from "../errors.js";
import type { Blocker } from "../graph/deps.js";
import { listBlockers, READINESS_VIEW } from "../graph/deps.js";
import type { OpenStore } from "../store.js";
import { getTask } from "./repo.js";
import type { Task, TaskSummary } from "./types.js";
import { summarise } from "./types.js";

/** The lane `next` draws from: work that has been planned but not started. */
export const NEXT_LANE = "Planned";

/** A planned task that cannot be started, and what stands in its way. */
export interface BlockedTask {
  readonly id: string;
  readonly title: string;
  readonly blockers: readonly Blocker[];
}

/**
 * Deliberately a discriminated union rather than `Task | null`: the empty case
 * has to carry the blockers, or the caller learns only that it got nothing.
 */
export type NextResult =
  | { readonly status: "found"; readonly task: Task; readonly epic: TaskSummary | null }
  | { readonly status: "none"; readonly blocked: readonly BlockedTask[] };

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
    const parent = task.parentId === null ? null : getTask(store, task.parentId);
    return {
      status: "found",
      task,
      epic: parent === undefined || parent === null ? null : summarise(parent),
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
  };
}
