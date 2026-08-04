/**
 * `katra dep` — record or remove a blocking relationship.
 */

import type { Command } from "commander";
import type { DependencyResult } from "../../core/contract.js";
import { addDependency, isReady, listBlockers, removeDependency } from "../../core/graph/deps.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

export type { DependencyResult };

function formatDep(result: DependencyResult): string {
  const headline =
    result.action === "added"
      ? `${result.taskId} now depends on ${result.dependsOnId}`
      : `${result.taskId} no longer depends on ${result.dependsOnId}`;

  if (result.ready) return `${headline}\n  ready`;

  return [
    headline,
    `  blocked by ${result.blockers.length}:`,
    ...result.blockers.map((blocker) => `    ${blocker.id}  ${blocker.lane}  ${blocker.title}`),
  ].join("\n");
}

export function registerDep(program: Command, context: CliContext): void {
  program
    .command("dep")
    .argument("<id>", "the task that is blocked; accepts a partial id")
    .requiredOption("--blocked-by <id>", "the task it waits on; accepts a partial id")
    .description("record or remove a dependency between two tasks")
    .option("--remove", "remove the dependency instead of adding it")
    .option("--json", "emit structured output")
    .action((id: string, options: { blockedBy: string; remove?: boolean; json?: boolean }) => {
      const action = options.remove === true ? "removed" : "added";

      const { result, warnings } = withStore(context, (store) => {
        const { taskId, dependsOnId } =
          action === "added"
            ? addDependency(store, id, options.blockedBy)
            : removeDependency(store, id, options.blockedBy);

        return {
          action,
          taskId,
          dependsOnId,
          ready: isReady(store, taskId),
          blockers: listBlockers(store, taskId),
        } satisfies DependencyResult;
      });

      emit(result, { json: options.json === true, warnings, streams: context.streams }, formatDep);
    });
}
