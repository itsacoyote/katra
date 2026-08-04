/**
 * Removing a task permanently.
 *
 * Deletion is for work that should never have existed — a typo, a duplicate, a
 * misfile. Work that was real but is not being done belongs in `Cancelled`,
 * where the record of having considered it survives.
 *
 * In F1 this is **irreversible**: there is no restore until snapshots arrive.
 */

import { writeTx } from "../db/connection.js";
import { KatraException } from "../errors.js";
import type { OpenStore } from "../store.js";
import { requireId } from "./ids.js";
import { getTask } from "./repo.js";
import type { TaskSummary } from "./types.js";
import { reportUnblocked } from "./unblocked.js";

export interface DeleteResult {
  readonly id: string;
  readonly title: string;
  /**
   * Tasks that became ready because this one is gone.
   *
   * `ON DELETE CASCADE` removes the dependency rows, which silently makes
   * dependents startable — the same consequence `cancel` reports, and just as
   * easy to miss.
   */
  readonly unblocked: readonly TaskSummary[];
}

function countChildren(store: OpenStore, id: string): number {
  return (
    store.db.prepare("SELECT COUNT(*) c FROM tasks WHERE parent_id = ?").get(id) as { c: number }
  ).c;
}

/**
 * Deletes a task and reports what its removal released.
 *
 * An epic with children is refused. The database guarantees this through
 * `ON DELETE RESTRICT`, so it holds even against raw SQL; the check here
 * exists to say *how many* children are in the way rather than surfacing a
 * constraint error. Note the violation arrives as
 * `SQLITE_CONSTRAINT_TRIGGER`, not `SQLITE_CONSTRAINT_FOREIGNKEY`, because
 * SQLite implements foreign-key actions through an internal trigger.
 *
 * The child count is read **inside the transaction**. Counted before it, a
 * concurrent `add --parent` could slip a child in between the count and the
 * delete; the database would still refuse, but as a raw constraint error
 * instead of the message that names how many children are in the way.
 */
export function deleteTask(store: OpenStore, idInput: string): DeleteResult {
  const id = requireId(store, idInput);

  return writeTx(store.db, () => {
    const task = getTask(store, id);
    if (task === undefined) {
      throw new KatraException({ code: "not_found", message: `no task matches "${idInput}"`, id });
    }

    const children = countChildren(store, id);
    if (children > 0) {
      throw new KatraException({
        code: "conflict",
        message:
          `${id} is an epic with ${children} ${children === 1 ? "child" : "children"} — ` +
          "reparent or delete them first, or cancel the epic instead of deleting it",
        reason: `${children} children`,
      });
    }

    const { unblocked } = reportUnblocked(store, id, () => {
      store.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    });

    return { id, title: task.title, unblocked };
  });
}
