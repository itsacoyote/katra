/**
 * `katra close`, `katra cancel` and `katra reopen`.
 *
 * Three commands from one module because they are one decision seen from
 * different sides: how a task ends, and how it comes back.
 */

import type { Command } from "commander";
import { narrowLane } from "../../core/narrow.js";
import type { LifecycleResult } from "../../core/tasks/lifecycle.js";
import { cancelTask, closeTask, reopenTask } from "../../core/tasks/lifecycle.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

function formatLifecycle(result: LifecycleResult): string {
  const lines = [`${result.task.id} is now ${result.task.lane}`];
  if (result.task.closeReason !== null) lines.push(`  reason  ${result.task.closeReason}`);

  // Releasing dependents is the consequence a reader is least likely to
  // predict, so it is stated rather than left to be noticed later.
  if (result.unblocked.length > 0) {
    lines.push(`  unblocked ${result.unblocked.length}:`);
    for (const task of result.unblocked) lines.push(`    ${task.id}  ${task.title}`);
  }
  // And the inverse, which `reopen` alone can cause: reviving a blocker takes
  // work away from whoever was about to start it.
  if (result.reblocked.length > 0) {
    lines.push(`  blocked again ${result.reblocked.length}:`);
    for (const task of result.reblocked) lines.push(`    ${task.id}  ${task.title}`);
  }
  return lines.join("\n");
}

export function registerLifecycle(program: Command, context: CliContext): void {
  program
    .command("close")
    .argument("<id>", "full or partial task id")
    .description("mark work finished")
    .option("--reason <why>", "note why, for the record")
    .option("--json", "emit structured output")
    .action((id: string, options: { reason?: string; json?: boolean }) => {
      const { result, warnings } = withStore(context, (store) =>
        closeTask(store, id, options.reason),
      );
      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatLifecycle,
      );
    });

  program
    .command("cancel")
    .argument("<id>", "full or partial task id")
    .description("abandon work without pretending it was finished")
    .option("--reason <why>", "why it was dropped; the point of the lane")
    .option("--json", "emit structured output")
    .action((id: string, options: { reason?: string; json?: boolean }) => {
      const { result, warnings } = withStore(context, (store) =>
        cancelTask(store, id, options.reason),
      );
      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatLifecycle,
      );
    });

  program
    .command("reopen")
    .argument("<id>", "full or partial task id")
    .description("return finished or abandoned work to an active lane")
    .option("--lane <lane>", "which active lane to return it to (default: Defined)")
    .option("--json", "emit structured output")
    .action((id: string, options: { lane?: string; json?: boolean }) => {
      const lane = options.lane === undefined ? undefined : narrowLane(options.lane);
      const { result, warnings } = withStore(context, (store) => reopenTask(store, id, lane));
      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatLifecycle,
      );
    });
}
