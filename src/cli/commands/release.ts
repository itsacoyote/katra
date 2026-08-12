/**
 * `katra release` — gives back a claim on a task.
 */

import type { Command } from "commander";
import type { ReleaseResult } from "../../core/claims/repo.js";
import { releaseTask } from "../../core/claims/repo.js";
import { oneLine } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

export type { ReleaseResult };

/** Echoes who held the claim that was just released. */
function formatRelease(result: ReleaseResult): string {
  const { task, claim } = result;
  return `${task.id} released — was held by ${oneLine(claim.actor)}`;
}

export function registerRelease(program: Command, context: CliContext): void {
  program
    .command("release")
    .argument("<id>", "the task to release; accepts a partial id")
    .description("release a task's claim")
    .option("--force", "release even when held by another worktree")
    .option("--json", "emit structured output")
    .action((id: string, options: { force?: boolean; json?: boolean }) => {
      const { result, warnings } = withStore(context, (store) =>
        releaseTask(store, id, { force: options.force === true }),
      );

      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatRelease,
      );
    });
}
