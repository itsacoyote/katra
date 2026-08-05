/**
 * The shapes the event stream stores and hands back.
 *
 * Like `tasks/types.ts`, these **are** the `--json` contract: output is
 * `JSON.stringify` of the value a command returns. Field names are camelCase
 * here and snake_case in SQL; `repo.ts` is the single place that boundary is
 * crossed.
 */

import type { EventType, Lane } from "../enums.js";

/** One recorded occurrence, as stored. */
export interface StoredEvent {
  /**
   * SQLite's rowid: monotonic, assigned inside the write transaction, so it is
   * a total order that agrees with commit order. Nobody types it, which is why
   * it is an integer rather than a `kt-` style random id.
   */
  readonly id: number;
  readonly type: EventType;
  /**
   * The entity this is about. **Not a foreign key** (ADR-008) — the task may
   * be gone and the event is still true.
   */
  readonly entityId: string;
  /** The epic this belongs under, or null for top-level work. */
  readonly epicId: string | null;
  readonly actor: string;
  /** Both set on `status-changed`, both null otherwise. */
  readonly fromLane: Lane | null;
  readonly toLane: Lane | null;
  /** The note id, on `note-added`. Dangles once the note cascades away. */
  readonly ref: string | null;
  /** Why — close and cancel only. Never a title; see `title`. */
  readonly reason: string | null;
  /** The entity's title at the time, on `created` and `deleted`. */
  readonly title: string | null;
  readonly createdAt: string;
}

/**
 * A stored event plus the title of whatever it is about.
 *
 * `entityTitle` is **resolved, not stored**: the entity's title now, falling
 * back to the one stamped on the event, and null when neither exists. That
 * ordering answers the question a reader of a log actually has — *which task
 * is this row about* — while {@link StoredEvent.title} keeps the historical
 * answer for anyone who wants what it was called at the time.
 *
 * Resolution is a **LEFT** join. An inner one would drop every event whose
 * task has been deleted, which is the bug ADR-008 predicts by name and the
 * exact history the event stream exists to preserve.
 */
export interface LoggedEvent extends StoredEvent {
  readonly entityTitle: string | null;
}

/**
 * What {@link appendEvent} accepts.
 *
 * `epicId` is a parameter rather than something the append looks up, and that
 * is load-bearing: `delete` records its event as its last act, *after* the task
 * row is gone, so a lookup would return nothing and every deleted task's event
 * would lose its epic. The caller holds the task and knows the answer;
 * {@link epicIdFor} is the one place the rule lives.
 */
export interface NewEvent {
  readonly type: EventType;
  readonly entityId: string;
  readonly epicId?: string | null;
  readonly actor: string;
  readonly fromLane?: Lane | null;
  readonly toLane?: Lane | null;
  readonly ref?: string | null;
  readonly reason?: string | null;
  readonly title?: string | null;
}
