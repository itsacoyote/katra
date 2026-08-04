/**
 * Human-readable renderings.
 *
 * Kept apart from the values commands return, so the `--json` output and the
 * text output are two views of one object rather than two things that can
 * drift. Every function here is pure: value in, string out.
 */

import type { Task, TaskDetail } from "../core/tasks/types.js";

/** One line, for listings: `kt-9f3k2a  P0  feat  wire up the parser`. */
export function formatTaskLine(task: Task): string {
  return [
    task.id,
    `P${task.priority}`,
    task.level === "epic" ? "epic" : task.kind,
    task.title,
  ].join("  ");
}

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
