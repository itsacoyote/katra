/**
 * `katra show` — one task in full.
 */

import type { Command } from "commander";
import type { TaskView } from "../../core/tasks/types.js";
import { viewTask } from "../../core/tasks/view.js";
import { formatTaskView } from "../format.js";
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
      const { result, warnings } = withStore(context, (store) => viewTask(store, id));

      // Annotated, so the shape the CLI prints and the type the package
      // publishes cannot drift apart without a compile error.
      const document: TaskView = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatTaskView,
      );
    });
}
