/**
 * Writes rows straight into a store, bypassing application validation.
 *
 * Several tasks need data that the code able to produce it does not yet exist
 * for: T6 needs two thousand tasks before `createTask` is written, and T12
 * needs dependencies sitting in terminal lanes before `close` and `cancel`
 * are. Without one shared factory each would invent its own, and any of them
 * could quietly write rows the schema is supposed to forbid.
 *
 * This is a **deliberate bypass**, which is exactly why the schema's own
 * constraints must hold against it: nothing here loosens a `CHECK`, and a seed
 * that violates the model fails as loudly as production code would.
 */

import type { EventType, Kind, Lane, Level, NoteKind, Priority } from "../../src/core/enums.js";
import { isTerminal } from "../../src/core/enums.js";
import type { OpenStore } from "../../src/core/store.js";

/** A fixed instant, so seeded ordering is deterministic. */
export const SEED_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

let counter = 0;

/** Sequential, collision-free ids for seeded rows. Real ids are random (ADR-001). */
export function seedId(): string {
  counter += 1;
  return `kt-s${String(counter).padStart(5, "0")}`;
}

/** A timestamp `offsetMs` after the fixed seed epoch. */
export function seedTime(offsetMs = 0): string {
  return new Date(SEED_EPOCH + offsetMs).toISOString();
}

export interface SeedTaskInput {
  readonly id?: string;
  readonly level?: Level;
  readonly kind?: Kind;
  readonly title?: string;
  readonly description?: string | null;
  readonly lane?: Lane;
  readonly priority?: Priority;
  readonly assignee?: string | null;
  readonly parentId?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly closedAt?: string | null;
  readonly closeReason?: string | null;
  readonly tags?: readonly string[];
}

/**
 * Inserts one task and returns its id.
 *
 * A terminal lane is given a `closed_at` automatically unless one is supplied.
 * The schema requires it, and making every caller remember would turn an
 * invariant into a chore — but the constraint still enforces it, so an
 * explicit `closedAt: null` on a terminal lane correctly fails.
 */
export function seedTask(store: OpenStore, input: SeedTaskInput = {}): string {
  const id = input.id ?? seedId();
  const lane: Lane = input.lane ?? "Defined";
  const createdAt = input.createdAt ?? seedTime();
  const closedAt =
    input.closedAt !== undefined ? input.closedAt : isTerminal(lane) ? createdAt : null;

  store.db
    .prepare(
      `INSERT INTO tasks
         (id, level, kind, title, description, lane, priority, assignee,
          parent_id, created_at, updated_at, closed_at, close_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      input.level ?? "task",
      input.kind ?? "feat",
      input.title ?? `seeded ${id}`,
      input.description ?? null,
      lane,
      input.priority ?? 2,
      input.assignee ?? null,
      input.parentId ?? null,
      createdAt,
      input.updatedAt ?? createdAt,
      closedAt,
      input.closeReason ?? null,
    );

  for (const tag of input.tags ?? []) seedTag(store, id, tag);
  return id;
}

/** Inserts an epic and returns its id. */
export function seedEpic(store: OpenStore, input: Omit<SeedTaskInput, "level"> = {}): string {
  return seedTask(store, { ...input, level: "epic" });
}

/** Records that `taskId` is blocked by `dependsOnId`. */
export function seedDep(store: OpenStore, taskId: string, dependsOnId: string): void {
  store.db
    .prepare("INSERT INTO deps (task_id, depends_on_id, created_at) VALUES (?,?,?)")
    .run(taskId, dependsOnId, seedTime());
}

/**
 * Links two tasks.
 *
 * The ids are sorted first because `links` enforces canonical ordering — an
 * unsorted insert fails the constraint about half the time, which is a
 * confusing way for a test to break.
 */
export function seedLink(store: OpenStore, first: string, second: string): void {
  const [a, b] = [first, second].sort();
  store.db
    .prepare("INSERT INTO links (a_id, b_id, created_at) VALUES (?,?,?)")
    .run(a, b, seedTime());
}

/** Tags a task. */
export function seedTag(store: OpenStore, taskId: string, tag: string): void {
  store.db.prepare("INSERT INTO tags (task_id, tag) VALUES (?,?)").run(taskId, tag);
}

/** Inserts `count` tasks in one transaction. For volume tests. */
export function seedMany(store: OpenStore, count: number, input: SeedTaskInput = {}): string[] {
  const ids: string[] = [];
  const insert = store.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      ids.push(seedTask(store, { ...input, createdAt: input.createdAt ?? seedTime(i) }));
    }
  });
  insert.immediate();
  return ids;
}

export interface SeedEventInput {
  readonly type?: EventType;
  readonly entityId?: string;
  readonly epicId?: string | null;
  readonly actor?: string;
  readonly fromLane?: Lane | null;
  readonly toLane?: Lane | null;
  readonly ref?: string | null;
  readonly reason?: string | null;
  readonly title?: string | null;
  readonly createdAt?: string;
}

/** A stable actor for seeded rows, shaped like a real one (ADR-007). */
export const SEED_ACTOR = "main @ /repo/seed";

/** Appends one event and returns its integer id. */
export function seedEvent(store: OpenStore, input: SeedEventInput = {}): number {
  const info = store.db
    .prepare(
      `INSERT INTO events
         (type, entity_id, epic_id, actor, from_lane, to_lane, ref, reason, title, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.type ?? "created",
      input.entityId ?? seedId(),
      input.epicId ?? null,
      input.actor ?? SEED_ACTOR,
      input.fromLane ?? null,
      input.toLane ?? null,
      input.ref ?? null,
      input.reason ?? null,
      input.title ?? null,
      input.createdAt ?? seedTime(),
    );
  return Number(info.lastInsertRowid);
}

export interface SeedNoteInput {
  readonly id?: string;
  readonly taskId: string;
  readonly kind?: NoteKind;
  readonly body?: string;
  readonly actor?: string;
  readonly createdAt?: string;
}

let noteCounter = 0;

/** Sequential, collision-free note ids for seeded rows. */
export function seedNoteId(): string {
  noteCounter += 1;
  return `nt-s${String(noteCounter).padStart(5, "0")}`;
}

/** Inserts one note and returns its id. */
export function seedNote(store: OpenStore, input: SeedNoteInput): string {
  const id = input.id ?? seedNoteId();
  store.db
    .prepare("INSERT INTO notes (id, task_id, kind, body, actor, created_at) VALUES (?,?,?,?,?,?)")
    .run(
      id,
      input.taskId,
      input.kind ?? "general",
      input.body ?? "a seeded note",
      input.actor ?? SEED_ACTOR,
      input.createdAt ?? seedTime(),
    );
  return id;
}
