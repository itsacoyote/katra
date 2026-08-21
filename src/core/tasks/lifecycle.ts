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

import { claimFor, settleClaim } from "../claims/repo.js";
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

/**
 * Widens `transition`/`closeTask`/`cancelTask` for a caller that is not an
 * ordinary interactive command — F9's `reconcile`, the first and so far only
 * one. Both fields are optional and, omitted, leave every default-path
 * behavior byte-identical to before this existed (F9 T1 acceptance
 * criterion): no existing test needed to change, and the `refuseIfClaimedElsewhere`
 * read below never runs unless a caller explicitly asks for it.
 *
 * **Not accepted by `reopenTask`.** Reviving a blocker is never something
 * `reconcile`'s forward-only policy engine does (ADR-016), and reopen has no
 * claim to settle in the first place — widening it would be surface with no
 * caller.
 */
export interface LifecycleOverrides {
  /**
   * Stamps the lifecycle event (and, on a settled self-claim, the
   * `released` event) with this actor instead of resolving `store.actor()`.
   * `store.actor()` is a live git spawn; when this is given, it is never
   * called at all — not merely overridden after the fact.
   */
  readonly actor?: string;
  /**
   * When `true`, refuses the transition — inside the same transaction that
   * would otherwise write it — if the task is currently claimed by a
   * worktree other than the one this store resolves to. Checked with
   * `claimFor` inside `writeTx`, never before it: guarding outside the
   * transaction leaves the identical check-then-write window `transition`'s
   * own docs already warn about for the terminal-lane guard, just for a
   * claim instead of a lane. No claim, or a claim held by this store's own
   * worktree, proceeds normally — a self-held claim still settles on close
   * exactly as it does today.
   */
  readonly refuseIfClaimedElsewhere?: boolean;
}

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
 * Module-private: nothing outside `transition`'s own three callers
 * (`closeTask`/`cancelTask`/`reopenTask`) needs the full shape — a direct
 * caller of {@link applyMoveWithin} only needs {@link LaneChange}, below.
 */
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
}

/**
 * The three fields {@link applyMoveWithin} actually reads off a `Move` —
 * never `event`, which exists purely for `transition`'s own `appendEvent`
 * call after `applyMoveWithin` returns. Exported so a direct caller of
 * `applyMoveWithin` — the F5 loader chief among them — can build one without
 * going through `transition`'s task-shaped `plan` closures or fabricating an
 * `event` value it has no use for.
 */
export type LaneChange = Pick<Move, "lane" | "markClosed" | "reason">;

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
 *
 * Takes {@link LaneChange} — `lane`, `markClosed`, `reason`, never `event` —
 * since `applyMoveWithin` has no use for the verb; that one exists purely for
 * `transition`'s own `appendEvent` call after this returns. `transition`'s
 * own hand-built `Move` stays structurally compatible with the narrower
 * `LaneChange` shape without a cast — only the excess-property check on an
 * object *literal* would object, and `transition` passes a `Move`-typed
 * variable.
 *
 * Three guards a hand-built `LaneChange` from a direct caller — the F5
 * loader chief among them — cannot skip: one that marks a task closed but
 * targets a non-terminal lane would write `closed_at` onto a task the
 * schema's own `CHECK` still calls active; the converse — targeting a
 * terminal lane without marking closed — would leave that same `CHECK`
 * refusing the row for the opposite reason (a terminal lane demands a
 * `closed_at`, and only `markClosed` ever supplies one), so it is refused
 * here too, as a typed `internal` rather than a raw `CHECK`-constraint dump
 * the caller would have to decode; and `taskId` naming nothing would
 * otherwise commit a no-op `UPDATE` silently rather than telling the caller
 * its id was wrong.
 */
export function applyMoveWithin(
  store: OpenStore,
  taskId: string,
  move: LaneChange,
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

  if (move.markClosed && !isTerminal(move.lane)) {
    throw new KatraException({
      code: "internal",
      message: `applyMoveWithin: a Move that marks closed must target a terminal lane, not ${move.lane}`,
    });
  }
  if (!move.markClosed && isTerminal(move.lane)) {
    throw new KatraException({
      code: "internal",
      message: `applyMoveWithin: a Move targeting terminal lane ${move.lane} must markClosed — the row would otherwise carry a terminal lane with no closed_at`,
    });
  }

  const updatedAt = ctx.updatedAt ?? ctx.at;

  const info = store.db
    .prepare(
      "UPDATE tasks SET lane = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?",
    )
    .run(move.lane, move.markClosed ? ctx.at : null, move.reason, updatedAt, taskId);

  if (info.changes === 0) {
    throw new KatraException({
      code: "not_found",
      message: `no task matches "${taskId}"`,
      id: taskId,
    });
  }
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
 *
 * **`overrides` (F9 T1) widens this seam rather than forking it** — the
 * reconcile policy engine (F9) cannot produce a state a manual `close`/
 * `cancel` could not, because it is calling the identical function. Omitted,
 * every default-path caller (every command that existed before F9) sees
 * byte-identical behavior: `overrides?.actor ?? store.actor()` only skips the
 * git spawn when an override is actually given, and the
 * `refuseIfClaimedElsewhere` guard below is reached only when that flag is
 * `true`, so the ordinary path pays no extra query for a feature it never
 * asked for.
 */
function transition(
  store: OpenStore,
  idInput: string,
  plan: (task: Task) => Move,
  overrides?: LifecycleOverrides,
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
  const actor = overrides?.actor ?? store.actor();
  const worktree = store.identity().worktree;

  return writeTx(store.db, (now) => {
    const task = loadOrThrow(store, id, idInput);

    // Inside the transaction, before any write — the same
    // loaded-and-guarded-inside-the-tx discipline this function's own docs
    // state for the terminal-lane guard below, applied to a claim instead of
    // a lane. Gated behind the flag: an ordinary close/cancel with no
    // overrides never reaches `claimFor` here at all.
    if (overrides?.refuseIfClaimedElsewhere === true) {
      const claim = claimFor(store, id);
      if (claim !== null && claim.holder !== worktree) {
        throw new KatraException({
          code: "claimed_elsewhere",
          message: `${id} is claimed by ${claim.holder} — refusing to change it from here`,
          holder: claim.holder,
        });
      }
    }

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

/** Marks work finished. See {@link LifecycleOverrides} for the optional `overrides` parameter (F9's `reconcile`; omitted, behavior is unchanged). */
export function closeTask(
  store: OpenStore,
  idInput: string,
  reason?: string,
  overrides?: LifecycleOverrides,
): LifecycleResult {
  return transition(
    store,
    idInput,
    (task) => {
      refuseIfTerminal(task, "close");
      return { lane: "Done", markClosed: true, reason: reason ?? null, event: "closed" };
    },
    overrides,
  );
}

/**
 * Marks work abandoned.
 *
 * The reason is optional but is the point of the lane: without it the record
 * says only that something was dropped, not why — and "why" is what stops the
 * same approach being proposed again.
 *
 * See {@link LifecycleOverrides} for the optional `overrides` parameter
 * (F9's `reconcile`; omitted, behavior is unchanged).
 */
export function cancelTask(
  store: OpenStore,
  idInput: string,
  reason?: string,
  overrides?: LifecycleOverrides,
): LifecycleResult {
  return transition(
    store,
    idInput,
    (task) => {
      refuseIfTerminal(task, "cancel");
      return { lane: "Cancelled", markClosed: true, reason: reason ?? null, event: "cancelled" };
    },
    overrides,
  );
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
  // inside the transaction. Not a rule every write path follows uniformly —
  // `createTaskWithin`/`createNoteWithin` validate under the lock instead,
  // deliberately, and say why in their own docs.
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
