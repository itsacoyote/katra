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

import type { ClaimInfo } from "./claims/types.js";
import type { BoardCounts, BoardResult, BoardSection, BoardTask } from "./contract.js";
import { readTx } from "./db/connection.js";
import { IN_FLIGHT_LANES, sqlEnum, TERMINAL_LANES, UNTRIAGED_LANES } from "./enums.js";
import { listEvents } from "./events/repo.js";
import { listBlockersFor, READINESS_VIEW } from "./graph/deps.js";
import { narrowNullableText, narrowText } from "./narrow.js";
import { latestHandoff } from "./notes/repo.js";
import type { OpenStore } from "./store.js";
import { BRIEF_HANDOFF_CHARS } from "./tasks/brief.js";
import {
  CLAIMED_ELSEWHERE,
  CLAIMS_JOIN,
  rankingWith,
  readyPredicate,
  TASK_RANKING,
} from "./tasks/next.js";
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

/**
 * The raw shape every section query returns.
 *
 * `claim_*` and `claimed_elsewhere` ride on every section's row, not only
 * ready's — in flight and blocked carry claim data too (ADR-012), even
 * though only the ready section's `ORDER BY` reads `claimed_elsewhere`.
 * `claim_holder` is the discriminant: `null` means the `claims` LEFT JOIN
 * matched nothing, so the rest of the `claim_*` columns are unclaimed too.
 */
interface BoardRow {
  readonly id: string;
  readonly title: string;
  readonly lane: string;
  readonly priority: number;
  readonly is_ready: number;
  readonly claim_holder: unknown;
  readonly claim_actor: unknown;
  readonly claim_claimed_at: unknown;
  readonly claim_branch: unknown;
  readonly claim_last_seen: unknown;
  readonly claimed_elsewhere: number;
}

/**
 * Builds `BoardTask.claim` from one row's joined claim columns.
 *
 * Mirrors `claims/repo.ts`'s `rowToClaimInfo`, narrowed against a
 * differently-shaped row: that module reads one claim by task id and has
 * unprefixed columns to itself, while a board row already carries `id`,
 * `title`, `lane` — so the section query's `SELECT` prefixes every claim
 * column (`claim_holder`, `claim_branch`, …) to keep the two apart.
 */
function claimFromRow(row: BoardRow): ClaimInfo | null {
  if (row.claim_holder === null) return null;
  return {
    holder: narrowText(row.claim_holder, "claim_holder"),
    actor: narrowText(row.claim_actor, "claim_actor"),
    claimedAt: narrowText(row.claim_claimed_at, "claim_claimed_at"),
    branch: narrowNullableText(row.claim_branch, "claim_branch"),
    lastSeen: narrowNullableText(row.claim_last_seen, "claim_last_seen"),
  };
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
 *
 * Every section joins `claims` (T6's {@link CLAIMS_JOIN}) and `presence` —
 * mirroring `claims/repo.ts`'s own claim-plus-presence read — so every row
 * carries claim data (ADR-012). `claimed_elsewhere`
 * ({@link CLAIMED_ELSEWHERE}) is computed **once**, as a `SELECT`-list alias,
 * so its single `?` binds the caller's worktree in exactly one position
 * regardless of which section is asking or whether that section orders by
 * it (iter-2 advisory 10 / T6 review). `orderBy` defaults to the unchanged
 * {@link TASK_RANKING}; the ready section is the only caller that passes
 * {@link rankingWith}`("claimed_elsewhere")`, which leads the ranking with
 * the alias **by name** rather than re-embedding the expression — so
 * ordering by it costs no second bind either.
 *
 * `worktree` binds first because the `SELECT`-list alias sits, in the raw
 * SQL text, ahead of `where`'s own `?`s and the trailing `LIMIT ?` — binding
 * is positional, so the params array here has to follow the text, not the
 * argument order callers find natural.
 */
function section(
  store: OpenStore,
  where: string,
  limit: number,
  worktree: string,
  params: readonly unknown[] = [],
  orderBy: string = TASK_RANKING,
): { rows: BoardRow[]; truncated: boolean } {
  const rows = store.db
    .prepare(
      `SELECT t.id AS id, t.title AS title, t.lane AS lane, t.priority AS priority,
              r.is_ready AS is_ready,
              c.holder AS claim_holder, c.actor AS claim_actor,
              c.claimed_at AS claim_claimed_at,
              p.branch AS claim_branch, p.last_seen AS claim_last_seen,
              ${CLAIMED_ELSEWHERE} AS claimed_elsewhere
         FROM tasks t
         JOIN ${READINESS_VIEW} r ON r.id = t.id
         ${CLAIMS_JOIN}
         LEFT JOIN presence p ON p.worktree = c.holder
        WHERE ${where}
        ${orderBy}
        LIMIT ?`,
    )
    .all(worktree, ...params, limit + 1) as BoardRow[];

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
    claim: claimFromRow(row),
    claimedElsewhere: row.claimed_elsewhere === 1,
  };
}

/**
 * Assembles the board. Reads only; opens no write transaction.
 *
 * Reads `store.identity().worktree` to evaluate the claims join's
 * own-vs-other comparison — the one piece of caller identity this function
 * touches, and it costs no fresh git spawn: `identity()` is memoised, and
 * `openStore`'s heartbeat (ADR-011) has already resolved the worktree before
 * any command reaches here. `store.actor()` — the more expensive branch
 * resolution — is never called; nothing board renders is written under an
 * actor string.
 */
export function readBoard(store: OpenStore, options: BoardOptions = {}): BoardResult {
  const limit = options.limit ?? BOARD_SECTION_LIMIT;
  const ready = readyPredicate();
  const worktree = store.identity().worktree;

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

    const inFlight = section(store, IN_FLIGHT, limit, worktree);
    // The only section whose ORDER BY reads claimed_elsewhere: unclaimed
    // (and own-claimed) rows first in next's own ranking, other-claimed rows
    // last (ADR-012). rankingWith takes the alias's *name*, not
    // CLAIMED_ELSEWHERE itself — re-embedding the expression here would add
    // a second `?` to this one statement, exactly the drift the T6 review
    // flagged. Referencing the name costs nothing extra: SQLite resolves an
    // ORDER BY term against the SELECT list before falling back to the FROM
    // clause.
    const readyRows = section(
      store,
      ready.sql,
      limit,
      worktree,
      ready.params,
      rankingWith("claimed_elsewhere"),
    );
    const blockedRows = section(store, BLOCKED, limit, worktree);
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
