/**
 * `katra add` — create a task or epic.
 *
 * Prints only the new id in text mode, so the output pipes straight into
 * another command.
 */

import type { Command } from "commander";
import { narrowKind, narrowLane, narrowLevel, narrowPriority } from "../../core/narrow.js";
import { createTask } from "../../core/tasks/repo.js";
import type { NewTask, Task } from "../../core/tasks/types.js";
import { readBody } from "../body.js";
import { emit } from "../output.js";
import type { CliContext } from "../program.js";
import { withStore } from "../with-store.js";

interface AddOptions {
  readonly level?: string;
  readonly kind?: string;
  readonly lane?: string;
  readonly priority?: string;
  readonly assignee?: string;
  readonly parent?: string;
  readonly tag?: string[];
  readonly bodyFile?: string;
  readonly json?: boolean;
}

export function registerAdd(program: Command, context: CliContext): void {
  program
    .command("add")
    .argument("<title>", "what the work is")
    .description("create a task or epic")
    .option("--level <level>", "epic or task (default: task)")
    .option("--kind <kind>", "feat, fix, refactor, perf, docs, test or chore (default: feat)")
    .option("--lane <lane>", "starting lane (default: Defined)")
    .option("--priority <n>", "0 (highest) to 4 (default: 2)")
    .option("--assignee <who>", "who is doing it")
    .option("--parent <id>", "the epic this belongs to; accepts a partial id")
    .option("--tag <tag>", "add a tag; repeatable", (value: string, previous: string[] = []) => [
      ...previous,
      value,
    ])
    .option("--body-file <path>", 'read the description from a file, or "-" for stdin')
    .option("--json", "emit structured output")
    .action((title: string, options: AddOptions) => {
      // Descriptions arrive by file or pipe, never as an argument: quotes,
      // backticks and newlines are exactly what shell escaping gets wrong.
      const description = readBody({
        bodyFile: options.bodyFile,
        cwd: context.cwd,
        readStdin: context.readStdin,
      });

      const input: NewTask = {
        title,
        // Narrowed here rather than cast: the command line is a runtime
        // boundary, and a bad --lane should say what the lanes are.
        ...(options.level === undefined ? {} : { level: narrowLevel(options.level) }),
        ...(options.kind === undefined ? {} : { kind: narrowKind(options.kind) }),
        ...(options.lane === undefined ? {} : { lane: narrowLane(options.lane) }),
        ...(options.priority === undefined ? {} : { priority: narrowPriority(options.priority) }),
        ...(options.assignee === undefined ? {} : { assignee: options.assignee }),
        ...(options.parent === undefined ? {} : { parentId: options.parent }),
        ...(options.tag === undefined ? {} : { tags: options.tag }),
        ...(description === undefined ? {} : { description }),
      };

      const { result, warnings } = withStore(context, (store) => createTask(store, input));

      emit(
        result,
        { json: options.json === true, warnings, streams: context.streams },
        (task: Task) => task.id,
      );
    });
}
