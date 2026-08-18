/**
 * Opening the store for a command, and always closing it again.
 *
 * Every command past `init` needs the same three things: open the store,
 * surface any warnings from locating it, and release the handle even when the
 * command throws. A lingering read snapshot stops WAL checkpointing until
 * every connection closes, so the `finally` is load-bearing.
 *
 * **`withStoreAsync`** is `withStore`'s async twin (F8 T5's `refresh`, the
 * first command whose own body needs to `await` — a provider's `resolve`).
 * `withStore` itself stays synchronous and untouched: every other command
 * still opens, runs, and closes the store without ever crossing an `await`,
 * and there is no reason to make that path pay for one. `withStoreAsync`
 * exists instead of widening `withStore` to accept either kind of callback,
 * because the one line that makes it correct — `await fn(store)` **inside**
 * the `try`, not `return fn(store)` — is exactly the line a caller who mixed
 * the two signatures could omit and still have the code type-check.
 *
 * **The trap this function's whole existence is about:** `try { return {
 * result: fn(store), warnings }; } finally { store.close(); }`, run against
 * an `async fn`, type-checks today and dies at runtime. `fn(store)` returns a
 * `Promise` immediately without suspending this function; the `try` block's
 * synchronous `return` statement runs right away, and `finally`'s
 * `store.close()` executes on its heels — before `fn`'s own body has reached
 * its first `await`, let alone finished. Every statement `fn` runs after that
 * first `await` then executes against an already-closed handle. `await
 * fn(store)` inside the `try` is what makes `finally` wait for the whole
 * callback, awaits included, before the handle closes — the named test in
 * `test/cli/with-store.test.ts` pins exactly this: a callback that touches
 * the store again after an `await` must see it still open.
 */

import type { StoreWarning } from "../core/db/locate.js";
import type { OpenStore, OpenStoreResult } from "../core/store.js";
import { openStore } from "../core/store.js";
import type { CliContext } from "./program.js";

export interface StoreOutcome<T> {
  readonly result: T;
  readonly warnings: readonly StoreWarning[];
}

/**
 * `openStore`, called the one way both siblings below need it — the
 * context's own resolvers, not fresh ones: both are memoised per invocation,
 * so a command that opens the store and writes several events resolves the
 * actor and the identity each exactly once — and `actor` itself is fused
 * from this same `identity`, so passing both never spawns git twice for the
 * same worktree-and-branch pair.
 */
function openContextStore(context: CliContext): OpenStoreResult {
  return openStore(context.cwd, {
    env: context.env,
    actor: context.actor,
    identity: context.identity,
  });
}

/** Runs `fn` against the repository's store. */
export function withStore<T>(context: CliContext, fn: (store: OpenStore) => T): StoreOutcome<T> {
  const { store, warnings } = openContextStore(context);
  try {
    return { result: fn(store), warnings };
  } finally {
    store.close();
  }
}

/** Runs `fn` against the repository's store, awaiting it before closing. See this module's docs for why this is not `withStore` with a wider parameter type. */
export async function withStoreAsync<T>(
  context: CliContext,
  fn: (store: OpenStore) => Promise<T>,
): Promise<StoreOutcome<T>> {
  const { store, warnings } = openContextStore(context);
  try {
    const result = await fn(store);
    return { result, warnings };
  } finally {
    store.close();
  }
}
