/**
 * Changing a task's mutable fields.
 *
 * In its own module rather than alongside creation: the two are edited by
 * different work at different times, and sharing a file guarantees a conflict
 * when they are worked in parallel — which is katra's own normal mode.
 */

import { writeTx } from "../db/connection.js";
import type { Kind, Lane, Priority } from "../enums.js";
import { isTerminal } from "../enums.js";
import { KatraException } from "../errors.js";
import type { OpenStore } from "../store.js";
import { requireId } from "./ids.js";
import { getTask, requireEpicId } from "./repo.js";
import type { Task } from "./types.js";

/** The fields `update` can change. Anything omitted is left alone. */
export interface TaskPatch {
  readonly title?: string;
  readonly description?: string | null;
  readonly lane?: Lane;
  readonly priority?: Priority;
  readonly kind?: Kind;
  readonly assignee?: string | null;
  /** A new parent epic, or null to detach from the current one. */
  readonly parentId?: string | null;
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
}

/**
 * Applies a patch and returns the updated task.
 *
 * **A terminal lane cannot be set here.** `close` and `cancel` own those
 * transitions because they do more than move the lane: they record `closed_at`,
 * and `cancel` records a reason and reports what it released. Allowing
 * `update --lane Done` would produce a task that is terminal for readiness —
 * silently unblocking its dependents — with none of that recorded. The
 * database enforces the `closed_at` half regardless; this is the half that
 * explains itself.
 *
 * Reparenting never changes the id (ADR-001), so a reference written into a
 * commit message stays valid.
 */
export function updateTask(store: OpenStore, idInput: string, patch: TaskPatch): Task {
  const id = requireId(store, idInput);

  if (patch.lane !== undefined && isTerminal(patch.lane)) {
    throw new KatraException({
      code: "validation",
      message:
        `update cannot move a task to ${patch.lane} — use \`katra close\` to finish it ` +
        "or `katra cancel` to abandon it, so the reason and the tasks it unblocks are recorded",
      field: "lane",
      value: patch.lane,
    });
  }

  return writeTx(store.db, (now) => {
    // Loaded and guarded inside the transaction. Outside it, another worktree
    // could close the task between this check and the UPDATE below, and the
    // write — which never touches closed_at — would leave an active lane
    // carrying a close timestamp while silently reverting the close.
    const existing = getTask(store, id);
    if (existing === undefined) {
      throw new KatraException({ code: "not_found", message: `no task matches "${idInput}"`, id });
    }

    // A task already in a terminal lane has to come back through `reopen`, which
    // clears closed_at; editing it in place would leave the two disagreeing.
    if (isTerminal(existing.lane) && patch.lane !== undefined) {
      throw new KatraException({
        code: "conflict",
        message: `${id} is ${existing.lane} — use \`katra reopen\` before changing its lane`,
        reason: `lane is ${existing.lane}`,
      });
    }

    const parentId =
      patch.parentId === undefined || patch.parentId === null
        ? patch.parentId
        : requireEpicId(store, patch.parentId);

    const assignments: string[] = [];
    const params: unknown[] = [];

    // Column names are literals written here; values are always bound.
    const set = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title === "") {
        throw new KatraException({
          code: "validation",
          message: "a task needs a title",
          field: "title",
          value: patch.title,
        });
      }
      set("title", title);
    }
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.lane !== undefined) {
      set("lane", patch.lane);
      // Guaranteed non-terminal by the check above, so the close columns cannot
      // be left behind pointing at a lane that no longer means "finished".
      // Structural rather than argued: the schema enforces terminal ⇒ closed_at,
      // never the converse, so nothing else would catch it.
      set("closed_at", null);
      set("close_reason", null);
    }
    if (patch.priority !== undefined) set("priority", patch.priority);
    if (patch.kind !== undefined) set("kind", patch.kind);
    if (patch.assignee !== undefined) set("assignee", patch.assignee);
    if (parentId !== undefined) set("parent_id", parentId);

    if (assignments.length > 0) {
      set("updated_at", now);
      store.db
        .prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...params, id);
    }

    if (patch.removeTags !== undefined && patch.removeTags.length > 0) {
      const remove = store.db.prepare("DELETE FROM tags WHERE task_id = ? AND tag = ?");
      for (const tag of patch.removeTags) remove.run(id, tag.trim());
    }
    if (patch.addTags !== undefined && patch.addTags.length > 0) {
      const addTag = store.db.prepare("INSERT OR IGNORE INTO tags (task_id, tag) VALUES (?,?)");
      for (const tag of patch.addTags) {
        const trimmed = tag.trim();
        if (trimmed !== "") addTag.run(id, trimmed);
      }
    }

    const updated = getTask(store, id);
    if (updated === undefined) {
      throw new KatraException({ code: "not_found", message: `task ${id} vanished`, id });
    }
    return updated;
  });
}
