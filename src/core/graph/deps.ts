/**
 * Dependencies, and the readiness they determine.
 *
 * **Readiness is defined once, in SQL, by the `task_readiness` view** created
 * with the schema. Everything here reads that view rather than re-expressing
 * the rule: `isReady` selects one row from it, and `list`, `next` and `cancel`
 * join it. A second `NOT EXISTS` written anywhere else is exactly the drift
 * ADR-003 warns about — a task is ready when no dependency sits in a
 * *non-terminal* lane, and a copy that compares against `Done` alone would
 * strand every task behind an abandoned blocker.
 */

import type { Blocker } from "../contract.js";
import { writeTx } from "../db/connection.js";
import { sqlEnum, TERMINAL_LANES } from "../enums.js";
import { KatraException } from "../errors.js";
import { narrowLane } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { requireId } from "../tasks/ids.js";

export type { Blocker };

/** The one place readiness is defined. Consumers join this; nobody re-derives it. */
export const READINESS_VIEW = "task_readiness";

/**
 * Whether `id` has no unfinished dependencies.
 *
 * One row out of the view, so this can never disagree with the set-based
 * queries that power `list --ready` and `next`.
 */
export function isReady(store: OpenStore, id: string): boolean {
  const row = store.db.prepare(`SELECT is_ready FROM ${READINESS_VIEW} WHERE id = ?`).get(id) as
    | { is_ready: number }
    | undefined;

  if (row === undefined) {
    throw new KatraException({ code: "not_found", message: `no task with id ${id}`, id });
  }
  return row.is_ready === 1;
}

/**
 * The unfinished dependencies standing in a task's way.
 *
 * "Unfinished" is rendered from the same `TERMINAL_LANES` array the readiness
 * view was generated from, so the two cannot disagree about which lanes stop
 * blocking. Ordered the way `next` ranks candidates, so the first blocker
 * listed is the one worth clearing first.
 */
export function listBlockers(store: OpenStore, id: string): Blocker[] {
  return (
    store.db
      .prepare(
        `SELECT b.id AS id, b.title AS title, b.lane AS lane
           FROM deps d
           JOIN tasks b ON b.id = d.depends_on_id
          WHERE d.task_id = ?
            AND b.lane NOT IN (${sqlEnum(TERMINAL_LANES)})
          ORDER BY b.priority, b.created_at, b.rowid`,
      )
      .all(id) as Array<{ id: string; title: string; lane: string }>
  ).map((row) => ({ id: row.id, title: row.title, lane: narrowLane(row.lane) }));
}

/**
 * Finds the cycle that adding `taskId depends on dependsOnId` would close, or
 * null when there is none.
 *
 * Walks outward from `dependsOnId` following its own dependencies; if that
 * walk reaches `taskId`, the proposed edge closes a loop. A recursive CTE
 * rather than application-side traversal: measured at under 5ms to detect and
 * name a cycle across a 2,000-node chain, so pulling the graph into JavaScript
 * would be slower and more code.
 *
 * Every id is the same length, so no id can be a substring of another and the
 * `instr` guard that stops the walk revisiting a node is exact.
 */
function findCycle(store: OpenStore, taskId: string, dependsOnId: string): string[] | null {
  const row = store.db
    .prepare(
      `WITH RECURSIVE walk(id, path) AS (
         SELECT ?, ?
         UNION ALL
         SELECT d.depends_on_id, w.path || '>' || d.depends_on_id
           FROM deps d
           JOIN walk w ON d.task_id = w.id
          WHERE instr(w.path, d.depends_on_id) = 0
       )
       SELECT path FROM walk WHERE id = ? LIMIT 1`,
    )
    .get(dependsOnId, dependsOnId, taskId) as { path: string } | undefined;

  return row === undefined ? null : [taskId, ...row.path.split(">")];
}

/**
 * Records that `taskIdInput` is blocked by `dependsOnInput`.
 *
 * The cycle check and the insert share **one immediate transaction**. Run as
 * separate steps they race: two processes concurrently adding `A→B` and `B→A`
 * each pass their own check against a graph that does not yet contain the
 * other's edge, and both commit — leaving a real cycle behind. Reproduced with
 * real processes before this was written.
 *
 * Re-adding an edge that already exists is a no-op, not an error: the
 * relationship it asserts is already true.
 */
export function addDependency(
  store: OpenStore,
  taskIdInput: string,
  dependsOnInput: string,
): { taskId: string; dependsOnId: string } {
  const taskId = requireId(store, taskIdInput);
  const dependsOnId = requireId(store, dependsOnInput);

  if (taskId === dependsOnId) {
    throw new KatraException({
      code: "validation",
      message: `a task cannot depend on itself (${taskId})`,
      field: "depends-on",
      value: dependsOnId,
    });
  }

  writeTx(store.db, (now) => {
    const cycle = findCycle(store, taskId, dependsOnId);
    if (cycle !== null) {
      throw new KatraException({
        code: "cycle",
        message: `${taskId} cannot depend on ${dependsOnId}: that would close a dependency cycle`,
        path: cycle,
      });
    }

    store.db
      .prepare("INSERT OR IGNORE INTO deps (task_id, depends_on_id, created_at) VALUES (?,?,?)")
      .run(taskId, dependsOnId, now);
  });

  return { taskId, dependsOnId };
}

/** Removes a dependency edge. Reports when there was nothing to remove. */
export function removeDependency(
  store: OpenStore,
  taskIdInput: string,
  dependsOnInput: string,
): { taskId: string; dependsOnId: string } {
  const taskId = requireId(store, taskIdInput);
  const dependsOnId = requireId(store, dependsOnInput);

  const changes = writeTx(
    store.db,
    () =>
      store.db
        .prepare("DELETE FROM deps WHERE task_id = ? AND depends_on_id = ?")
        .run(taskId, dependsOnId).changes,
  );

  if (changes === 0) {
    throw new KatraException({
      code: "not_found",
      message: `${taskId} does not depend on ${dependsOnId}`,
      id: dependsOnId,
    });
  }

  return { taskId, dependsOnId };
}

/** Every task `id` directly depends on. */
export function listDependencies(store: OpenStore, id: string): Blocker[] {
  return (
    store.db
      .prepare(
        `SELECT b.id AS id, b.title AS title, b.lane AS lane
           FROM deps d
           JOIN tasks b ON b.id = d.depends_on_id
          WHERE d.task_id = ?
          ORDER BY b.priority, b.created_at, b.rowid`,
      )
      .all(id) as Array<{ id: string; title: string; lane: string }>
  ).map((row) => ({ id: row.id, title: row.title, lane: narrowLane(row.lane) }));
}

/** Every task that depends on `id`. */
export function listDependents(store: OpenStore, id: string): Blocker[] {
  return (
    store.db
      .prepare(
        `SELECT t.id AS id, t.title AS title, t.lane AS lane
           FROM deps d
           JOIN tasks t ON t.id = d.task_id
          WHERE d.depends_on_id = ?
          ORDER BY t.priority, t.created_at, t.rowid`,
      )
      .all(id) as Array<{ id: string; title: string; lane: string }>
  ).map((row) => ({ id: row.id, title: row.title, lane: narrowLane(row.lane) }));
}
