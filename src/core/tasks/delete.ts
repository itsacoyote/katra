/**
 * Removing a task permanently.
 *
 * Deletion is for work that should never have existed — a typo, a duplicate, a
 * misfile. Work that was real but is not being done belongs in `Cancelled`,
 * where the record of having considered it survives.
 *
 * In F1 this is **irreversible**: there is no restore until snapshots arrive.
 *
 * Deleting a task also GCs its now-orphaned external refs (F7, epic risk note
 * 16): the task's `task_refs` rows cascade away with it (migration 0005's
 * `ON DELETE CASCADE`), and any `refs` row that cascade leaves with no other
 * holder is removed via `gcOrphanRefsWithin` — the same `refs/repo.ts` helper
 * `unlinkRef` uses — inside this same transaction. Deliberately **no**
 * `ref-unlinked` event is appended for that GC: `ref-unlinked` records an
 * explicit, deliberate removal (`ref remove`), while a ref disappearing
 * because its last holder task was deleted is a side effect of the delete —
 * bookkeeping, not history. The task's own `deleted` event already explains
 * why the ref is gone; a second event would just restate the cascade.
 */

import { settleClaim } from "../claims/repo.js";
import type { DeleteResult } from "../contract.js";
import { writeTx } from "../db/connection.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import { gcOrphanRefsWithin } from "../refs/repo.js";
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
 * The internal `refs.id` rowids linked to `id`, read via `task_refs`.
 *
 * Must be called **before** the cascading `DELETE FROM tasks` below: that
 * delete takes `task_refs`'s rows for `id` with it (migration 0005's
 * `ON DELETE CASCADE`), so this is the only chance to learn which `refs` rows
 * might now be orphaned. Once the cascade fires, the list is unrecoverable.
 */
function taskRefIds(store: OpenStore, id: string): number[] {
  return (
    store.db.prepare("SELECT ref_id FROM task_refs WHERE task_id = ?").all(id) as Array<{
      ref_id: number;
    }>
  ).map((row) => row.ref_id);
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
 *
 * **A live claim is settled before the cascade fires** (`settleClaim`,
 * `claims/repo.ts`), inside this same transaction — the row still exists to
 * stamp `epicId` onto the `released` event, and the deletion that follows
 * would otherwise take the claim row with it via `ON DELETE CASCADE`
 * (migration 0003) with no event ever recording it (ADR-008 symmetry: a
 * released claim should read the same whether a lifecycle transition or a
 * delete caused it).
 */
export function deleteTask(store: OpenStore, idInput: string): DeleteResult {
  const id = requireId(store, idInput);
  // Before the transaction: see `actor.ts` — resolving identity spawns git
  // subprocesses, which must not happen with the write lock held.
  const actor = store.actor();
  const worktree = store.identity().worktree;

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

    settleClaim(store, task, actor, worktree, now);

    // Read before the cascade — see `taskRefIds`'s own docs for why this
    // cannot move any later.
    const refIds = taskRefIds(store, id);

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

    // Orphan GC rides this same transaction — no separate `writeTx`, and no
    // `ref-unlinked` event (module doc: GC is bookkeeping, not history).
    gcOrphanRefsWithin(store, refIds);

    return { id, title: task.title, unblocked };
  });
}
