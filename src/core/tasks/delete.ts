/**
 * Removing a task permanently.
 *
 * Deletion is for work that should never have existed — a typo, a duplicate, a
 * misfile. Work that was real but is not being done belongs in `Cancelled`,
 * where the record of having considered it survives.
 *
 * In F1 this is **irreversible**: there is no restore until snapshots arrive.
 */

import type { DeleteResult } from "../contract.js";
import { writeTx } from "../db/connection.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import type { OpenStore } from "../store.js";
import { requireId } from "./ids.js";
import { getTask } from "./repo.js";
import { reportUnblocked } from "./unblocked.js";

export type { DeleteResult };

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
  // Before the transaction: see `actor.ts` — resolving it spawns two git
  // subprocesses, which must not happen with the write lock held.
  const actor = store.actor();

  return writeTx(store.db, (now) => {
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

    // The last thing that happens to a task, so its history ends with an
    // explanation rather than trailing off (ADR-008).
    //
    // Everything the event needs was read *before* the DELETE. Nothing here can
    // be looked up now: the row is gone, so `epicIdFor` would find no parent
    // and the title would be unrecoverable — which is exactly why the title is
    // stamped onto the event and why `appendEvent` takes `epicId` rather than
    // resolving it.
    appendEvent(
      store,
      {
        type: "deleted",
        entityId: id,
        epicId: epicIdFor(task),
        actor,
        title: task.title,
      },
      now,
    );

    return { id, title: task.title, unblocked };
  });
}
