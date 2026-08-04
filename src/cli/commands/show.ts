/**
 * `katra show` — one task in full.
 */

import type { Command } from "commander";
import { showTask } from "../../core/tasks/repo.js";
import { formatTaskDetail } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

export function registerShow(program: Command, context: CliContext): void {
  program
    .command("show")
    .argument("<id>", "full or partial task id")
    .description("show one task in full")
    .option("--json", "emit structured output")
    .action((id: string, options: { json?: boolean }) => {
      const { result, warnings } = withStore(context, (store) => showTask(store, id));

      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatTaskDetail,
      );
    });
}
