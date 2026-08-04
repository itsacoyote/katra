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

import type { Lane } from "../enums.js";
import { KatraException } from "../errors.js";
import { narrowEventType, narrowLane, narrowNullableText, narrowText } from "../narrow.js";
import type { OpenStore } from "../store.js";
import type { Task } from "../tasks/types.js";
import type { NewEvent, StoredEvent } from "./types.js";

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
