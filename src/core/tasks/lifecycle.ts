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
 * release is the non-obvious consequence, so every transition here reports it
 * — and `reopen` reports the inverse, since reviving a blocker takes work away
 * from whoever was about to start it.
 */

import { settleClaim } from "../claims/repo.js";
import type { LifecycleResult } from "../contract.js";
import { writeTx } from "../db/connection.js";
import type { EventType, Lane } from "../enums.js";
import { isTerminal } from "../enums.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import type { OpenStore } from "../store.js";
import { requireId } from "./ids.js";
import { getTask } from "./repo.js";
import type { Task } from "./types.js";
import { reportReadinessChange } from "./unblocked.js";

export type { LifecycleResult };

/** The lane `reopen` returns a task to unless told otherwise. */
export const REOPEN_DEFAULT_LANE: Lane = "Defined";

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
  /**
   * Which of the three verbs this is.
   *
   * One call site serves close, cancel and reopen, and the stream distinguishes
   * them — so the verb has to travel with the move rather than being inferred
   * from the target lane. Inferring would collapse `reopen` into whichever lane
   * it happened to return the task to.
   */
  readonly event: EventType;
  /**
   * Whether this move settles a live claim as a side effect.
   *
   * `close` and `cancel` carry `true` — both are terminal, and a claim on a
   * task no one can work on anymore is stale by construction (spec req 5).
   * `reopen` carries `false`: reviving a task is not a takeover, and a claim
   * that happened to survive onto a terminal task (unreachable through
   * `claimTask`'s own guard, but not through direct seeding — see
   * `claims/repo.ts`) is left exactly as it was. Named on `Move` rather than
   * inferred from `event`, so the coupling to `releasesClaim` is stated once
   * here instead of re-derived at each of the three call sites.
   */
  readonly releasesClaim: boolean;
}

/**
 * Applies a lane transition and reports what it released or re-blocked.
 *
 * **The task is loaded and guarded inside the transaction**, not before it.
 * `BEGIN IMMEDIATE` protects the write; it does not protect the decision to
 * write. Guarding outside leaves a window in which another worktree closes the
 * task between the check and the update — the loser's transition is then
 * silently reverted, and two racing `close`/`cancel` calls both pass a
 * refuse-if-terminal guard that was supposed to let exactly one through.
 *
 * The before-and-after readiness comparison shares that transaction too, so the
 * reported sets are exactly what this change caused rather than what a
 * concurrent writer happened to change alongside it.
 *
 * **A claimed task's release rides the same transaction** (`settleClaim`,
 * `claims/repo.ts`) rather than a call out to `releaseTask`: that function
 * opens its own `writeTx`, and calling it from in here would either resolve
 * identity under the write lock or split one logical change across two
 * transactions — exactly the atomicity spec req 5 forbids. `settleClaim`
 * exists precisely to be the shared core without either hazard.
 */
function transition(
  store: OpenStore,
  idInput: string,
  plan: (task: Task) => Move,
): LifecycleResult {
  const id = requireId(store, idInput);
  // Before the transaction: resolving identity spawns git subprocesses, and
  // doing that under `BEGIN IMMEDIATE` holds the write lock across them. Both
  // halves are resolved unconditionally — including on `reopen`, which never
  // uses `worktree` — because `store.identity()` is memoised per store
  // (`actor.ts`) and `store.actor()` already forces the same resolution, so
  // this costs no extra spawn; keeping every path uniform beats a conditional
  // that only some callers exercise.
  const actor = store.actor();
  const worktree = store.identity().worktree;

  return writeTx(store.db, (now) => {
    const task = loadOrThrow(store, id, idInput);
    const { lane, markClosed, reason, event, releasesClaim } = plan(task);

    const { result, unblocked, reblocked } = reportReadinessChange(store, id, () => {
      store.db
        .prepare(
          "UPDATE tasks SET lane = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?",
        )
        .run(lane, markClosed ? now : null, reason, now, id);
      return loadOrThrow(store, id, idInput);
    });

    if (releasesClaim) {
      settleClaim(store, id, actor, worktree, now);
    }

    // Both lanes travel on the event as well as the verb. `closed` already
    // implies the destination, but not where the task came from — and "what
    // was it doing before someone finished it" is a question the stream should
    // answer without a second lookup.
    appendEvent(
      store,
      {
        type: event,
        entityId: id,
        epicId: epicIdFor(task),
        actor,
        fromLane: task.lane,
        toLane: lane,
        reason,
      },
      now,
    );

    return { task: result, unblocked, reblocked };
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
    return {
      lane: "Done",
      markClosed: true,
      reason: reason ?? null,
      event: "closed",
      releasesClaim: true,
    };
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
    return {
      lane: "Cancelled",
      markClosed: true,
      reason: reason ?? null,
      event: "cancelled",
      releasesClaim: true,
    };
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
    // No reason: `reopenTask` has no reason parameter and never had one —
    // reopening is not a judgement that needs explaining. Adding one here
    // would be scope this feature does not have.
    return {
      lane: target,
      markClosed: false,
      reason: null,
      event: "reopened",
      // Reviving a task is not a takeover — see `Move.releasesClaim`.
      releasesClaim: false,
    };
  });
}
