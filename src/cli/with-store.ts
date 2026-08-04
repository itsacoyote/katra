/**
 * Opening the store for a command, and always closing it again.
 *
 * Every command past `init` needs the same three things: open the store,
 * surface any warnings from locating it, and release the handle even when the
 * command throws. A lingering read snapshot stops WAL checkpointing until
 * every connection closes, so the `finally` is load-bearing.
 */

import type { StoreWarning } from "../core/db/locate.js";
import type { OpenStore } from "../core/store.js";
import { openStore } from "../core/store.js";
import type { CliContext } from "./program.js";

export interface StoreOutcome<T> {
  readonly result: T;
  readonly warnings: readonly StoreWarning[];
}

/** Runs `fn` against the repository's store. */
export function withStore<T>(context: CliContext, fn: (store: OpenStore) => T): StoreOutcome<T> {
  const { store, warnings } = openStore(context.cwd, { env: context.env });
  try {
    return { result: fn(store), warnings };
  } finally {
    store.close();
  }
}
