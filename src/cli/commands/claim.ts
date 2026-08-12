/**
 * `katra claim` — records that this worktree is working a task.
 */

import type { Command } from "commander";
import type { ClaimResult } from "../../core/claims/repo.js";
import { claimTask } from "../../core/claims/repo.js";
import { oneLine } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

export type { ClaimResult };

/**
 * Echoes the claim, whether it was just taken or already held by this
 * worktree — `claimTask` treats re-claiming as an idempotent no-op (T4), so
 * the two cases share one rendering rather than one having to guess which
 * happened from the outside.
 */
function formatClaim(result: ClaimResult): string {
  const { task, claim } = result;
  return `${task.id} claimed by ${oneLine(claim.actor)}`;
}

export function registerClaim(program: Command, context: CliContext): void {
  program
    .command("claim")
    .argument("<id>", "the task to claim; accepts a partial id")
    .description("claim a task for this worktree")
    .option("--json", "emit structured output")
    .action((id: string, options: { json?: boolean }) => {
      const { result, warnings } = withStore(context, (store) => claimTask(store, id));

      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatClaim,
      );
    });
}
