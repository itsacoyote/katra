/**
 * Human-readable renderings.
 *
 * Kept apart from the values commands return, so the `--json` output and the
 * text output are two views of one object rather than two things that can
 * drift. Every function here is pure: value in, string out.
 */

import type { Task, TaskDetail } from "../core/tasks/types.js";

function field(label: string, value: string): string {
  return `  ${label.padEnd(12)}${value}`;
}

/** The full block `show` prints. */
export function formatTaskDetail(detail: TaskDetail): string {
  const { task, parent } = detail;
  const lines = [
    `${task.id}  ${task.title}`,
    field("level", task.level),
    field("kind", task.kind),
    field("lane", task.lane),
    field("priority", `P${task.priority}`),
  ];

  if (task.assignee !== null) lines.push(field("assignee", task.assignee));
  if (parent !== null) lines.push(field("epic", `${parent.id}  ${parent.title}`));
  for (const [index, link] of detail.links.entries()) {
    lines.push(field(index === 0 ? "links" : "", `${link.id}  ${link.title}`));
  }
  if (task.tags.length > 0) lines.push(field("tags", task.tags.join(", ")));

  lines.push(field("created", task.createdAt));
  if (task.updatedAt !== task.createdAt) lines.push(field("updated", task.updatedAt));
  if (task.closedAt !== null) lines.push(field("closed", task.closedAt));
  if (task.closeReason !== null) lines.push(field("reason", task.closeReason));

  if (task.description !== null && task.description.trim() !== "") {
    lines.push("", task.description.trimEnd());
  }

  return lines.join("\n");
}

/**
 * A listing, aligned so ids and lanes line up down the page.
 *
 * An empty result says so rather than printing nothing: a blank response is
 * indistinguishable from a command that failed silently.
 */
export function formatTaskList(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "no tasks match";

  // Reduced rather than `Math.max(...tasks.map(…))`: spreading the result set
  // as arguments blows the stack somewhere past a hundred thousand rows, and
  // `list` has no limit.
  const width = (pick: (task: Task) => string): number =>
    tasks.reduce((widest, task) => Math.max(widest, pick(task).length), 0);
  const laneWidth = width((task) => task.lane);
  const kindWidth = width((task) => (task.level === "epic" ? "epic" : task.kind));

  return tasks
    .map((task) =>
      [
        task.id,
        `P${task.priority}`,
        task.lane.padEnd(laneWidth),
        (task.level === "epic" ? "epic" : task.kind).padEnd(kindWidth),
        task.title,
      ].join("  "),
    )
    .join("\n");
}
