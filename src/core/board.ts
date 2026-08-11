/**
 * `board` — where the repository stands, right now.
 *
 * At the core root rather than under `tasks/` because it belongs to no entity
 * directory: it reads across `tasks`, `graph/deps`, `events` and `tasks/next`
 * at once, so it composes from above the way `store.ts` and `actor.ts` sit
 * above everything.
 *
 * **A projection, not a feed** (ADR-009). `log` already answers "what
 * happened"; this answers "where do things stand", which is a question about
 * current state with recent activity as context rather than as the substance.
 * The shape is fixed and takes no filters — `list` and `log` are where narrow
 * questions go, and a board that grew filters would become a query language
 * whose output shape an agent could no longer predict.
 *
 * Every read runs inside one `readTx`, so the counts cannot describe a
 * different snapshot from the sections beneath them.
 */

import type { BoardCounts, BoardResult, BoardSection, BoardTask } from "./contract.js";
import { readTx } from "./db/connection.js";
import { IN_FLIGHT_LANES, sqlEnum, TERMINAL_LANES, UNTRIAGED_LANES } from "./enums.js";
import { listEvents } from "./events/repo.js";
import { listBlockersFor, READINESS_VIEW } from "./graph/deps.js";
import { latestHandoff } from "./notes/repo.js";
import type { OpenStore } from "./store.js";
import { BRIEF_HANDOFF_CHARS } from "./tasks/brief.js";
import { readyPredicate, TASK_RANKING } from "./tasks/next.js";
import { capText } from "./text.js";

/**
 * How much of the digest body the board keeps.
 *
 * The same bound `brief` applies to the same kind of note, so the two commands
 * cut a handoff at the same place.
 */
const BOARD_DIGEST_CHARS = BRIEF_HANDOFF_CHARS;

/**
 * How many rows each section shows when the caller does not say.
 *
 * Bounded so the board's output stays the same size on a store of ten tasks and
 * one of ten thousand — the property that makes "run it at every checkpoint"
 * affordable to read. The counts above each section are **not** capped, so
 * nothing is hidden, only deferred to `list`.
 */
export const BOARD_SECTION_LIMIT = 8;

export interface BoardOptions {
  /** Rows per section. The counts are unaffected. */
  readonly limit?: number;
  /**
   * Lead with the store's newest handoff.
   *
   * Read **inside** the same snapshot as everything else. An earlier version
   * left this to the command layer, which meant the digest's `taskLane` — the
   * one field whose job is stopping a finished task's handoff reading as live
   * work — came from a different snapshot than the sections it sat above.
   */
  readonly digest?: boolean;
}

/**
 * Every task section carries this, so nothing outside it can appear on a board.
 *
 * Epics are excluded everywhere, not only from `ready`. Nothing forbids an epic
 * sitting in `In Progress` — `0001-init.ts`'s CHECK only forbids an epic having
 * a parent — and an epic with a dependency is unready, so an epic reaches both
 * the in-flight and the blocked sections by the plain reading of their
 * definitions. Excluding them from `ready` alone would give a board that
 * refuses to *offer* an epic as work while showing it as work in progress.
 */
const TASKS_ONLY = "t.level = 'task'";

/** Not `Done` and not `Cancelled`. What `open` means. */
const OPEN = `${TASKS_ONLY} AND t.lane NOT IN (${sqlEnum(TERMINAL_LANES)})`;

const IN_FLIGHT = `${TASKS_ONLY} AND t.lane IN (${sqlEnum(IN_FLIGHT_LANES)})`;

/**
 * Unstartable work that nobody is part-way through.
 *
 * The in-flight exclusion is **in the `WHERE`**, not a filter applied to the
 * rendered rows afterwards. Post-filtering looks equivalent and is not: the
 * in-flight section is capped, so a blocked in-flight task past the cap would
 * reappear here while the uncapped counts still booked it as in flight, and the
 * header would stop reconciling with the sections — the one thing the
 * disjointness rule exists to guarantee.
 */
const BLOCKED = `${OPEN} AND t.lane NOT IN (${sqlEnum(IN_FLIGHT_LANES)}) AND r.is_ready = 0`;

/** Startable work nobody has planned yet — the residue the other three miss. */
const UNTRIAGED = `${TASKS_ONLY} AND t.lane IN (${sqlEnum(UNTRIAGED_LANES)}) AND r.is_ready = 1`;

/** The raw shape every section query returns. */
interface BoardRow {
  readonly id: string;
  readonly title: string;
  readonly lane: string;
  readonly priority: number;
  readonly is_ready: number;
}

function countWhere(store: OpenStore, where: string, params: readonly unknown[] = []): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks t
         JOIN ${READINESS_VIEW} r ON r.id = t.id
        WHERE ${where}`,
    )
    .get(...params) as { c: number };
  return row.c;
}

/**
 * Runs one section query, over-fetching by one so truncation is knowable.
 *
 * The idiom `listEvents` and `viewTask` already use: a bound that cannot report
 * itself is indistinguishable from the end of the data.
 */
function section(
  store: OpenStore,
  where: string,
  limit: number,
  params: readonly unknown[] = [],
): { rows: BoardRow[]; truncated: boolean } {
  const rows = store.db
    .prepare(
      `SELECT t.id AS id, t.title AS title, t.lane AS lane, t.priority AS priority,
              r.is_ready AS is_ready
         FROM tasks t
         JOIN ${READINESS_VIEW} r ON r.id = t.id
        WHERE ${where}
        ${TASK_RANKING}
        LIMIT ?`,
    )
    .all(...params, limit + 1) as BoardRow[];

  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

function toBoardTask(row: BoardRow, blockers: readonly BoardTask["blockers"][number][]): BoardTask {
  return {
    id: row.id,
    title: row.title,
    lane: row.lane as BoardTask["lane"],
    priority: row.priority as BoardTask["priority"],
    blocked: row.is_ready === 0,
    blockers,
    // Honest nulls, not yet real answers: the section queries above do not
    // join `claims`, so this pure formatter has nothing truthful to report.
    // T7 joins claims into `BoardRow` and wires both fields from it —
    // `claimedElsewhere` from the same own-vs-other comparison it already
    // needs for the ready section's ORDER BY.
    claim: null,
    claimedElsewhere: false,
  };
}

/** Assembles the board. Reads only; opens no write transaction and no actor. */
export function readBoard(store: OpenStore, options: BoardOptions = {}): BoardResult {
  const limit = options.limit ?? BOARD_SECTION_LIMIT;
  const ready = readyPredicate();

  // One deferred snapshot around every read: five questions whose answers must
  // describe one store. As separate auto-commit reads, a commit landing between
  // the counts and the ready section yields a header that contradicts the rows
  // beneath it — and board is the command meant to be run constantly, so it runs
  // alongside other worktrees writing.
  return readTx(store.db, () => {
    const counts: BoardCounts = {
      open: countWhere(store, OPEN),
      inFlight: countWhere(store, IN_FLIGHT),
      ready: countWhere(store, ready.sql, ready.params),
      blocked: countWhere(store, BLOCKED),
      untriaged: countWhere(store, UNTRIAGED),
    };

    const inFlight = section(store, IN_FLIGHT, limit);
    const readyRows = section(store, ready.sql, limit, ready.params);
    const blockedRows = section(store, BLOCKED, limit);
    // The same bound as every other section. A second constant here meant
    // `--limit 0` emptied the task sections and still printed eight activity
    // rows — a section the flag was documented to bound and did not.
    const recent = listEvents(store, { limit });

    const toSection = (
      found: { rows: BoardRow[]; truncated: boolean },
      withBlockers: boolean,
    ): BoardSection => {
      // One statement for the whole section, not one per row. `--limit` is
      // caller-supplied and `narrowCount` allows up to a million, so a per-row
      // read would let a caller hold this deferred snapshot open across a
      // million statements — the WAL-checkpointing hazard `readTx` documents.
      const blockers = withBlockers
        ? listBlockersFor(
            store,
            found.rows.map((row) => row.id),
          )
        : new Map<string, BoardTask["blockers"]>();
      return {
        tasks: found.rows.map((row) => toBoardTask(row, blockers.get(row.id) ?? [])),
        truncated: found.truncated,
      };
    };

    return {
      counts,
      inFlight: toSection(inFlight, false),
      ready: toSection(readyRows, false),
      blocked: toSection(blockedRows, true),
      recent: recent.events,
      recentTruncated: recent.truncated,
      pointer: pointerFor(counts),
      digest: options.digest === true ? digestFor(store) : null,
    };
  });
}

/**
 * The newest handoff in the store, capped, or null when there is none.
 *
 * Unfiltered by lane on purpose: "I finished X, next is Y" is the commonest
 * real handoff and lives on a `Done` task. The lane travels with it so a
 * finished task's handoff cannot be mistaken for live context.
 */
function digestFor(store: OpenStore): BoardResult["digest"] {
  const handoff = latestHandoff(store);
  if (handoff === undefined) return null;

  const capped = capText(handoff.note.body, BOARD_DIGEST_CHARS);
  return {
    note: { ...handoff.note, body: capped.text },
    truncated: capped.truncated,
    taskId: handoff.taskId,
    taskTitle: handoff.taskTitle,
    taskLane: handoff.taskLane,
  };
}

/**
 * What to say when nothing is startable and nothing is under way.
 *
 * Triggered on the **counts**, never on the rendered sections: sections are
 * capped, and `--limit 0` empties all three while the backlog is untouched.
 * Without this a store holding twelve `Defined` tasks renders as four empty
 * sections and says nothing about where the twelve are.
 */
function pointerFor(counts: BoardCounts): string | null {
  if (counts.inFlight > 0 || counts.ready > 0 || counts.blocked > 0) return null;
  if (counts.untriaged === 0) return null;
  return (
    `${counts.untriaged} task${counts.untriaged === 1 ? "" : "s"} waiting to be planned — ` +
    `move one to Planned with \`katra update <id> --lane Planned\``
  );
}
