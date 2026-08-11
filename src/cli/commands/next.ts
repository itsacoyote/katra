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

  // Up to three answers hide behind "nothing to do", and they are not
  // mutually exclusive — a backlog can be blocked *and* claimed at once, so
  // each fact that applies gets its own section rather than one branch
  // winning and silencing the rest (iteration-3 addendum).
  //
  // `contended` reshapes the blocked/untriaged leads themselves — not just
  // whether a claimed section is appended — because both of their unqualified
  // forms assert something false the moment a claim is in play: "no Planned
  // task is ready" reads as if none exists, when one does and is merely held
  // elsewhere, and "nothing is in the Planned lane" is the literal ADR-012
  // violation this exists to prevent.
  const contended = result.claimedElsewhere > 0;
  const sections: string[] = [];

  if (result.blocked.length > 0) {
    // Naming the blockers turns "nothing to do" into "clear this first".
    const scope = contended ? `unclaimed ${NEXT_LANE}` : NEXT_LANE;
    sections.push(
      [
        `no ${scope} task is ready — ${result.blocked.length} blocked:`,
        ...result.blocked.flatMap((task) => [
          `  ${task.id}  ${task.title}`,
          ...task.blockers.map(
            (blocker) => `    waits on ${blocker.id}  ${blocker.lane}  ${blocker.title}`,
          ),
        ]),
      ].join("\n"),
    );
  } else if (result.untriaged > 0) {
    // The middle case used to be a dead end: `add` puts work in `Defined`, so
    // a caller who has just filled a store was told about a lane they had
    // never heard of and given no way forward.
    const count =
      result.untriaged === 1 ? "1 unfinished task is" : `${result.untriaged} unfinished tasks are`;
    const lead = contended
      ? `${count} waiting to be planned.`
      : `nothing is in the ${NEXT_LANE} lane — ${count} waiting to be planned.`;
    sections.push(
      `${lead}\n` +
        `  see them with \`katra list --ready\`, then plan one with ` +
        `\`katra update <id> --lane ${NEXT_LANE}\``,
    );
  }

  if (contended) {
    const count =
      result.claimedElsewhere === 1
        ? "1 ready task is"
        : `${result.claimedElsewhere} ready tasks are`;
    sections.push(
      `${count} claimed by another worktree — pick different work, or ` +
        `\`katra release <id> --force\` to take one over`,
    );
  }

  // Genuinely nothing: no blocked work, nothing untriaged, nothing claimed.
  // A length check rather than a third condition mirroring the two above —
  // this is the one case none of them fired, not a fourth fact of its own.
  if (sections.length === 0) {
    sections.push(`nothing is in the ${NEXT_LANE} lane, and there is no unfinished work elsewhere`);
  }

  return sections.join("\n\n");
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
