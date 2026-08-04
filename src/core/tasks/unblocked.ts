/**
 * "What did that release?" — computed once, for every transition that can
 * release something.
 *
 * `close`, `cancel` and `delete` all make a blocker stop blocking, and all
 * three owe the caller the same answer: which dependents can now start. Written
 * out per command it was twenty identical lines in two files, which is two
 * places for the rule to drift apart.
 *
 * The before-and-after readiness comparison must run **inside the caller's
 * transaction**, so the reported set is exactly what this change caused rather
 * than what a concurrent writer happened to change alongside it.
 */

import { KatraException } from "../errors.js";
import { isReady, listDependents } from "../graph/deps.js";
import type { OpenStore } from "../store.js";
import { getTask } from "./repo.js";
import type { TaskSummary } from "./types.js";
import { summarise } from "./types.js";

export interface Released<T> {
  /** Whatever `mutate` returned. */
  readonly result: T;
  /** Tasks that were blocked before `mutate` ran and are ready after it. */
  readonly unblocked: readonly TaskSummary[];
}

/**
 * Runs `mutate` and reports which of `id`'s dependents it released.
 *
 * Only dependents that were **already blocked** are considered, so a task that
 * was ready all along is never reported as newly unblocked.
 *
 * Call this inside a `writeTx`; it does not open one itself, because the
 * caller's guard reads have to sit in the same transaction as the write.
 */
export function reportUnblocked<T>(store: OpenStore, id: string, mutate: () => T): Released<T> {
  const wasBlocked = listDependents(store, id).filter((dependent) => !isReady(store, dependent.id));

  const result = mutate();

  const unblocked = wasBlocked
    .filter((dependent) => isReady(store, dependent.id))
    .map((dependent) => {
      const full = getTask(store, dependent.id);
      if (full === undefined) {
        // Inside the transaction this row provably exists — it was read a
        // moment ago and nothing here deletes it. Fabricating a placeholder
        // task, as this used to, would hide a real storage fault behind
        // plausible-looking output.
        throw new KatraException({
          code: "not_found",
          message: `dependent ${dependent.id} disappeared inside the transaction`,
          id: dependent.id,
        });
      }
      return summarise(full);
    });

  return { result, unblocked };
}
