/**
 * A minimal, fully-defaulted `Ref` for tests that only care about a few
 * fields.
 *
 * Extracted (F9 T2 efficiency review) from `test/core/providers.test.ts`,
 * where it was byte-identical to `test/core/reconcile.test.ts`'s own local
 * copy — two files independently defaulting the same five-field shape is
 * exactly the kind of duplication a shared helper exists to close, the same
 * reasoning `test/helpers/seed.ts`'s module doc gives for its own factories.
 */

import type { Ref } from "../../src/core/refs/types.js";

/** Defaults every field but `provider`/`externalId` to the "never refreshed, no url" shape — override whatever a specific test needs. */
export function buildRef(overrides: Partial<Ref> & Pick<Ref, "provider" | "externalId">): Ref {
  return {
    url: null,
    cachedStatus: null,
    cachedTitle: null,
    syncedAt: null,
    ...overrides,
  };
}
