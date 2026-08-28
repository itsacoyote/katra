/**
 * `katra release` — gives back a claim on a task.
 */

import type { Command } from "commander";
import type { ReleaseMineResult, ReleaseResult } from "../../core/claims/repo.js";
import { releaseMine, releaseTask } from "../../core/claims/repo.js";
import { KatraException } from "../../core/errors.js";
import { oneLine } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

export type { ReleaseMineResult, ReleaseResult };

/** Echoes who held the claim that was just released. */
function formatRelease(result: ReleaseResult): string {
  const { task, claim } = result;
  return `${task.id} released — was held by ${oneLine(claim.actor)}`;
}

/** One line per claim `--mine` released, reusing {@link formatRelease}; "nothing held" on the empty, no-op case. */
function formatReleaseMine(result: ReleaseMineResult): string {
  if (result.released.length === 0) return "nothing held";
  return result.released.map(formatRelease).join("\n");
}

export function registerRelease(program: Command, context: CliContext): void {
  program
    .command("release")
    .argument("[id]", "the task to release; accepts a partial id")
    .description("release a task's claim, or every claim this worktree holds with --mine")
    .option("--mine", "release every claim this worktree holds")
    .option("--force", "release even when held by another worktree")
    .option("--json", "emit structured output")
    .action(
      (id: string | undefined, options: { mine?: boolean; force?: boolean; json?: boolean }) => {
        const emitOptions = { json: options.json === true, streams: context.streams };

        if (options.mine === true) {
          if (id !== undefined) {
            throw new KatraException({
              code: "usage",
              message:
                "release --mine releases every claim this worktree holds — pass an id, or --mine, not both",
            });
          }
          if (options.force === true) {
            throw new KatraException({
              code: "usage",
              message:
                "--mine only ever releases this worktree's own claims — --force has nothing to force",
            });
          }

          const { result, warnings } = withStore(context, (store) => releaseMine(store));
          emit(result, { ...emitOptions, warnings }, formatReleaseMine);
          return;
        }

        if (id === undefined) {
          throw new KatraException({
            code: "usage",
            message:
              "release requires a task id, or --mine to release every claim this worktree holds",
          });
        }

        const { result, warnings } = withStore(context, (store) =>
          releaseTask(store, id, { force: options.force === true }),
        );

        emit(result, { ...emitOptions, warnings }, formatRelease);
      },
    );
}
