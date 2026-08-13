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
import { assertNotReadOnly, writeTx } from "../db/connection.js";
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

/**
 * What a transition decides to do, once it has seen the task's current state.
 *
 * Exported so a caller of {@link applyMoveWithin} — the F5 loader chief among
 * them — can build one directly, without going through `plan`'s task-shaped
 * closures.
 */
export interface Move {
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
}

/**
 * The row-mutation core of `transition`: applies one `Move` to a task's lane,
 * stamping the caller's time rather than `writeTx`'s own clock.
 *
 * **Must be called inside an open transaction** — see `appendEvent`'s guard
 * (`events/repo.ts`), which this mirrors. Stamps `updated_at = updatedAt ??
 * at`, and `closed_at = at` when the move closes, clearing it on reopen —
 * exactly the SQL `transition` always ran. **Does none of the rest of
 * `transition`'s work**: no readiness comparison, no claim settlement, no
 * event. Those three stay outside so the F5 loader — which calls this
 * directly, with historical times, for every close/cancel/reopen it replays —
 * controls them explicitly rather than inheriting a live-store side effect a
 * fresh, claim-free store during load has no business triggering. `transition`
 * is the only caller during ordinary use: it wraps this in
 * `reportReadinessChange`'s mutate callback, then settles any claim and
 * appends the lifecycle event itself.
 */
export function applyMoveWithin(
  store: OpenStore,
  taskId: string,
  move: Move,
  ctx: { readonly at: string; readonly updatedAt?: string },
): void {
  if (!store.db.inTransaction) {
    throw new KatraException({
      code: "internal",
      message:
        "applyMoveWithin must be called inside an open transaction — a lane " +
        "change that commits on its own can outlive the change it's part of",
    });
  }
  assertNotReadOnly(store.db, "applyMoveWithin");

  const updatedAt = ctx.updatedAt ?? ctx.at;

  store.db
    .prepare(
      "UPDATE tasks SET lane = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?",
    )
    .run(move.lane, move.markClosed ? ctx.at : null, move.reason, updatedAt, taskId);
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
  // uses `worktree` — because `openStore` already resolved and memoised the
  // worktree itself, in `bumpPresence` (`presence.ts`), before this ever
  // runs: every store pays that spawn once at open time, so reading it again
  // here costs nothing, whether or not this store's `actor` was supplied
  // independently of `identity`.
  const actor = store.actor();
  const worktree = store.identity().worktree;

  return writeTx(store.db, (now) => {
    const task = loadOrThrow(store, id, idInput);
    const move = plan(task);

    const { result, unblocked, reblocked } = reportReadinessChange(store, id, () => {
      applyMoveWithin(store, id, move, { at: now });
      return loadOrThrow(store, id, idInput);
    });

    // Only close and cancel settle a live claim — both are terminal, and a
    // claim on a task no one can work on anymore is stale by construction
    // (spec req 5). `markClosed` already draws exactly that line: `reopen` is
    // the one move that leaves it `false`, since reviving a task is not a
    // takeover.
    if (move.markClosed) {
      settleClaim(store, task, actor, worktree, now);
    }

    // Both lanes travel on the event as well as the verb. `closed` already
    // implies the destination, but not where the task came from — and "what
    // was it doing before someone finished it" is a question the stream should
    // answer without a second lookup.
    appendEvent(
      store,
      {
        type: move.event,
        entityId: id,
        epicId: epicIdFor(task),
        actor,
        fromLane: task.lane,
        toLane: move.lane,
        reason: move.reason,
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
    return { lane: "Done", markClosed: true, reason: reason ?? null, event: "closed" };
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
    return { lane: "Cancelled", markClosed: true, reason: reason ?? null, event: "cancelled" };
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
    return { lane: target, markClosed: false, reason: null, event: "reopened" };
  });
}
