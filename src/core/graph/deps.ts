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
 * How many ids go into one `IN (…)`.
 *
 * Well under SQLite's 32,766-variable ceiling, so the margin survives a build
 * compiled with a lower `SQLITE_MAX_VARIABLE_NUMBER` — older defaults were 999.
 * Chunking costs one extra statement per 500 rows; the ceiling costs an
 * exception.
 */
export const ID_CHUNK = 500;

/**
 * The same read for many tasks at once, keyed by task id.
 *
 * `board` renders a whole section of blocked tasks, and calling
 * {@link listBlockers} per row would issue one statement per task **inside**
 * `readTx`'s deferred snapshot. `--limit` is caller-supplied and `narrowCount`
 * permits up to a million, so that fan-out is bounded by the caller, not by
 * anything the module controls — and a read transaction held open across it
 * stops WAL checkpointing for the whole store, which is what `readTx`'s own
 * docstring warns about.
 *
 * Tasks with no unfinished blockers are absent from the map rather than mapped
 * to an empty array; callers default.
 */
export function listBlockersFor(store: OpenStore, ids: readonly string[]): Map<string, Blocker[]> {
  const blockers = new Map<string, Blocker[]>();
  if (ids.length === 0) return blockers;

  // Chunked, because one placeholder per id runs into SQLite's bound-variable
  // ceiling. Measured against the bundled build: 32,766 placeholders bind,
  // 32,767 throws `too many SQL variables` — which surfaces as `internal` and
  // exit 4, telling an agent the machine is broken (ADR-005) over a large but
  // legal `--limit`. The per-row read this replaced had no such cliff, so
  // batching without chunking would trade a slow path for a failing one.
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    const rows = store.db
      .prepare(
        `SELECT d.task_id AS task_id, b.id AS id, b.title AS title, b.lane AS lane
           FROM deps d
           JOIN tasks b ON b.id = d.depends_on_id
          WHERE d.task_id IN (${chunk.map(() => "?").join(",")})
            AND b.lane NOT IN (${sqlEnum(TERMINAL_LANES)})
          ORDER BY b.priority, b.created_at, b.rowid`,
      )
      .all(...chunk) as Array<{ task_id: string; id: string; title: string; lane: string }>;

    for (const row of rows) {
      const blocker = { id: row.id, title: row.title, lane: narrowLane(row.lane) };
      const existing = blockers.get(row.task_id);
      if (existing === undefined) blockers.set(row.task_id, [blocker]);
      else existing.push(blocker);
    }
  }
  return blockers;
}

/**
 * Whether `taskId` is reachable from `dependsOnId` — i.e. whether the proposed
 * edge would close a loop.
 *
 * `UNION`, not `UNION ALL`: deduping makes this a node walk, O(V+E). The
 * path-building query below is a *path* walk, which enumerates every simple
 * path and is exponential in depth — measured on a layered graph at 25ms for
 * 32 tasks, 3.2s for 50, and **17.5s for 60**, roughly 5× per added layer.
 * Its `LIMIT 1` only short-circuits when a cycle exists, so the common case —
 * no cycle, which is every successful `katra dep` — paid the full cost.
 *
 * Detection and naming are therefore split. This answers "is there a cycle?"
 * on the hot path; `cyclePath` runs only after this says yes, where `LIMIT 1`
 * genuinely stops early and the cost is bounded by the cycle it found.
 * Measured after the split: 2,000 tasks and 39,200 edges in 30ms.
 */
function closesCycle(store: OpenStore, taskId: string, dependsOnId: string): boolean {
  const row = store.db
    .prepare(
      `WITH RECURSIVE reach(id) AS (
         SELECT ?
         UNION
         SELECT d.depends_on_id FROM deps d JOIN reach r ON d.task_id = r.id
       )
       SELECT 1 AS hit FROM reach WHERE id = ? LIMIT 1`,
    )
    .get(dependsOnId, taskId) as { hit: number } | undefined;

  return row !== undefined;
}

/**
 * Names the cycle that adding `taskId depends on dependsOnId` would close.
 *
 * A refusal that only says "cycle" leaves the reader to find it themselves,
 * which is why this exists — but it only runs once {@link closesCycle} has
 * confirmed there is one.
 *
 * A breadth-first walk in JavaScript rather than a recursive CTE. The SQL
 * version enumerated simple paths and was exponential in depth even with
 * `LIMIT 1`, because SQLite's queue reaches the target only after expanding
 * most of the frontier: measured at 67 seconds to *name* a cycle across 55
 * tasks in twelve layers. Visiting each node once is O(V+E), and breadth-first
 * yields the **shortest** cycle, which is a better answer than the arbitrary
 * one the CTE happened to find first.
 */
function cyclePath(store: OpenStore, taskId: string, dependsOnId: string): string[] {
  const neighbours = store.db.prepare("SELECT depends_on_id AS id FROM deps WHERE task_id = ?");
  const cameFrom = new Map<string, string>();
  const seen = new Set<string>([dependsOnId]);
  const queue: string[] = [dependsOnId];

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as string;

    if (current === taskId) {
      const path: string[] = [];
      for (let at: string | undefined = current; at !== undefined; at = cameFrom.get(at)) {
        path.unshift(at);
      }
      // Closed with the proposed edge, so the loop reads taskId -> … -> taskId.
      return [taskId, ...path];
    }

    for (const row of neighbours.all(current) as Array<{ id: string }>) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      cameFrom.set(row.id, current);
      queue.push(row.id);
    }
  }

  // Unreachable: `closesCycle` already said the target is reachable. Naming
  // just the endpoints beats throwing — the refusal is correct either way, and
  // a thinner message is better than turning it into a crash.
  return [taskId, dependsOnId];
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
  return writeTx(store.db, (now) => {
    // Resolved inside the transaction. Outside it, another worktree deleting
    // either task before the INSERT turns this into a raw
    // SQLITE_CONSTRAINT_FOREIGNKEY — `INSERT OR IGNORE` does not suppress a
    // foreign-key violation — which surfaces as `internal` and exit 4, telling
    // the caller to retry work that can never succeed. The truth is
    // `not_found`, and it is final.
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

    if (closesCycle(store, taskId, dependsOnId)) {
      throw new KatraException({
        code: "cycle",
        message: `${taskId} cannot depend on ${dependsOnId}: that would close a dependency cycle`,
        path: cyclePath(store, taskId, dependsOnId),
      });
    }

    store.db
      .prepare("INSERT OR IGNORE INTO deps (task_id, depends_on_id, created_at) VALUES (?,?,?)")
      .run(taskId, dependsOnId, now);

    return { taskId, dependsOnId };
  });
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
