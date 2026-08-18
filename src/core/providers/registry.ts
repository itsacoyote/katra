/**
 * The compiled-in provider registry (ADR-015) — exactly two providers,
 * GitHub and Linear, enumerated once. No PATH scanning, no module loading,
 * no subprocess discovery protocol: "which providers exist" is answerable
 * by reading this one file.
 */

import type { Ref } from "../refs/types.js";
import { githubProvider } from "./github.js";
import { linearProvider } from "./linear.js";
import type { Provider } from "./types.js";

/** Every provider katra ships. `providerFor` is the only intended consumer — a caller iterating this directly should have a reason `providerFor` doesn't already cover. */
export const PROVIDERS: readonly Provider[] = [githubProvider, linearProvider];

/**
 * The provider that claims `ref`, or `undefined` when none does — the
 * escape-hatch case (`--provider jira ...`, ADR-014): a ref stored under a
 * provider name katra does not ship reports `refresh`'s own `no-provider`
 * reason (T5's job, not this function's — `providerFor` only answers "which
 * one, if any", never invents a reason for "none").
 */
export function providerFor(ref: Ref): Provider | undefined {
  return PROVIDERS.find((provider) => provider.match(ref));
}
