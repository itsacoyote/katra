/**
 * The compiled-in default reconcile policy (epic requirement 1, ADR-016).
 *
 * ADR-016's whole point: the policy is **data**, injected into
 * `planReconcile` as a parameter, never a `switch` or an `if` chain baked
 * into the engine. `DEFAULT_POLICY` is one value of that shape, not a
 * special case the engine knows about — `planReconcile`'s own tests prove
 * an entirely different table (a non-default policy) changes the verdicts,
 * which would not be true of a hardcoded branch.
 *
 * Pure module — no `better-sqlite3`, no store import — see `types.ts`'s
 * module doc for the full discipline this file shares with it.
 */

import type { PolicyTable } from "./types.js";

/**
 * `github` `merged` -> `Done`; `linear` `completed` -> `Done`; `linear`
 * `canceled` -> `Cancelled` (epic requirement 1). Every other
 * `(provider, status)` pair is absent, which {@link PolicyTable}'s own docs
 * read as unmapped — deliberately, not an oversight:
 *
 * - GitHub `closed` has no entry (epic Non-goals): the cached vocabulary
 *   cannot distinguish issue-closed-as-completed from PR-closed-without-merge,
 *   and mapping it would risk closing a task whose PR was abandoned, not
 *   shipped.
 * - Linear `started` has no entry (epic Non-goals, decision katra-9aw.5):
 *   mirroring a non-terminal status would drag in claim interaction and skip
 *   katra's own Researching/Planned workflow.
 * - No `unstarted`/`backlog`/`duplicate` entry for either provider: none of
 *   Linear's remaining `WorkflowStateType` values name a completion.
 */
export const DEFAULT_POLICY: PolicyTable = {
  github: {
    merged: "Done",
  },
  linear: {
    completed: "Done",
    canceled: "Cancelled",
  },
};
