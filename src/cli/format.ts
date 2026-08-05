/**
 * Human-readable renderings.
 *
 * Kept apart from the values commands return, so the `--json` output and the
 * text output are two views of one object rather than two things that can
 * drift. Every function here is pure: value in, string out.
 */

import type { LoggedEvent } from "../core/events/types.js";
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

  // Blockers before links and tags: "can I start this?" is the question `show`
  // is usually asked, and the answer should not be below the fold. Stated
  // explicitly when there are none, because a missing line reads as "this view
  // does not know" — which is exactly what it used to mean.
  if (detail.blockers.length === 0) {
    lines.push(field("blockers", "none"));
  } else {
    for (const [index, blocker] of detail.blockers.entries()) {
      lines.push(
        field(index === 0 ? "blockers" : "", `${blocker.id}  ${blocker.lane}  ${blocker.title}`),
      );
    }
  }
  for (const [index, dependent] of detail.blocking.entries()) {
    lines.push(
      field(
        index === 0 ? "blocking" : "",
        `${dependent.id}  ${dependent.lane}  ${dependent.title}`,
      ),
    );
  }

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

/**
 * A bulk update's result: one line per task, no repeated field block.
 *
 * The single-task case still prints the full detail — one task is worth seeing
 * in full. Ten are not: triaging seven tasks used to emit seventy-seven lines
 * of field blocks whose content the caller had just supplied.
 */
export function formatUpdatedTasks(tasks: readonly TaskDetail[]): string {
  if (tasks.length === 0) return "no tasks updated";

  const width = tasks.reduce((widest, { task }) => Math.max(widest, task.lane.length), 0);
  return [
    `updated ${tasks.length} tasks`,
    ...tasks.map(({ task }) => `  ${task.id}  ${task.lane.padEnd(width)}  ${task.title}`),
  ].join("\n");
}

/**
 * Collapses anything that would break a one-line-per-event rendering.
 *
 * `--reason` is a plain command-line argument, never routed through
 * `readBody`, so it can contain newlines — and one embedded newline shifts
 * every following row out of its column. Control characters matter for a
 * second reason: reasons and titles are where fetched content and model output
 * get pasted, and a raw ANSI escape executes on whatever renders it.
 *
 * Note *bodies* are the deliberately-multiline case and are not rendered here.
 */
function oneLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing them is the point
  return text.replaceAll(/[\u0000-\u001F\u007F]+/g, " ").trim();
}

/** What an event says happened, beyond its type and what it is about. */
function describeEvent(event: LoggedEvent): string {
  const parts: string[] = [];
  if (event.fromLane !== null && event.toLane !== null) {
    parts.push(`${event.fromLane} -> ${event.toLane}`);
  }
  if (event.reason !== null) parts.push(oneLine(event.reason));
  if (event.ref !== null) parts.push(event.ref);
  return parts.join("  ");
}

/**
 * How much room a title gets before it is cut.
 *
 * Titles are prose and the rest of a row is structured, so an uncapped column
 * pushes the lanes and reasons of every other row off to the right. `--json`
 * carries the whole thing for anything that needs it.
 */
const TITLE_WIDTH = 44;

function clamp(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/**
 * The event stream, newest first, one physical line per event.
 *
 * The actor column appears only when the log holds more than one — in a
 * single-agent repository it is the same string on every row, which is pure
 * noise; across worktrees it is the whole reason ADR-007 records it.
 */
export function formatEventLog(events: readonly LoggedEvent[]): string {
  if (events.length === 0) return "nothing has happened yet";

  // Reduced rather than `Math.max(...events.map(…))`: spreading the result set
  // as arguments blows the stack somewhere past a hundred thousand rows, and
  // nothing prunes this table (ADR-008), so its size is unbounded by design.
  const width = (pick: (event: LoggedEvent) => string): number =>
    events.reduce((widest, event) => Math.max(widest, pick(event).length), 0);

  const title = (event: LoggedEvent): string =>
    event.entityTitle === null ? "" : clamp(oneLine(event.entityTitle), TITLE_WIDTH);

  // The actor is elided when every row shares one: in a single-agent
  // repository it is the same string repeated down the page, and it is always
  // recoverable from `--json`.
  //
  // The title is **not** elided the same way, though a scoped log repeats it
  // just as much. The asymmetry is deliberate: for a task that still exists
  // the title is recoverable with `show`, but for a deleted one this log is
  // the only place it survives (ADR-008) — so the case where eliding looks
  // most justified is exactly the case where it destroys the answer.
  const showActor = new Set(events.map((event) => event.actor)).size > 1;
  const showTitle = events.some((event) => event.entityTitle !== null);

  const typeWidth = width((event) => event.type);
  const idWidth = width((event) => event.entityId);
  const actorWidth = showActor ? width((event) => oneLine(event.actor)) : 0;
  const titleWidth = showTitle ? width(title) : 0;

  return events
    .map((event) => {
      const columns = [
        // Minutes, not seconds: a log spanning weeks needs the date, and the
        // second an event landed has never answered anyone's question.
        event.createdAt.slice(0, 16).replace("T", " "),
        event.type.padEnd(typeWidth),
        event.entityId.padEnd(idWidth),
        ...(showActor ? [oneLine(event.actor).padEnd(actorWidth)] : []),
        ...(showTitle ? [title(event).padEnd(titleWidth)] : []),
        describeEvent(event),
      ];
      return columns.join("  ").trimEnd();
    })
    .join("\n");
}
