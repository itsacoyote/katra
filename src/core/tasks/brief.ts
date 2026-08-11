/**
 * `brief` — everything a session needs to resume one task or epic, in one call.
 *
 * A module of its own above the repos, for the reason `view.ts` states:
 * `notes/repo.ts` already imports `tasks/repo.ts`, so reaching back the other
 * way would make them mutually dependent. This sits above both and neither
 * changes.
 *
 * **Not built on `viewTask`.** That composes the same pieces for `show`, and
 * its shape is the one `brief` exists to replace: five note *previews* capped
 * for a summary. A handoff is written to be read whole, and a truncated one is
 * worse than an absent one because a reader acts on it. `brief` takes
 * `showTaskWithin` — the identity, lane, blockers and dependents — and assembles
 * its own notes and activity around it.
 *
 * That is also the line between the two commands, and it is worth keeping
 * sharp: `show` answers *what is this task*, `brief` answers *what do I need to
 * resume it*. `show` prints no note body; `brief` leads with one. If that
 * distinction ever blurs, `brief` is `show --verbose` and does not earn its
 * place.
 */

import { claimFor } from "../claims/repo.js";
import type { BriefLane, BriefNote, BriefResult } from "../contract.js";
import { LANES } from "../enums.js";
import { listEvents } from "../events/repo.js";
import type { NoteScope } from "../notes/repo.js";
import { countNotesByKind, latestNoteInScope } from "../notes/repo.js";
import type { OpenStore } from "../store.js";
import { capText } from "../text.js";
import { requireId } from "./ids.js";
import { listTasks, showTaskWithin } from "./repo.js";
import type { TaskSummary } from "./types.js";
import { summarise } from "./types.js";

/**
 * How much of a handoff body `brief` prints before cutting it.
 *
 * Generous on purpose: the point of the command is that a session does not need
 * a second call, and a handoff that routinely truncates would defeat that. This
 * is a guard against a pathological paste — a note holding a whole build log —
 * not a summary width.
 *
 * `katra note list <id>` is the unbounded read, and the output names it
 * whenever the cap bites.
 */
export const BRIEF_HANDOFF_CHARS = 4000;

/**
 * How many events `brief` shows.
 *
 * More than `show`'s eight: `brief` is the deliberate, once-per-resume read, so
 * it can afford a longer tail. `katra log <id>` is the unbounded one.
 */
export const BRIEF_ACTIVITY_LIMIT = 12;

/**
 * How many children `brief` lists **per lane** on an epic.
 *
 * Per lane, not overall. `listTasks` orders by priority and lane is not in that
 * sort, so one global cap over an epic with forty `Done` children and three
 * `Planned` ones can fill itself entirely from the finished work — the exact
 * opposite of "show me the shape of what is left".
 */
export const BRIEF_CHILDREN_PER_LANE = 8;

/** What `--full` multiplies the caps by. */
const FULL_MULTIPLIER = 20;

export interface BriefOptions {
  /** Lift the caps: the whole handoff, a longer tail, more children. */
  readonly full?: boolean;
}

/** The caps in force for one invocation. */
interface Caps {
  readonly handoffChars: number;
  readonly activity: number;
  readonly childrenPerLane: number;
}

function capsFor(options: BriefOptions): Caps {
  const full = options.full === true;
  const factor = full ? FULL_MULTIPLIER : 1;
  return {
    // `--full` **lifts** this one rather than raising it, which is the verb the
    // spec uses and the difference that matters: multiplying it by twenty still
    // truncates the 200 KB paste the flag exists for, and sends the reader to
    // `note list` anyway. `capText` handles Infinity on the same code path —
    // its `kept.length === max` comparison simply never fires — so this is not
    // an unbounded branch, just an unbounded bound.
    handoffChars: full ? Number.POSITIVE_INFINITY : BRIEF_HANDOFF_CHARS,
    // The row caps are *raised*, not lifted: an epic with ten thousand children
    // is still not something to print.
    activity: BRIEF_ACTIVITY_LIMIT * factor,
    childrenPerLane: BRIEF_CHILDREN_PER_LANE * factor,
  };
}

/** The latest handoff in a scope, capped, or null. */
function handoffFor(store: OpenStore, scope: NoteScope, caps: Caps): BriefNote | null {
  const note = latestNoteInScope(store, { ...scope, kind: "handoff" });
  if (note === undefined) return null;

  const capped = capText(note.body, caps.handoffChars);
  return { note: { ...note, body: capped.text }, truncated: capped.truncated };
}

/**
 * An epic's children, grouped by lane in workflow order.
 *
 * Lanes with no children are omitted entirely — an empty `In Review` heading is
 * noise, and the point of the grouping is to show where the work actually sits.
 */
function childrenByLane(store: OpenStore, epicId: string, caps: Caps): BriefLane[] {
  // The epic and terminal-lane guards inside `listTasks` sit behind
  // `filters.ready !== undefined`, so neither fires here: every child comes
  // back, including finished ones, which is what a shape-of-the-work view needs.
  const { tasks: children } = listTasks(store, { epic: epicId });

  const grouped = new Map<string, TaskSummary[]>();
  for (const child of children) {
    const bucket = grouped.get(child.lane);
    if (bucket === undefined) grouped.set(child.lane, [summarise(child)]);
    else bucket.push(summarise(child));
  }

  // Iterating `LANES` rather than the map's keys: insertion order would follow
  // the query's ranking, so the lanes would come back in priority order rather
  // than in the order work moves through them.
  const lanes: BriefLane[] = [];
  for (const lane of LANES) {
    const tasks = grouped.get(lane);
    if (tasks === undefined) continue;
    lanes.push({
      lane,
      tasks: tasks.slice(0, caps.childrenPerLane),
      total: tasks.length,
      truncated: tasks.length > caps.childrenPerLane,
    });
  }
  return lanes;
}

/**
 * Assembles a brief for a task or an epic.
 *
 * One entry point that dispatches on `level` rather than two exported
 * functions: the caller has an id, not a level, so a two-function surface would
 * force every caller to read the task first just to decide which to call.
 *
 * **`requireId`, not `requireEntityId`.** The latter unions historical event
 * ids so `log <deletedId>` can still answer; resuming work on a deleted task is
 * not a thing, and accepting one here would resolve an id whose task then reads
 * back as `undefined` — a second not-found branch that should not exist.
 *
 * Resolves no actor: nothing here writes, and the actor costs two subprocess
 * spawns.
 *
 * **Deliberately not wrapped in `readTx`, unlike `board`.** The rule this
 * branch added to `AGENTS.md` — multi-statement reads that must agree with each
 * other go inside one snapshot — is a real cost/benefit call, and it lands the
 * other way here:
 *
 * - What could disagree is small. `noteCounts` could be a note ahead of the
 *   `handoff` above it, or an epic's children a task ahead of its activity.
 *   Board's five *counts* sit above the rows they describe and are read as one
 *   statement about the store; a brief is a description of one entity where a
 *   millisecond of skew changes a tally by one.
 * - What it would cost is not. `childrenByLane` runs `listTasks({epic})`, and
 *   `rowToTask` issues a tag query per row — 501 statements on a 500-child
 *   epic. `readTx`'s own docstring says keep the callback short, because a
 *   lingering read snapshot stops WAL checkpointing for the *whole store*, not
 *   just this handle.
 *
 * **The order below is load-bearing.** `handoff` is read before `noteCounts`,
 * and the rendering computes `remaining = noteCounts.handoff - 1` to decide
 * whether to say "1 more handoff". Reading the counts first would let a note
 * written between the two make `remaining` describe a handoff the reader never
 * saw. In this order the count can only be ahead, so the line degrades to one
 * extra rather than to a missing one — and a concurrent *delete* drives it
 * negative, where the `> 0` guard catches it. Swap the two properties and the
 * safety goes with them.
 *
 * Recorded in `docs/f3-traceability.md`'s known limits rather than left as an
 * absence, because "brief does not do what board does" reads as an oversight
 * unless the reason is written down.
 */
export function briefEntity(
  store: OpenStore,
  idInput: string,
  options: BriefOptions = {},
): BriefResult {
  const id = requireId(store, idInput);
  const caps = capsFor(options);
  const detail = showTaskWithin(store, id);
  const isEpic = detail.task.level === "epic";

  // An epic's scope covers its children; a task's is itself. The two mechanisms
  // differ — see `scopeConditions` — and this is the one place that matters.
  const scope: NoteScope = isEpic ? { epicId: id } : { taskId: id };

  // Scoped to the entity, so an epic's activity carries its children's too:
  // `listEvents` reads the `epic_id` stamped at write time and needs no join.
  const activity = listEvents(store, { entityId: id, limit: caps.activity });

  const common = {
    task: detail.task,
    epic: detail.parent,
    handoff: handoffFor(store, scope, caps),
    noteCounts: countNotesByKind(store, scope),
    activity: activity.events,
    activityTruncated: activity.truncated,
    // On both arms: `showTaskWithin` computes these for any level, and an epic
    // with a dependency is an ordinary thing the schema permits.
    blockers: detail.blockers,
    blocking: detail.blocking,
  };

  if (isEpic) {
    return { ...common, level: "epic", children: childrenByLane(store, id, caps) };
  }
  // Read only on the task arm — an epic can never hold a claim (AC6), and
  // `BriefResult`'s epic arm carries no `claim` field to fill.
  return { ...common, level: "task", claim: claimFor(store, id) };
}
