/**
 * "What did that release, and what did it take away?" — computed once, for
 * every transition that can change a dependent's readiness.
 *
 * `close`, `cancel` and `delete` all make a blocker stop blocking, and all
 * three owe the caller the same answer: which dependents can now start.
 * `reopen` does the exact inverse and owes the same courtesy — an agent that
 * revives a blocker has just taken work away from whoever was about to pick it
 * up. Written out per command it was twenty identical lines in two files, which
 * is two places for the rule to drift apart.
 *
 * The before-and-after readiness comparison must run **inside the caller's
 * transaction**, so the reported sets are exactly what this change caused
 * rather than what a concurrent writer happened to change alongside it.
 */

import { KatraException } from "../errors.js";
import { isReady, listDependents } from "../graph/deps.js";
import type { OpenStore } from "../store.js";
import { getTask } from "./repo.js";
import type { TaskSummary } from "./types.js";
import { summarise } from "./types.js";

export interface ReadinessChange<T> {
  /** Whatever `mutate` returned. */
  readonly result: T;
  /** Dependents that were blocked before `mutate` ran and are ready after it. */
  readonly unblocked: readonly TaskSummary[];
  /** Dependents that were ready before `mutate` ran and are blocked after it. */
  readonly reblocked: readonly TaskSummary[];
}

function summariseOrThrow(store: OpenStore, id: string): TaskSummary {
  const task = getTask(store, id);
  if (task === undefined) {
    // Inside the transaction this row provably exists — it was read a moment
    // ago and nothing here deletes it. Fabricating a placeholder task, as this
    // used to, would hide a real storage fault behind plausible output.
    throw new KatraException({
      code: "not_found",
      message: `dependent ${id} disappeared inside the transaction`,
      id,
    });
  }
  return summarise(task);
}

/**
 * Runs `mutate` and reports which of `id`'s dependents changed readiness.
 *
 * Both directions are filtered against the *prior* state, so a dependent that
 * was already ready is never reported as newly unblocked and one that was
 * already blocked is never reported as newly re-blocked. That distinction only
 * bites for `delete`, which — unlike the lifecycle transitions — accepts a
 * subject in any lane, including one that had already stopped blocking.
 *
 * Call this inside a `writeTx`; it does not open one itself, because the
 * caller's guard reads have to sit in the same transaction as the write.
 */
export function reportReadinessChange<T>(
  store: OpenStore,
  id: string,
  mutate: () => T,
): ReadinessChange<T> {
  const before = new Map(
    listDependents(store, id).map((dependent) => [dependent.id, isReady(store, dependent.id)]),
  );

  const result = mutate();

  const unblocked: TaskSummary[] = [];
  const reblocked: TaskSummary[] = [];
  for (const [dependentId, wasReady] of before) {
    // Defensive, and currently unreachable: `parent_id` is ON DELETE RESTRICT
    // and the cascades on deps/links/tags remove only their own rows, so no
    // mutation here can take a dependent task with it. Kept because F2 adds
    // more edge kinds, and reporting a task that no longer exists would be a
    // worse failure than skipping it.
    if (getTask(store, dependentId) === undefined) continue;

    const nowReady = isReady(store, dependentId);
    if (nowReady === wasReady) continue;
    (nowReady ? unblocked : reblocked).push(summariseOrThrow(store, dependentId));
  }

  return { result, unblocked, reblocked };
}

/**
 * The release-only half, for callers that can only ever release.
 *
 * `delete` cannot re-block anything: removing a row removes the edges with it.
 */
export function reportUnblocked<T>(
  store: OpenStore,
  id: string,
  mutate: () => T,
): { readonly result: T; readonly unblocked: readonly TaskSummary[] } {
  const { result, unblocked } = reportReadinessChange(store, id, mutate);
  return { result, unblocked };
}
