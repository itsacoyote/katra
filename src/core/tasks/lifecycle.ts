/**
 * The three transitions that end a task's life, and the one that undoes them.
 *
 * katra distinguishes **finished** from **abandoned** on purpose (ADR-003).
 * Recording dropped work as `Done` makes "what did we actually complete?"
 * unanswerable, and deleting it destroys the record that the approach was
 * considered — which is exactly the context that stops a later session
 * re-proposing it.
 *
 * Both are terminal, so both release whatever they were blocking. That
 * release is the non-obvious consequence, so every transition here reports it.
 */

import { writeTx } from "../db/connection.js";
import type { Lane } from "../enums.js";
import { isTerminal } from "../enums.js";
import { KatraException } from "../errors.js";
import type { OpenStore } from "../store.js";
import { requireId } from "./ids.js";
import { getTask } from "./repo.js";
import type { Task, TaskSummary } from "./types.js";
import { reportUnblocked } from "./unblocked.js";

/** The lane `reopen` returns a task to unless told otherwise. */
export const REOPEN_DEFAULT_LANE: Lane = "Defined";

export interface LifecycleResult {
  readonly task: Task;
  /**
   * Tasks that became ready because of this transition.
   *
   * Reported rather than left to be discovered: releasing dependents is the
   * consequence a reader is least likely to predict, and for `cancel` it is
   * the whole reason the lane exists.
   */
  readonly unblocked: readonly TaskSummary[];
}

function loadOrThrow(store: OpenStore, id: string, idInput: string): Task {
  const task = getTask(store, id);
  if (task === undefined) {
    throw new KatraException({ code: "not_found", message: `no task matches "${idInput}"`, id });
  }
  return task;
}

/** What a transition decides to do, once it has seen the task's current state. */
interface Move {
  readonly lane: Lane;
  readonly markClosed: boolean;
  readonly reason: string | null;
}

/**
 * Applies a lane transition and reports which dependents it released.
 *
 * **The task is loaded and guarded inside the transaction**, not before it.
 * `BEGIN IMMEDIATE` protects the write; it does not protect the decision to
 * write. Guarding outside leaves a window in which another worktree closes the
 * task between the check and the update — the loser's transition is then
 * silently reverted, and two racing `close`/`cancel` calls both pass a
 * refuse-if-terminal guard that was supposed to let exactly one through.
 *
 * The before-and-after readiness comparison shares that transaction too, so the
 * reported set is exactly what this change caused rather than what a concurrent
 * writer happened to change alongside it.
 */
function transition(
  store: OpenStore,
  idInput: string,
  plan: (task: Task) => Move,
): LifecycleResult {
  const id = requireId(store, idInput);

  return writeTx(store.db, (now) => {
    const task = loadOrThrow(store, id, idInput);
    const { lane, markClosed, reason } = plan(task);

    const { result, unblocked } = reportUnblocked(store, id, () => {
      store.db
        .prepare(
          "UPDATE tasks SET lane = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?",
        )
        .run(lane, markClosed ? now : null, reason, now, id);
      return loadOrThrow(store, id, idInput);
    });

    return { task: result, unblocked };
  });
}

function refuseIfTerminal(task: Task, verb: string): void {
  if (isTerminal(task.lane)) {
    throw new KatraException({
      code: "conflict",
      message: `${task.id} is already ${task.lane} — reopen it before you ${verb} it`,
      reason: `lane is ${task.lane}`,
    });
  }
}

/** Marks work finished. */
export function closeTask(store: OpenStore, idInput: string, reason?: string): LifecycleResult {
  return transition(store, idInput, (task) => {
    refuseIfTerminal(task, "close");
    return { lane: "Done", markClosed: true, reason: reason ?? null };
  });
}

/**
 * Marks work abandoned.
 *
 * The reason is optional but is the point of the lane: without it the record
 * says only that something was dropped, not why — and "why" is what stops the
 * same approach being proposed again.
 */
export function cancelTask(store: OpenStore, idInput: string, reason?: string): LifecycleResult {
  return transition(store, idInput, (task) => {
    refuseIfTerminal(task, "cancel");
    return { lane: "Cancelled", markClosed: true, reason: reason ?? null };
  });
}

/**
 * Returns a finished or abandoned task to active work.
 *
 * Defaults to `Defined` rather than "some non-terminal lane": the latter is
 * satisfied by all five, which makes it untestable and leaves the caller
 * guessing.
 */
export function reopenTask(store: OpenStore, idInput: string, lane?: Lane): LifecycleResult {
  // Argument validation, so it fails before a write lock is taken. It depends
  // on nothing the database holds; the state guard below does, and lives
  // inside the transaction.
  const target = lane ?? REOPEN_DEFAULT_LANE;
  if (isTerminal(target)) {
    // Otherwise reopen becomes a second path into a terminal lane, bypassing
    // close and cancel exactly as `update --lane Done` would have.
    throw new KatraException({
      code: "validation",
      message:
        `reopen cannot move a task to ${target} — it returns work to an active lane. ` +
        "Use `katra close` or `katra cancel` to end it again.",
      field: "lane",
      value: target,
    });
  }

  return transition(store, idInput, (task) => {
    if (!isTerminal(task.lane)) {
      throw new KatraException({
        code: "conflict",
        message: `${task.id} is ${task.lane}, which is already active — nothing to reopen`,
        reason: `lane is ${task.lane}`,
      });
    }
    return { lane: target, markClosed: false, reason: null };
  });
}
