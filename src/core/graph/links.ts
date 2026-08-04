/**
 * Symmetric associations between tasks.
 *
 * A link says "these two are related" and nothing more. It carries **no**
 * blocking meaning — that is what a dependency is for — so linking two tasks
 * can never change whether either is ready.
 *
 * Symmetry is a storage invariant rather than application discipline: the
 * table's `CHECK (a_id < b_id)` means one pair can only ever occupy one row,
 * in one order. Every write here sorts the two ids first, because inserting
 * them in the order the user happened to type fails the constraint about half
 * the time.
 */

import { writeTx } from "../db/connection.js";
import { KatraException } from "../errors.js";
import { narrowLane, narrowLevel } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { requireId } from "../tasks/ids.js";
import type { TaskSummary } from "../tasks/types.js";

/** Puts a pair into the canonical order the table stores. */
function canonical(first: string, second: string): [string, string] {
  const [a, b] = [first, second].sort();
  return [a as string, b as string];
}

function resolvePair(store: OpenStore, firstInput: string, secondInput: string): [string, string] {
  const first = requireId(store, firstInput);
  const second = requireId(store, secondInput);

  if (first === second) {
    throw new KatraException({
      code: "validation",
      message: `a task cannot be linked to itself (${first})`,
      field: "link",
      value: first,
    });
  }
  return canonical(first, second);
}

/**
 * Links two tasks.
 *
 * Idempotent in both directions: the relationship a repeated call asserts is
 * already true, so re-linking is a no-op rather than an error. Note this is
 * the *same* SQLite error code as an id collision but needs the opposite
 * handling — there, a duplicate means try again with a new id; here it means
 * the work is already done.
 */
export function addLink(
  store: OpenStore,
  firstInput: string,
  secondInput: string,
): { a: string; b: string } {
  const [a, b] = resolvePair(store, firstInput, secondInput);

  writeTx(store.db, (now) => {
    store.db
      .prepare("INSERT OR IGNORE INTO links (a_id, b_id, created_at) VALUES (?,?,?)")
      .run(a, b, now);
  });

  return { a, b };
}

/** Removes a link. Works from either direction, since the pair is one row. */
export function removeLink(
  store: OpenStore,
  firstInput: string,
  secondInput: string,
): { a: string; b: string } {
  const [a, b] = resolvePair(store, firstInput, secondInput);

  const changes = writeTx(
    store.db,
    () => store.db.prepare("DELETE FROM links WHERE a_id = ? AND b_id = ?").run(a, b).changes,
  );

  if (changes === 0) {
    throw new KatraException({
      code: "not_found",
      message: `${a} and ${b} are not linked`,
      id: b,
    });
  }

  return { a, b };
}

/**
 * Every task linked to `id`, from either side.
 *
 * One row serves both directions, so this looks in both columns and returns
 * whichever end is not the task being asked about.
 */
export function listLinks(store: OpenStore, id: string): TaskSummary[] {
  return (
    store.db
      .prepare(
        `SELECT t.id AS id, t.title AS title, t.level AS level, t.lane AS lane
           FROM links l
           JOIN tasks t ON t.id = CASE WHEN l.a_id = ? THEN l.b_id ELSE l.a_id END
          WHERE l.a_id = ? OR l.b_id = ?
          ORDER BY t.priority, t.created_at, t.rowid`,
      )
      .all(id, id, id) as Array<{ id: string; title: string; level: string; lane: string }>
  ).map((row) => ({
    id: row.id,
    title: row.title,
    level: narrowLevel(row.level),
    lane: narrowLane(row.lane),
  }));
}
