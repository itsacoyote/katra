/**
 * `katra delete` — remove a task permanently.
 */

import type { Command } from "commander";
import { KatraException } from "../../core/errors.js";
import type { DeleteResult } from "../../core/tasks/delete.js";
import { deleteTask } from "../../core/tasks/delete.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

function formatDelete(result: DeleteResult): string {
  const lines = [`deleted ${result.id}  ${result.title}`];
  if (result.unblocked.length > 0) {
    lines.push(`  unblocked ${result.unblocked.length}:`);
    for (const task of result.unblocked) lines.push(`    ${task.id}  ${task.title}`);
  }
  return lines.join("\n");
}

export function registerDelete(program: Command, context: CliContext): void {
  program
    .command("delete")
    .argument("<id>", "full or partial task id")
    .description("remove a task permanently; prefer cancel for work that was real")
    .option("--force", "confirm the deletion; required, because it cannot be undone")
    .option("--json", "emit structured output")
    .action((id: string, options: { force?: boolean; json?: boolean }) => {
      // A flag rather than a prompt. katra's primary caller is a
      // non-interactive agent, and reading from a TTY would hang its turn
      // rather than ask it anything.
      if (options.force !== true) {
        throw new KatraException({
          code: "usage",
          message:
            `deleting ${id} cannot be undone in this version — pass --force to confirm. ` +
            "If the work was real but is not being done, `katra cancel` keeps the record.",
        });
      }

      const { result, warnings } = withStore(context, (store) => deleteTask(store, id));

      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatDelete,
      );
    });
}
