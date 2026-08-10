/**
 * Writing to the event stream.
 *
 * Every function here runs **inside the caller's already-open transaction** and
 * opens none of its own, the way `reportReadinessChange` does. The spec
 * requires an entity change and the event recording it to be atomic: an event
 * appended in its own transaction could commit while the change that caused it
 * rolled back, leaving history describing something that never happened.
 *
 * That is also why `now` is threaded in rather than read here — one timestamp
 * per transaction, taken after the write lock is acquired, shared by every row
 * the transaction writes.
 */

import { assertNotReadOnly } from "../db/connection.js";
import type { Lane } from "../enums.js";
import { KatraException } from "../errors.js";
import { narrowEventType, narrowLane, narrowNullableText, narrowText } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { requireResolved, resolveIdAmong } from "../tasks/ids.js";
import type { Task } from "../tasks/types.js";
import type { LoggedEvent, NewEvent, StoredEvent } from "./types.js";

/** The raw shape SQLite hands back for an event row. */
interface EventRow {
  readonly id: unknown;
  readonly type: unknown;
  readonly entity_id: unknown;
  readonly epic_id: unknown;
  readonly actor: unknown;
  readonly from_lane: unknown;
  readonly to_lane: unknown;
  readonly ref: unknown;
  readonly reason: unknown;
  readonly title: unknown;
  readonly created_at: unknown;
}

/** Narrows a lane column that is only populated on `status-changed`. */
function narrowNullableLane(value: unknown): Lane | null {
  return value === null || value === undefined ? null : narrowLane(value);
}

/** Maps one row into a domain object, narrowing every column. */
export function rowToEvent(row: EventRow): StoredEvent {
  // Every column, not just the constrained ones. SQLite's flexible typing puts
  // a BLOB in a TEXT column and better-sqlite3 hands one back as a Buffer,
  // which throws inside a formatter as `internal`/exit 4 — telling an agent to
  // escalate a broken machine when the truth is one malformed row.
  if (typeof row.id !== "number" || !Number.isInteger(row.id)) {
    throw new KatraException({
      code: "validation",
      message: `event id must be an integer — the stored value is ${typeof row.id}, so this row is malformed`,
      field: "id",
      value: row.id,
    });
  }

  return {
    id: row.id,
    type: narrowEventType(row.type),
    entityId: narrowText(row.entity_id, "entity_id"),
    epicId: narrowNullableText(row.epic_id, "epic_id"),
    actor: narrowText(row.actor, "actor"),
    fromLane: narrowNullableLane(row.from_lane),
    toLane: narrowNullableLane(row.to_lane),
    ref: narrowNullableText(row.ref, "ref"),
    reason: narrowNullableText(row.reason, "reason"),
    title: narrowNullableText(row.title, "title"),
    createdAt: narrowText(row.created_at, "created_at"),
  };
}

/** How many events a read returns when the caller does not say. */
export const DEFAULT_EVENT_LIMIT = 50;

/**
 * Resolves a partial id against everything history knows about, or throws.
 *
 * **Not `requireId`.** That one searches `tasks`, so it cannot resolve the id
 * of a task that has been deleted — and reading a deleted task's history is
 * precisely what this feature promises (ADR-008). `katra log <deletedId>`
 * would have refused its own headline case.
 *
 * The union covers both directions: `events` alone would miss tasks created
 * before migration 0002, which have rows but no history yet, and `tasks` alone
 * misses everything deleted.
 */
export function requireEntityId(store: OpenStore, input: string): string {
  return requireResolved(
    resolveIdAmong(
      // Anonymous placeholders, with the bounds bound twice: better-sqlite3
      // rejects the `?1`-style numbered form this would otherwise be written
      // with ("Too many parameter values were provided").
      (lower, upper, limit) =>
        store.db
          .prepare(
            `SELECT id FROM (
               SELECT id FROM tasks WHERE id >= ? AND id < ?
               UNION
               SELECT entity_id AS id FROM events WHERE entity_id >= ? AND entity_id < ?
             ) ORDER BY id LIMIT ?`,
          )
          .all(lower, upper, lower, upper, limit) as Array<{ id: string }>,
      input,
      "a task or its history",
    ),
    "task or recorded history",
    "tasks",
  );
}

/** A bounded page of history, and whether the bound cut it short. */
export interface EventPage {
  readonly events: LoggedEvent[];
  readonly truncated: boolean;
}

export interface EventQuery {
  /**
   * Scope to one entity.
   *
   * For a task this is its own history. For an epic it is the epic's own
   * events *and* every event stamped under it — the same query serves both,
   * because no task's id ever appears in another task's `epic_id` unless that
   * task is the epic. Omit it to read the whole store.
   */
  readonly entityId?: string;
  /** Most recent this many. Defaults to {@link DEFAULT_EVENT_LIMIT}. */
  readonly limit?: number;
}

/**
 * Reads events, newest first.
 *
 * **Epic scoping reads the stamped `epic_id` column** — never `tasks WHERE
 * parent_id = ?` followed by fetching those ids' events. That relational
 * instinct mirrors `countChildren` and `listTasks` and is wrong twice over: it
 * drops a deleted child's history, because the child row is gone, and a
 * reparented child's pre-move history, because the parent link now points
 * elsewhere. The column is stamped at write time precisely so this read needs
 * no join.
 *
 * There **is** a join to `tasks`, but only to resolve a display title, and it
 * is a LEFT join. An event outlives its entity, so an inner join would
 * silently drop exactly the history a deleted task most needs — the bug
 * ADR-008 predicts by name. Scoping never touches the joined row: it reads the
 * stamped `epic_id`, so a deleted or reparented child keeps its place.
 *
 * Ordered by `id`, not `created_at`: the id is assigned inside the write
 * transaction, so it is a total order even when several events share a
 * millisecond. Ordering by the timestamp alone would leave same-millisecond
 * events in whatever order the query plan happened to produce.
 */
export function listEvents(store: OpenStore, query: EventQuery = {}): EventPage {
  const limit = query.limit ?? DEFAULT_EVENT_LIMIT;
  const scoped = query.entityId !== undefined;

  const rows = store.db
    .prepare(
      // LEFT, and it has to stay LEFT. An inner join here drops every event
      // whose task has been deleted — the bug ADR-008 predicts by name, and
      // precisely the history this table exists to keep. Scoping still reads
      // the stamped epic_id and never the joined row's parent_id, for the same
      // reason.
      `SELECT e.*, COALESCE(t.title, e.title) AS entity_title
         FROM events e
         LEFT JOIN tasks t ON t.id = e.entity_id
        ${scoped ? "WHERE e.entity_id = ? OR e.epic_id = ?" : ""}
        ORDER BY e.id DESC
        LIMIT ?`,
    )
    .all(...(scoped ? [query.entityId, query.entityId, limit + 1] : [limit + 1])) as Array<
    EventRow & { entity_title: unknown }
  >;

  // One more row than will be returned, purely so truncation is knowable. The
  // same trick `resolveId` uses for its candidate cap, and for the same
  // reason: a bound that cannot report itself is indistinguishable from the
  // end of the data.
  return {
    events: rows.slice(0, limit).map((row) => ({
      ...rowToEvent(row),
      entityTitle: narrowNullableText(row.entity_title, "entity_title"),
    })),
    truncated: rows.length > limit,
  };
}

/**
 * Which epic a task's events belong under (requirement 10).
 *
 * Three cases, and the third is the one that looks wrong until you check the
 * schema: **an epic stamps its own id.** An epic's `parent_id` is always NULL
 * by CHECK, so the obvious `epicId = task.parentId` would leave every epic's
 * own events unstamped — and an epic-scoped read written as
 * `WHERE epic_id = ?` would then silently exclude the epic's own activity.
 */
export function epicIdFor(task: Pick<Task, "id" | "level" | "parentId">): string | null {
  if (task.level === "epic") return task.id;
  return task.parentId;
}

/**
 * Appends one event and returns its id.
 *
 * **Must be called inside an open transaction.** It opens none: see the module
 * note. `now` is the transaction's timestamp, threaded in by the caller.
 */
export function appendEvent(store: OpenStore, event: NewEvent, now: string): number {
  // Enforced, not merely documented. The obvious check — "wrap the append in
  // its own transaction and see whether a rollback test fails" — proves
  // nothing: better-sqlite3 turns a nested transaction into a SAVEPOINT, so it
  // rolls back with the outer one and every test stays green. The failure this
  // actually guards is the opposite one, an append with no transaction around
  // it at all, which autocommits and leaves history describing an entity
  // change that later failed.
  if (!store.db.inTransaction) {
    throw new KatraException({
      code: "internal",
      message:
        "appendEvent must be called inside an open transaction — an event that " +
        "commits on its own can outlive the change it describes",
    });
  }
  // ...and `inTransaction` alone stopped being enough once `readTx` existed: a
  // deferred read sets the same flag, so the check above passes inside one and
  // the insert goes on to attempt a lock upgrade it cannot get. The guard means
  // "inside a *write* transaction", and this is the half that says so.
  assertNotReadOnly(store.db, "appendEvent");

  const info = store.db
    .prepare(
      `INSERT INTO events
         (type, entity_id, epic_id, actor, from_lane, to_lane, ref, reason, title, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      event.type,
      event.entityId,
      event.epicId ?? null,
      event.actor,
      event.fromLane ?? null,
      event.toLane ?? null,
      event.ref ?? null,
      event.reason ?? null,
      event.title ?? null,
      now,
    );

  return Number(info.lastInsertRowid);
}
