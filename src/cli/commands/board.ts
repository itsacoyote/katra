/**
 * `katra board` — where the repository stands, right now.
 *
 * Takes no filters and never will (ADR-009). `--limit` bounds the sections; it
 * does not select them. Narrower questions are `list`'s and `log`'s, and both
 * already answer them.
 */

import type { Command } from "commander";
import { readBoard } from "../../core/board.js";
import type { BoardResult } from "../../core/contract.js";
import { narrowCount } from "../../core/narrow.js";
import { formatBoard } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

export function registerBoard(program: Command, context: CliContext): void {
  program
    .command("board")
    .description("what is in flight, ready, blocked, and what just moved")
    .option("--digest", "lead with the store's newest handoff note")
    .option("--limit <n>", "rows per section (the counts are unaffected)")
    .option("--json", "emit structured output")
    .action((options: { digest?: boolean; limit?: string; json?: boolean }) => {
      // `narrowCount`, not a fresh parser: it already refuses a limit above
      // MAX_COUNT with a refusal rather than letting better-sqlite3 choke, and
      // `--limit 0` reaches the query as a real zero.
      const limit = options.limit === undefined ? undefined : narrowCount(options.limit, "limit");

      // The digest is read inside `readBoard`'s snapshot, not spliced on after
      // it. Its `taskLane` exists to stop a finished task's handoff reading as
      // live work, and a lane from a different snapshot than the sections above
      // it would be exactly the inconsistency `readTx` exists to prevent.
      const { result, warnings } = withStore(context, (store) =>
        readBoard(store, {
          ...(limit === undefined ? {} : { limit }),
          ...(options.digest === true ? { digest: true } : {}),
        }),
      );

      // Annotated, so the shape the CLI prints and the type the package
      // publishes cannot drift apart without a compile error.
      const document: BoardResult = result;
      emit(
        document,
        { json: options.json === true, warnings, streams: context.streams },
        formatBoard,
      );
    });
}
