/**
 * `katra log` — what has happened, newest first.
 */

import type { Command } from "commander";
import type { EventLog } from "../../core/contract.js";
import { listEvents, requireEntityId } from "../../core/events/repo.js";
import { narrowCount } from "../../core/narrow.js";
import { formatEventLog } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

interface LogOptions {
  readonly limit?: string;
  readonly json?: boolean;
}

export function registerLog(program: Command, context: CliContext): void {
  program
    .command("log")
    // Optional: with an id it is that entity's history, and an epic's includes
    // its children's. Without one it is the whole store. There is no `--all`
    // flag, for the reason `--epic` was dropped from the spec — it would be a
    // second spelling of a read that already has one.
    .argument("[id]", "an entity, or omit for the whole store; accepts a partial id")
    .description("show recorded history, newest first")
    .option("--limit <n>", "show at most this many events")
    .option("--json", "emit structured output")
    .action((id: string | undefined, options: LogOptions) => {
      const limit = options.limit === undefined ? undefined : narrowCount(options.limit, "limit");

      const { result, warnings } = withStore(context, (store) =>
        listEvents(store, {
          // requireEntityId, not requireId: the headline case for reading
          // history is a task that no longer exists, and `requireId` searches
          // `tasks` — so `log <deletedId>` would have refused the one thing
          // only the event stream can answer.
          ...(id === undefined ? {} : { entityId: requireEntityId(store, id) }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );

      const document: EventLog = { events: result };
      emit(document, { json: options.json === true, warnings, streams: context.streams }, (value) =>
        formatEventLog(value.events),
      );
    });
}
