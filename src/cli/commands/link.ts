/**
 * `katra link` — associate two tasks without implying an order.
 */

import type { Command } from "commander";
import { addLink, removeLink } from "../../core/graph/links.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

/** What `link` reports. This type is the `--json` contract. */
export interface LinkResult {
  readonly action: "linked" | "unlinked";
  readonly a: string;
  readonly b: string;
}

function formatLink(result: LinkResult): string {
  return result.action === "linked"
    ? `${result.a} and ${result.b} are linked`
    : `${result.a} and ${result.b} are no longer linked`;
}

export function registerLink(program: Command, context: CliContext): void {
  program
    .command("link")
    .argument("<a>", "one task; accepts a partial id")
    .argument("<b>", "the other task; accepts a partial id")
    .description("associate two tasks; carries no blocking meaning")
    .option("--remove", "remove the link instead of adding it")
    .option("--json", "emit structured output")
    .action((a: string, b: string, options: { remove?: boolean; json?: boolean }) => {
      const action = options.remove === true ? "unlinked" : "linked";

      const { result, warnings } = withStore(context, (store) => {
        const pair = action === "linked" ? addLink(store, a, b) : removeLink(store, a, b);
        return { action, ...pair } satisfies LinkResult;
      });

      emit(result, { json: options.json === true, warnings, streams: context.streams }, formatLink);
    });
}
