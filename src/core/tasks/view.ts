/**
 * The composed read `show` prints: a task, its notes, and what has happened to
 * it.
 *
 * A module of its own rather than an addition to `repo.ts`, for two reasons:
 *
 * - **It would be an import cycle.** `notes/repo.ts` already imports `getTask`
 *   from `tasks/repo.ts`, so reaching back the other way would make the two
 *   mutually dependent. Sitting above both, this module imports freely and
 *   neither of them changes.
 * - **`update` should not pay for it.** `showTaskWithin` is what `update`
 *   returns from inside its transaction; adding two more queries there would
 *   charge every field edit for notes it never displays, and a bulk update by
 *   the number of tasks it touched.
 *
 * Dependencies are the deliberate exception to that second rule: `blockers`
 * and `blocking` live on {@link TaskDetail} and so *are* read by `update`.
 * They earn it — "what does this change unblock" is the question a lane move
 * raises, and `close` and `cancel` already report their released dependents
 * for the same reason. Notes and activity raise no such question, which is why
 * they stop here.
 */

import { listEvents } from "../events/repo.js";
import { listNotes } from "../notes/repo.js";
import type { OpenStore } from "../store.js";
import { requireId } from "./ids.js";
import { showTaskWithin } from "./repo.js";
import type { TaskView } from "./types.js";

/**
 * How many notes `show` inlines.
 *
 * Bounded here rather than by a `--limit` flag: `show` is a compact summary of
 * one task, and `--limit` belongs to the commands whose job is listing. A
 * long-lived task accumulates notes without bound, so an unbounded `show`
 * turns into a dump precisely on the tasks most worth summarising.
 *
 * `katra note list <id>` is the unbounded read, and it prints whole bodies.
 */
export const SHOW_NOTE_LIMIT = 5;

/**
 * How many events `show` inlines.
 *
 * Larger than the note cap because an event is one line and a note is a
 * paragraph. `katra log <id>` is the unbounded read.
 */
export const SHOW_ACTIVITY_LIMIT = 8;

/** The full read behind `katra show`. */
export function viewTask(store: OpenStore, idInput: string): TaskView {
  const id = requireId(store, idInput);
  return {
    ...showTaskWithin(store, id),
    notes: listNotes(store, { taskId: id, limit: SHOW_NOTE_LIMIT }),
    // Scoped to the entity, so an epic's view also carries its children's
    // activity — the same query `log <epicId>` runs.
    activity: listEvents(store, { entityId: id, limit: SHOW_ACTIVITY_LIMIT }).events,
  };
}
