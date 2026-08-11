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

import type { ClaimInfo } from "../claims/types.js";
import type { Kind, Lane, Level, Priority } from "../enums.js";
import type { LoggedEvent } from "../events/types.js";
import type { Note } from "../notes/types.js";

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

/**
 * A task standing between another task and readiness.
 *
 * Declared here rather than in `contract.ts` because {@link TaskDetail} needs
 * it: `contract.ts` already imports this module, so defining it there and
 * importing it back would make the two mutually dependent.
 */
export interface Blocker {
  readonly id: string;
  readonly title: string;
  readonly lane: Lane;
}

/** What `update` returns, and the base of what `show` returns. */
export interface TaskDetail {
  readonly task: Task;
  /** The epic this task belongs to, resolved so output can name it. */
  readonly parent: TaskSummary | null;
  /** Tasks associated with this one. Carries no blocking meaning. */
  readonly links: readonly TaskSummary[];
  /**
   * Unfinished dependencies — what stops this being started.
   *
   * The same set and the same ordering `next` reports, deliberately: an agent
   * that asks `show` whether it can start a task and one that asks `next` for
   * something to start must not get different answers. Finished dependencies
   * are omitted for the same reason they are in `next` — they are no longer in
   * the way.
   */
  readonly blockers: readonly Blocker[];
  /** Tasks waiting on this one — what finishing it would release. */
  readonly blocking: readonly Blocker[];
}

/**
 * What `show` returns: a task detail plus its notes and recent activity.
 *
 * Separate from {@link TaskDetail} rather than folded into it, because
 * `update` returns a detail too and must not be charged two extra queries per
 * task for content it never prints. Both sections are bounded by fixed
 * internal caps — see `view.ts` for why they are not `--limit` flags.
 */
export interface TaskView extends TaskDetail {
  readonly notes: readonly Note[];
  readonly activity: readonly LoggedEvent[];
  /**
   * True when a fixed cap cut that section short.
   *
   * The human rendering points at `note list` and `log` unconditionally, so a
   * reader is never misled; `--json` has no such prose, and F3's digest is
   * likelier to parse it. The rule `EventLog.truncated` states applies here
   * verbatim — a bound that cannot report itself is indistinguishable from the
   * end of the data.
   */
  readonly notesTruncated: boolean;
  readonly activityTruncated: boolean;
  /**
   * Who holds this task, or `null` when it is unclaimed.
   *
   * On {@link TaskView}, not {@link TaskDetail} (F4 T8): `showTaskWithin` is
   * what `update` returns from inside its write transaction, and a claim
   * lookup is exactly the extra query that function's own docs say `update`
   * must not pay for content it never prints — the same reasoning that keeps
   * `notes`/`activity` off `TaskDetail`. `viewTask` (`show`) fills this one;
   * `TaskDetail`'s callers stay untouched.
   *
   * Required-nullable rather than optional: an epic can never hold a claim, so
   * this is genuinely always `null` there, the same way `assignee` is `null`
   * on an unassigned task — ordinary absent data, not the union-arm ambiguity
   * {@link BriefResult}'s `claim` avoids by omission (see there).
   */
  readonly claim: ClaimInfo | null;
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
