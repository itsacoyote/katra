/**
 * `katra list` — many tasks, filtered.
 */

import type { Command } from "commander";
import { narrowKind, narrowLane, narrowLevel, narrowPriority } from "../../core/narrow.js";
import { requireId } from "../../core/tasks/ids.js";
import { listTasks, type TaskFilters, type TaskList } from "../../core/tasks/repo.js";
import { formatTaskList } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

interface ListOptions {
  readonly lane?: string;
  readonly kind?: string;
  readonly level?: string;
  readonly epic?: string;
  readonly tag?: string;
  readonly assignee?: string;
  readonly priority?: string;
  readonly ready?: boolean;
  readonly blocked?: boolean;
  readonly json?: boolean;
}

export function registerList(program: Command, context: CliContext): void {
  program
    .command("list")
    .description("list tasks, filtered")
    .option("--lane <lane>", "only tasks in this lane")
    .option("--kind <kind>", "only tasks of this kind")
    .option("--level <level>", "epic or task")
    .option("--epic <id>", "only children of this epic; accepts a partial id")
    .option("--tag <tag>", "only tasks carrying this tag")
    .option("--assignee <who>", "only tasks assigned to this person")
    .option("--priority <n>", "only tasks at this priority")
    .option("--ready", "only tasks with no unfinished dependencies")
    .option("--blocked", "only tasks waiting on something")
    .option("--json", "emit structured output")
    .action((options: ListOptions) => {
      // Narrowed at the boundary, so a bad --lane names the lanes rather than
      // silently matching nothing.
      const base: TaskFilters = {
        ...(options.lane === undefined ? {} : { lane: narrowLane(options.lane) }),
        ...(options.kind === undefined ? {} : { kind: narrowKind(options.kind) }),
        ...(options.level === undefined ? {} : { level: narrowLevel(options.level) }),
        ...(options.assignee === undefined ? {} : { assignee: options.assignee }),
        ...(options.priority === undefined ? {} : { priority: narrowPriority(options.priority) }),
        ...(options.tag === undefined ? {} : { tag: options.tag }),
        // --ready and --blocked are the two halves of one filter; passing both
        // asks for everything, which is the same as passing neither.
        ...(options.ready === true && options.blocked !== true
          ? { ready: true }
          : options.blocked === true && options.ready !== true
            ? { ready: false }
            : {}),
      };

      const { result, warnings } = withStore(context, (store) =>
        listTasks(store, {
          ...base,
          ...(options.epic === undefined ? {} : { epic: requireId(store, options.epic) }),
        }),
      );

      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        (list: TaskList) => formatTaskList(list.tasks),
      );
    });
}
