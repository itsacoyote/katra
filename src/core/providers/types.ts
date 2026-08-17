/**
 * The provider seam — spec §7's `Provider` interface, exactly as ADR-015
 * narrows it (a compiled-in registry of two implementations, `github.ts` and
 * `linear.ts`, not discovered plugins) and as iter-3 HIGH-2 widens it: `env`
 * is an explicit parameter on `resolve`, never read from `process.env` by a
 * provider itself. The CLI resolves `options.env ?? process.env` once, at
 * its own boundary (`core/git.ts`'s module doc makes the identical promise
 * for `findGh`/`runGh`), and `refresh` (T5) threads the result down through
 * here. `test/core/providers.test.ts` pins this structurally: neither
 * `github.ts` nor `linear.ts` may reference `process.env` anywhere in its
 * source.
 *
 * Pure module — no `better-sqlite3`, no store import — the same discipline
 * `core/refs/types.ts` documents for its own shapes: `Ref` (imported below)
 * is itself store-free, so importing it here does not drag the database
 * handle into this package.
 *
 * **No write/push/update method exists on {@link Provider}, by construction**
 * (spec §7, ADR-015): one-directional is enforced by the shape a provider
 * can implement, not by a convention an implementation could violate.
 */

import type { RefreshReason } from "../enums.js";
import type { Ref } from "../refs/types.js";

/**
 * What {@link Provider.resolve} hands back — a discriminated union on
 * `resolved`, the same shape family as `core/git.ts`'s `GhResult` (`ok`) and
 * `core/refs/parse.ts`'s `ParseRefResult` (`recognized`): a consumer narrows
 * without a cast, and cannot read `status`/`title` on the failure arm or
 * `reason` on the success arm by mistake.
 *
 * The `resolved: true` arm carries exactly `{status, title}` — no `state`,
 * no `url`, unlike spec §7's prose shape: F8's actual write seam
 * (`core/refs/types.ts`'s `RefreshOutcome`) only ever consumes those two
 * fields, and this arm is deliberately kept structurally **wider** than
 * `RefreshOutcome`, never narrower — a `resolved: true` value passes
 * straight through to `applyRefreshWithin` as its `outcome` argument with no
 * cast, since TypeScript's excess-property check only fires on a fresh
 * object literal, never on a variable of a wider type.
 *
 * The `resolved: false` arm carries a `RefreshReason` (`core/enums.ts`,
 * imported, never re-declared here) — the closed vocabulary every provider
 * degrades to instead of throwing (epic requirement 1: "a provider can
 * never throw into refresh — every failure becomes `unresolved {reason}`").
 */
export type ProviderResult =
  | { readonly resolved: true; readonly status: string; readonly title: string | null }
  | { readonly resolved: false; readonly reason: RefreshReason };

/**
 * One external tracker katra can read from — read-only by construction: no
 * `write`/`push`/`update` method exists on this type, so an implementation
 * cannot write back to the tracker it reads no matter what its own body
 * does.
 */
export interface Provider {
  /** A short, stable name (`"github"` / `"linear"`) — for the registry and diagnostics, never used for `ref.provider` matching (that is {@link match}'s job). */
  readonly name: string;
  /** True when this provider is the one that can resolve `ref`, checked against `ref.provider` — never assumed from which provider happened to be asked. */
  match(ref: Ref): boolean;
  /**
   * Resolves `ref` to its current external status and title, or the reason
   * it could not. Never throws: every failure a provider can produce —
   * missing credentials, a network error, a shape it does not recognize —
   * becomes the `resolved: false` arm instead of a rejected promise.
   */
  resolve(ref: Ref, env: NodeJS.ProcessEnv): Promise<ProviderResult>;
}
