/**
 * The shapes katra hands back.
 *
 * These types **are** the `--json` contract: output is `JSON.stringify` of the
 * value a command returns, so there is no second serialisation step that could
 * drift from the type. Changing one of these changes the documented output,
 * which is why they are named and exported rather than inferred inline.
 *
 * Field names are camelCase here and snake_case in SQL; the row mapper in
 * `repo.ts` is the single place that boundary is crossed.
 */

import type { Kind, Lane, Level, Priority } from "../enums.js";

/** A task or epic, as stored. */
export interface Task {
  readonly id: string;
  readonly level: Level;
  readonly kind: Kind;
  readonly title: string;
  readonly description: string | null;
  readonly lane: Lane;
  readonly priority: Priority;
  readonly assignee: string | null;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  readonly tags: readonly string[];
}

/** Just enough of a task to name it in another task's output. */
export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly level: Level;
  readonly lane: Lane;
}

/**
 * Narrows a task to its summary.
 *
 * Lives beside the two types rather than in each caller: `close`, `cancel` and
 * `delete` all report released dependents, and three copies of the same
 * projection is three places a new summary field can be forgotten.
 */
export function summarise(task: Task): TaskSummary {
  return { id: task.id, title: task.title, level: task.level, lane: task.lane };
}

/** What `show` returns. */
export interface TaskDetail {
  readonly task: Task;
  /** The epic this task belongs to, resolved so output can name it. */
  readonly parent: TaskSummary | null;
  /** Tasks associated with this one. Carries no blocking meaning. */
  readonly links: readonly TaskSummary[];
}

/**
 * What `add` accepts.
 *
 * Only `title` is required. Everything else has a defined default, so the
 * shortest useful invocation is `katra add "some title"`.
 */
export interface NewTask {
  readonly title: string;
  readonly level?: Level;
  readonly kind?: Kind;
  readonly description?: string | null;
  readonly lane?: Lane;
  readonly priority?: Priority;
  readonly assignee?: string | null;
  readonly parentId?: string | null;
  readonly tags?: readonly string[];
}
