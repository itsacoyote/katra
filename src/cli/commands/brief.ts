/**
 * `katra brief` — one task or epic, in the shape a resuming session needs.
 *
 * A flat command, like `show` and `log`, not the subcommand form `note` uses.
 * `note` has two actions under one noun and Commander 15 will not take them as
 * a single string; `brief` is one verb and has no such problem.
 */

import type { Command } from "commander";
import type { BriefResult } from "../../core/contract.js";
import { briefEntity } from "../../core/tasks/brief.js";
import { formatBrief } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

export function registerBrief(program: Command, context: CliContext): void {
  program
    .command("brief")
    .argument("<id>", "full or partial task or epic id")
    .description("everything needed to resume one task or epic, in one call")
    .option("--full", "lift the caps: the whole handoff, more activity, more children")
    .option("--json", "emit structured output")
    .action((id: string, options: { full?: boolean; json?: boolean }) => {
      const { result, warnings } = withStore(context, (store) =>
        briefEntity(store, id, { full: options.full === true }),
      );

      // Annotated, so the shape the CLI prints and the type the package
      // publishes cannot drift apart without a compile error.
      const document: BriefResult = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatBrief,
      );
    });
}
