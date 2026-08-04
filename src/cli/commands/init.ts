/**
 * `katra init` — bring a store into being.
 *
 * The command only parses, calls, and formats. Creating the directory, opening
 * the connection, running migrations, and deciding created-versus-found all
 * happen in `openStore`.
 */

import type { Command } from "commander";
import type { InitResult } from "../../core/contract.js";
import { openStore } from "../../core/store.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";

export type { InitResult };

function formatInit(result: InitResult): string {
  return result.created
    ? `Created katra store at ${result.path}`
    : `Found existing katra store at ${result.path}`;
}

export function registerInit(program: Command, context: CliContext): void {
  program
    .command("init")
    .description("create the katra store for this repository")
    .option("--json", "emit structured output")
    .action((options: { json?: boolean }) => {
      const { store, created, warnings } = openStore(context.cwd, {
        createIfMissing: true,
        env: context.env,
      });

      try {
        const result: InitResult = { path: store.dbPath, created };
        emit(
          result,
          { json: options.json === true, warnings, streams: context.streams },
          formatInit,
        );
      } finally {
        // Release the handle promptly: a lingering read snapshot stops WAL
        // checkpointing until every connection is closed.
        store.close();
      }
    });
}
