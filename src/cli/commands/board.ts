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
import { latestHandoff } from "../../core/notes/repo.js";
import { BRIEF_HANDOFF_CHARS } from "../../core/tasks/brief.js";
import { capText } from "../../core/text.js";
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

      const { result, warnings } = withStore(context, (store) => {
        const board = readBoard(store, limit === undefined ? {} : { limit });
        if (options.digest !== true) return board;

        // Read outside `readBoard` rather than inside it: the digest is a flag
        // on the command, and threading it through the core assembly would make
        // every board read carry a query most of them do not want. The field is
        // declared on the document either way, so the shape never varies.
        const handoff = latestHandoff(store);
        if (handoff === undefined) return board;

        const capped = capText(handoff.note.body, BRIEF_HANDOFF_CHARS);
        return {
          ...board,
          digest: {
            note: { ...handoff.note, body: capped.text },
            truncated: capped.truncated,
            taskId: handoff.taskId,
            taskTitle: handoff.taskTitle,
            taskLane: handoff.taskLane,
          },
        };
      });

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
