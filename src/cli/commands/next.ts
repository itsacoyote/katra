/**
 * `katra next` — hand back the one task to work on.
 */

import type { Command } from "commander";
import { narrowKind, narrowLevel } from "../../core/narrow.js";
import type { NextFilters, NextResult } from "../../core/tasks/next.js";
import { NEXT_LANE, nextTask } from "../../core/tasks/next.js";
import { requireEpicId } from "../../core/tasks/repo.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

function formatNext(result: NextResult): string {
  if (result.status === "found") {
    const lines = [
      `${result.task.id}  P${result.task.priority}  ${result.task.title}`,
      `  lane      ${result.task.lane}`,
      `  kind      ${result.task.kind}`,
      "  blockers  none",
    ];
    if (result.epic !== null) lines.push(`  epic      ${result.epic.id}  ${result.epic.title}`);
    return lines.join("\n");
  }

  // Three answers hide behind "nothing to do", and the reply has to say which.
  // Left as a bare "nothing is in the Planned lane", the middle case is a dead
  // end: `add` puts work in `Defined`, so a caller who has just filled a store
  // is told about a lane they have never heard of and given no way forward.
  if (result.blocked.length === 0) {
    if (result.untriaged === 0) {
      return `nothing is in the ${NEXT_LANE} lane, and there is no unfinished work elsewhere`;
    }
    const count =
      result.untriaged === 1 ? "1 unfinished task is" : `${result.untriaged} unfinished tasks are`;
    return (
      `nothing is in the ${NEXT_LANE} lane — ${count} waiting to be planned.\n` +
      `  see them with \`katra list --ready\`, then plan one with ` +
      `\`katra update <id> --lane ${NEXT_LANE}\``
    );
  }

  // Naming the blockers turns "nothing to do" into "clear this first".
  return [
    `no ${NEXT_LANE} task is ready — ${result.blocked.length} blocked:`,
    ...result.blocked.flatMap((task) => [
      `  ${task.id}  ${task.title}`,
      ...task.blockers.map(
        (blocker) => `    waits on ${blocker.id}  ${blocker.lane}  ${blocker.title}`,
      ),
    ]),
  ].join("\n");
}

export function registerNext(program: Command, context: CliContext): void {
  program
    .command("next")
    .description("the highest-priority task that can be started right now")
    .option("--kind <kind>", "only tasks of this kind")
    .option("--level <level>", "epic or task")
    .option("--epic <id>", "only children of this epic; accepts a partial id")
    .option("--json", "emit structured output")
    .action((options: { kind?: string; level?: string; epic?: string; json?: boolean }) => {
      const base: NextFilters = {
        ...(options.kind === undefined ? {} : { kind: narrowKind(options.kind) }),
        ...(options.level === undefined ? {} : { level: narrowLevel(options.level) }),
      };

      const { result, warnings } = withStore(context, (store) =>
        nextTask(store, {
          ...base,
          ...(options.epic === undefined ? {} : { epic: requireEpicId(store, options.epic) }),
        }),
      );

      // Always exit 0, including when nothing is ready (ADR-006). Nothing
      // failed: `next` was asked a question, looked, and the answer was
      // "nothing yet". Exit 1 would mean "refused, do not retry" (ADR-005),
      // when closing a blocker makes the identical command return a task. The
      // distinction lives in the payload — `status` separates found from none,
      // and `blocked` separates "everything is stuck" from "the backlog is
      // empty", which is the whole reason NextResult is a union.
      emit(result, { json: options.json === true, warnings, streams: context.streams }, formatNext);
    });
}
