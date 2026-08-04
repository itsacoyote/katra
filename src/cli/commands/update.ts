/**
 * `katra update` — change a task's mutable fields.
 */

import type { Command } from "commander";
import { narrowKind, narrowLane, narrowPriority } from "../../core/narrow.js";
import { showTask } from "../../core/tasks/repo.js";
import type { TaskPatch } from "../../core/tasks/update.js";
import { updateTask } from "../../core/tasks/update.js";
import { readBody } from "../body.js";
import { formatTaskDetail } from "../format.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

interface UpdateOptions {
  readonly title?: string;
  readonly lane?: string;
  readonly kind?: string;
  readonly priority?: string;
  readonly assignee?: string;
  readonly parent?: string;
  readonly clearParent?: boolean;
  readonly clearAssignee?: boolean;
  readonly bodyFile?: string;
  readonly addTag?: string[];
  readonly removeTag?: string[];
  readonly json?: boolean;
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

export function registerUpdate(program: Command, context: CliContext): void {
  program
    .command("update")
    .argument("<id>", "full or partial task id")
    .description("change a task's fields")
    .option("--title <title>", "new title")
    .option("--lane <lane>", "move to a lane; use close or cancel to finish or abandon")
    .option("--kind <kind>", "new kind")
    .option("--priority <n>", "new priority, 0 to 4")
    .option("--assignee <who>", "assign to someone")
    .option("--clear-assignee", "remove the assignee")
    .option("--parent <id>", "move under this epic; accepts a partial id")
    .option("--clear-parent", "detach from its epic")
    .option("--body-file <path>", "replace the description from a file, or pipe it on stdin")
    .option("--add-tag <tag>", "add a tag; repeatable", collect)
    .option("--remove-tag <tag>", "remove a tag; repeatable", collect)
    .option("--json", "emit structured output")
    .action((id: string, options: UpdateOptions) => {
      const description = readBody({
        bodyFile: options.bodyFile,
        cwd: context.cwd,
        readStdin: context.readStdin,
      });

      const patch: TaskPatch = {
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.lane === undefined ? {} : { lane: narrowLane(options.lane) }),
        ...(options.kind === undefined ? {} : { kind: narrowKind(options.kind) }),
        ...(options.priority === undefined ? {} : { priority: narrowPriority(options.priority) }),
        ...(options.clearAssignee === true
          ? { assignee: null }
          : options.assignee === undefined
            ? {}
            : { assignee: options.assignee }),
        ...(options.clearParent === true
          ? { parentId: null }
          : options.parent === undefined
            ? {}
            : { parentId: options.parent }),
        ...(description === undefined ? {} : { description }),
        ...(options.addTag === undefined ? {} : { addTags: options.addTag }),
        ...(options.removeTag === undefined ? {} : { removeTags: options.removeTag }),
      };

      const { result, warnings } = withStore(context, (store) => {
        updateTask(store, id, patch);
        // Re-read through showTask so the output names the epic rather than
        // only its id, exactly as `show` does.
        return showTask(store, id);
      });

      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        formatTaskDetail,
      );
    });
}
