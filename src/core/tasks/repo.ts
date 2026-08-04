/**
 * Creating and reading tasks.
 *
 * The row-to-domain boundary lives here: SQL columns are snake_case and
 * loosely typed, katra's domain objects are camelCase and narrow. Every value
 * crossing that line is checked with a type predicate rather than asserted
 * with `as` — the database is written by concurrent processes and, for the
 * migration story, by older builds, so a row is untrusted input.
 */

import { writeTx } from "../db/connection.js";
import type { Kind, Lane, Level, Priority } from "../enums.js";
import { PRIORITY_DEFAULT } from "../enums.js";
import { KatraException } from "../errors.js";
import { READINESS_VIEW } from "../graph/deps.js";
import { narrowKind, narrowLane, narrowLevel, narrowPriority } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { insertWithRetry, requireId } from "./ids.js";
import type { NewTask, Task, TaskDetail, TaskSummary } from "./types.js";

/** The raw shape SQLite hands back for a task row. */
interface TaskRow {
  readonly id: string;
  readonly level: string;
  readonly kind: string;
  readonly title: string;
  readonly description: string | null;
  readonly lane: string;
  readonly priority: number;
  readonly assignee: string | null;
  readonly parent_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly close_reason: string | null;
}

function readTags(store: OpenStore, id: string): string[] {
  return store.db
    .prepare("SELECT tag FROM tags WHERE task_id = ? ORDER BY tag")
    .all(id)
    .map((row) => (row as { tag: string }).tag);
}

/** Maps one row into a domain object, narrowing every constrained value. */
function rowToTask(store: OpenStore, row: TaskRow): Task {
  return {
    id: row.id,
    level: narrowLevel(row.level),
    kind: narrowKind(row.kind),
    title: row.title,
    description: row.description,
    lane: narrowLane(row.lane),
    priority: narrowPriority(row.priority),
    assignee: row.assignee,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    tags: readTags(store, row.id),
  };
}

const SELECT_TASK = "SELECT * FROM tasks WHERE id = ?";

/** Fetches a task by its exact id. */
export function getTask(store: OpenStore, id: string): Task | undefined {
  const row = store.db.prepare(SELECT_TASK).get(id) as TaskRow | undefined;
  return row === undefined ? undefined : rowToTask(store, row);
}

function summarise(store: OpenStore, id: string): TaskSummary | null {
  const row = store.db.prepare(SELECT_TASK).get(id) as TaskRow | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    title: row.title,
    level: narrowLevel(row.level),
    lane: narrowLane(row.lane),
  };
}

/**
 * Creates a task or epic and returns it.
 *
 * The task row and its tags share one timestamp and one transaction, so items
 * written together never differ by a millisecond and a failure part-way leaves
 * nothing behind.
 */
export function createTask(store: OpenStore, input: NewTask): Task {
  const title = input.title.trim();
  if (title === "") {
    throw new KatraException({
      code: "validation",
      message: "a task needs a title",
      field: "title",
      value: input.title,
    });
  }

  const level = narrowLevel(input.level ?? "task");
  const kind = narrowKind(input.kind ?? "feat");
  const lane = narrowLane(input.lane ?? "Defined");
  const priority = narrowPriority(input.priority ?? PRIORITY_DEFAULT);

  // Resolved before the write so a partial parent id is accepted and a bad one
  // is reported as "no such task" rather than as a constraint violation.
  const parentId =
    input.parentId === undefined || input.parentId === null
      ? null
      : requireId(store, input.parentId);

  const id = writeTx(store.db, (now) =>
    insertWithRetry((candidate) => {
      store.db
        .prepare(
          `INSERT INTO tasks
             (id, level, kind, title, description, lane, priority, assignee,
              parent_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          candidate,
          level,
          kind,
          title,
          input.description ?? null,
          lane,
          priority,
          input.assignee ?? null,
          parentId,
          now,
          now,
        );

      const addTag = store.db.prepare("INSERT OR IGNORE INTO tags (task_id, tag) VALUES (?,?)");
      for (const tag of input.tags ?? []) {
        const trimmed = tag.trim();
        if (trimmed !== "") addTag.run(candidate, trimmed);
      }
    }),
  );

  const created = getTask(store, id);
  if (created === undefined) {
    throw new KatraException({
      code: "not_found",
      message: `task ${id} vanished immediately after being created`,
      id,
    });
  }
  return created;
}

/**
 * Reads one task by full or partial id, with its parent resolved.
 *
 * Throws rather than returning undefined: every caller wants either the task
 * or an explanation, and the explanation differs between "no match" and
 * "several matches".
 */
export function showTask(store: OpenStore, idInput: string): TaskDetail {
  const id = requireId(store, idInput);
  const task = getTask(store, id);
  if (task === undefined) {
    throw new KatraException({ code: "not_found", message: `no task matches "${idInput}"`, id });
  }

  return {
    task,
    parent: task.parentId === null ? null : summarise(store, task.parentId),
  };
}

/** The filters `list` accepts. Every field is optional and combines with AND. */
export interface TaskFilters {
  readonly lane?: Lane;
  readonly kind?: Kind;
  readonly level?: Level;
  /** Epic id, already resolved. */
  readonly epic?: string;
  readonly tag?: string;
  readonly assignee?: string;
  readonly priority?: Priority;
  /** true keeps only ready tasks, false only blocked ones. */
  readonly ready?: boolean;
  readonly limit?: number;
}

/** What `list` returns. This type is the `--json` contract. */
export interface TaskList {
  readonly tasks: readonly Task[];
}

/**
 * Lists tasks matching every supplied filter.
 *
 * The `WHERE` clause is assembled dynamically, so two rules hold without
 * exception: **column names are literals written here**, never taken from
 * input, and **every value is a bound parameter**, never concatenated.
 *
 * Filters are exact matches, deliberately. `LIKE` would make a value
 * containing `%` match every row, and fuzzy matching is F3's full-text search
 * rather than something to smuggle in here.
 *
 * Readiness comes from joining the `task_readiness` view — the same definition
 * `isReady` reads — so a task cannot be ready by one command's reckoning and
 * blocked by another's.
 */
export function listTasks(store: OpenStore, filters: TaskFilters = {}): TaskList {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const eq = (column: string, value: unknown): void => {
    conditions.push(`${column} = ?`);
    params.push(value);
  };

  if (filters.lane !== undefined) eq("t.lane", filters.lane);
  if (filters.kind !== undefined) eq("t.kind", filters.kind);
  if (filters.level !== undefined) eq("t.level", filters.level);
  if (filters.epic !== undefined) eq("t.parent_id", filters.epic);
  if (filters.assignee !== undefined) eq("t.assignee", filters.assignee);
  if (filters.priority !== undefined) eq("t.priority", filters.priority);
  if (filters.ready !== undefined) eq("r.is_ready", filters.ready ? 1 : 0);
  if (filters.tag !== undefined) {
    conditions.push("EXISTS (SELECT 1 FROM tags g WHERE g.task_id = t.id AND g.tag = ?)");
    params.push(filters.tag);
  }

  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const limit = filters.limit === undefined ? "" : "LIMIT ?";
  if (filters.limit !== undefined) params.push(filters.limit);

  // rowid breaks the remaining tie: two rows written in the same millisecond
  // are routine, and without it their order would be arbitrary.
  const rows = store.db
    .prepare(
      `SELECT t.* FROM tasks t
         JOIN ${READINESS_VIEW} r ON r.id = t.id
       ${where}
       ORDER BY t.priority, t.created_at, t.rowid
       ${limit}`,
    )
    .all(...params) as TaskRow[];

  return { tasks: rows.map((row) => rowToTask(store, row)) };
}
