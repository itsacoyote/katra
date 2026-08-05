/**
 * Human-readable renderings.
 *
 * Kept apart from the values commands return, so the `--json` output and the
 * text output are two views of one object rather than two things that can
 * drift. Every function here is pure: value in, string out.
 */

import type { LoggedEvent } from "../core/events/types.js";
import type { Note } from "../core/notes/types.js";
import type { Task, TaskDetail, TaskView } from "../core/tasks/types.js";

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
export function formatEventLog(events: readonly LoggedEvent[], truncated: boolean): string {
  // `--limit 0` is a real request, and it is the one input where truncation is
  // total — reporting "nothing has happened yet" there would be a claim of
  // completeness in exactly the case the flag exists to prevent.
  if (events.length === 0) {
    return truncated ? "  … more; raise --limit to see further back" : "nothing has happened yet";
  }

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

  const rows = events
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

  // A bound that cannot report itself is indistinguishable from the end of the
  // history — and this is the read a session digest is built on.
  return truncated ? `${rows}\n  … more; raise --limit to see further back` : rows;
}

/**
 * Removes control characters a terminal would act on, keeping the two that
 * carry meaning.
 *
 * Notes are where fetched content and model output get pasted, and F3's
 * `brief` will surface handoff notes to *other agents* as their first context.
 * A raw ANSI escape in a body executes on whatever renders it — it can repaint
 * the screen, hide what follows, or misreport what a task says.
 *
 * Newline and tab survive, so indentation and line structure — the reason
 * pasted code is in a note at all — come through intact. `--json` is
 * deliberately not sanitised: it is the programmatic path, its consumer is not
 * a terminal, and a value altered on the way out would no longer be what was
 * stored.
 */
function sanitizeBody(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  return text.replaceAll(/[\u0000-\u0008\u000B-\u001F\u007F]+/g, "");
}

/**
 * A note reduced to a single line, for a summary that has no room for the body.
 *
 * The first line only, then the full control-character collapse — a preview
 * has no use for the newline and tab {@link sanitizeBody} keeps, and either
 * would break the row.
 */
function previewBody(text: string, width: number): string {
  const [first = ""] = text.split("\n");
  return clamp(oneLine(first), width);
}

/**
 * One note's header line: everything about it except the body.
 *
 * The actor is always shown here, unlike in the log. A note is something
 * somebody wrote, and "who wrote this handoff" is the first question its
 * reader has — a log row is a mechanical record, a note is authorship.
 */
function noteHeader(note: Note): string {
  return `${note.id}  ${note.kind}  ${note.createdAt.slice(0, 16).replace("T", " ")}  ${note.actor}`;
}

/** A single note, header then body. What `note add` prints back. */
export function formatNote(note: Note): string {
  return `${noteHeader(note)}\n\n${sanitizeBody(note.body).trimEnd()}`;
}

/**
 * Notes, newest first, each as a header and its body.
 *
 * **Not one line per note**, unlike every other listing katra prints. A note's
 * body is the reason to read it, so truncating to a row would leave the
 * command answering a question nobody asked. `--limit` is how the output is
 * bounded instead.
 *
 * Bodies keep their newlines and tabs — the one place in the CLI where
 * multi-line content is the point rather than a hazard — but everything else a
 * terminal would act on is removed. Keeping indentation was the whole
 * objection to sanitising, and {@link sanitizeBody} keeps it, so the objection
 * does not survive: an ANSI escape pasted into a note would otherwise execute
 * on whoever read it back. `--json` stays verbatim.
 */
export function formatNoteList(notes: readonly Note[]): string {
  if (notes.length === 0) return "no notes";

  return notes
    .map((note) => `${noteHeader(note)}\n${indent(sanitizeBody(note.body).trimEnd())}`)
    .join("\n\n");
}

/** Indents a body so it reads as belonging to the header above it. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}

/** How much of a note's body a `show` preview carries. */
const PREVIEW_WIDTH = 56;

/**
 * The full `show` block: the task detail, then its notes and recent activity.
 *
 * Notes appear as **metadata plus a one-line preview**, not as bodies. `show`
 * is a compact summary of one task, and a long-lived task accumulates notes
 * without bound — inlining them turns the summary into a dump on exactly the
 * tasks most worth summarising. `katra note list <id>` prints whole bodies and
 * `katra log <id>` the whole history; both sections here name the command that
 * shows the rest.
 *
 * A task with no notes and no activity gets neither heading: an empty section
 * is a line that says nothing happened, which the absence already says.
 */
export function formatTaskView(view: TaskView): string {
  const lines = [formatTaskDetail(view)];

  if (view.notes.length > 0) {
    lines.push("", `notes (${view.notes.length}, newest first — \`katra note list\` for bodies)`);
    for (const note of view.notes) {
      lines.push(
        `  ${note.id}  ${note.kind.padEnd(10)}  ${note.createdAt.slice(0, 16).replace("T", " ")}  ${previewBody(note.body, PREVIEW_WIDTH)}`,
      );
    }
  }

  if (view.activity.length > 0) {
    lines.push("", `activity (newest first — \`katra log\` for the rest)`);
    for (const event of view.activity) {
      const when = event.createdAt.slice(0, 16).replace("T", " ");
      // An epic's view carries its children's events too, so a row about
      // something other than this task has to name it — three bare `created`
      // rows under an epic are otherwise indistinguishable from each other.
      const subject =
        event.entityId === view.task.id
          ? ""
          : `  ${event.entityId}  ${previewBody(event.entityTitle ?? "", TITLE_WIDTH)}`;
      lines.push(
        `  ${when}  ${event.type.padEnd(14)}${subject}  ${describeEvent(event)}`.trimEnd(),
      );
    }
  }

  return lines.join("\n");
}
