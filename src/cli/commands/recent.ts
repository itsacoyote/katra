/**
 * `katra recent` — recently-touched items, activity-sorted (spec §6c).
 */

import type { Command } from "commander";
import type { RecentOptions } from "../../core/activity.js";
import { readRecent } from "../../core/activity.js";
import type { RecentResult } from "../../core/contract.js";
import { narrowCount } from "../../core/narrow.js";
import { formatRecent } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

export function registerRecent(program: Command, context: CliContext): void {
  program
    .command("recent")
    .description("entities with the most recent activity, newest first")
    .option("--limit <n>", "return at most this many, newest first")
    .option("--json", "emit structured output")
    .action((options: { limit?: string; json?: boolean }) => {
      // `narrowCount`, not a fresh parser (board.ts's precedent): it already
      // refuses a limit above MAX_COUNT, and a negative one, with a refusal
      // rather than letting the over-fetch-by-one math downstream misbehave.
      const base: RecentOptions = {
        ...(options.limit === undefined ? {} : { limit: narrowCount(options.limit, "limit") }),
      };

      const { result, warnings } = withStore(context, (store) => readRecent(store, base));

      const document: RecentResult = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatRecent,
      );
    });
}
