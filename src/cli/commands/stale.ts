/**
 * `katra stale` — open items with no recent activity (spec §6c).
 */

import type { Command } from "commander";
import type { StaleOptions } from "../../core/activity.js";
import { readStale } from "../../core/activity.js";
import { nowIso } from "../../core/clock.js";
import type { StaleResult } from "../../core/contract.js";
import { narrowCount, narrowWhen } from "../../core/narrow.js";
import { formatStale } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

/**
 * `--older-than`'s default when the flag is omitted — spec-pinned at two
 * weeks (spec §6c, epic requirement 8). Named rather than inlined so the
 * spec-pinned value has exactly one spelling.
 */
const STALE_DEFAULT_WINDOW = "2w";

export function registerStale(program: Command, context: CliContext): void {
  program
    .command("stale")
    .description("open items whose last activity is older than the window (default: 2w)")
    .option("--older-than <when>", "how long counts as stale; 2w, 3d, 12h, 30m or ISO")
    .option("--limit <n>", "return at most this many, most-forgotten first")
    .option("--json", "emit structured output")
    .action((options: { olderThan?: string; limit?: string; json?: boolean }) => {
      const now = nowIso();
      const olderThan = narrowWhen(options.olderThan ?? STALE_DEFAULT_WINDOW, "--older-than", now);

      const base: StaleOptions = {
        olderThan,
        ...(options.limit === undefined ? {} : { limit: narrowCount(options.limit, "limit") }),
      };

      const { result, warnings } = withStore(context, (store) => readStale(store, base));

      const document: StaleResult = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatStale,
      );
    });
}
