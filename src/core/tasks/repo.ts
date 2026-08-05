/**
 * Creating and reading tasks.
 *
 * The row-to-domain boundary lives here: SQL columns are snake_case and
 * loosely typed, katra's domain objects are camelCase and narrow. Every value
 * crossing that line is checked with a type predicate rather than asserted
 * with `as` — the database is written by concurrent processes and, for the
 * migration story, by older builds, so a row is untrusted input.
 */

import type { TaskList } from "../contract.js";
import { writeTx } from "../db/connection.js";
import type { Kind, Lane, Level, Priority } from "../enums.js";
import { isTerminal, PRIORITY_DEFAULT } from "../enums.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import { listBlockers, listDependents, READINESS_VIEW } from "../graph/deps.js";
import { listLinks } from "../graph/links.js";
import {
  narrowKind,
  narrowLane,
  narrowLevel,
  narrowNullableText,
  narrowPriority,
  narrowText,
} from "../narrow.js";
import type { OpenStore } from "../store.js";
import { insertWithRetry, requireId } from "./ids.js";
import type { NewTask, Task, TaskDetail, TaskSummary } from "./types.js";

/** The raw shape SQLite hands back for a task row. */
interface TaskRow {
  readonly id: unknown;
  readonly level: unknown;
  readonly kind: unknown;
  readonly title: unknown;
  readonly description: unknown;
  readonly lane: unknown;
  readonly priority: unknown;
  readonly assignee: unknown;
  readonly parent_id: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly closed_at: unknown;
  readonly close_reason: unknown;
}

function readTags(store: OpenStore, id: string): string[] {
  return store.db
    .prepare("SELECT tag FROM tags WHERE task_id = ? ORDER BY tag")
    .all(id)
    .map((row) => narrowText((row as { tag: unknown }).tag, "tag"));
}

/** Maps one row into a domain object, narrowing every constrained value. */
function rowToTask(store: OpenStore, row: TaskRow): Task {
  // Every column, not just the four with constrained value sets. The store is
  // written by concurrent processes and, for the migration story, by older
  // builds — so a row is untrusted input, and "untrusted" includes its types.
  const id = narrowText(row.id, "id");
  return {
    id,
    level: narrowLevel(row.level),
    kind: narrowKind(row.kind),
    title: narrowText(row.title, "title"),
    description: narrowNullableText(row.description, "description"),
    lane: narrowLane(row.lane),
    priority: narrowPriority(row.priority),
    assignee: narrowNullableText(row.assignee, "assignee"),
    parentId: narrowNullableText(row.parent_id, "parent_id"),
    createdAt: narrowText(row.created_at, "created_at"),
    updatedAt: narrowText(row.updated_at, "updated_at"),
    closedAt: narrowNullableText(row.closed_at, "closed_at"),
    closeReason: narrowNullableText(row.close_reason, "close_reason"),
    tags: readTags(store, id),
  };
}

const SELECT_TASK = "SELECT * FROM tasks WHERE id = ?";

/** Fetches a task by its exact id. */
export function getTask(store: OpenStore, id: string): Task | undefined {
  const row = store.db.prepare(SELECT_TASK).get(id) as TaskRow | undefined;
  return row === undefined ? undefined : rowToTask(store, row);
}

function summariseById(store: OpenStore, id: string): TaskSummary | null {
  const row = store.db.prepare(SELECT_TASK).get(id) as TaskRow | undefined;
  if (row === undefined) return null;
  return {
    id: narrowText(row.id, "id"),
    title: narrowText(row.title, "title"),
    level: narrowLevel(row.level),
    lane: narrowLane(row.lane),
  };
}

/**
 * Resolves a partial id and proves it names an epic.
 *
 * Shared by `add --parent` and `update --parent` because both are the same
 * question. The database enforces the rule regardless — through a trigger,
 * since SQLite forbids subqueries in a `CHECK` — but a trigger can only
 * `RAISE(ABORT)` with a bare string, which reaches the user as an internal
 * error rather than a refusal naming what went wrong.
 */
export function requireEpicId(store: OpenStore, input: string): string {
  const id = requireId(store, input);
  const parent = getTask(store, id);
  if (parent === undefined) {
    throw new KatraException({ code: "not_found", message: `no task matches "${input}"`, id });
  }
  if (parent.level !== "epic") {
    throw new KatraException({
      code: "validation",
      message:
        `${id} is a ${parent.level}, not an epic — only an epic can hold children. ` +
        "Give an existing epic, or create one with `katra add <title> --level epic`.",
      field: "parent",
      value: id,
    });
  }
  return id;
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

  // `add` is the third path that sets a lane, alongside `update` and `reopen`,
  // and terminal lanes belong to `close` and `cancel` on all three. Without
  // this the schema still refuses the row — a terminal lane demands a
  // closed_at that creation never writes — but as a raw CHECK-constraint dump.
  if (isTerminal(lane)) {
    throw new KatraException({
      code: "validation",
      message:
        `a new task cannot start in ${lane} — create it, then use \`katra close\` ` +
        "to finish it or `katra cancel` to abandon it, so the closing time is recorded",
      field: "lane",
      value: lane,
    });
  }

  const id = writeTx(store.db, (now) => {
    // Resolved inside the transaction, so a partial parent id is accepted and
    // a bad one is refused by name rather than by the trigger backing the same
    // rule. Resolved *outside* it, another worktree could delete the epic in
    // the window before the INSERT — the delete is allowed, since the epic has
    // no children yet — and the foreign key would fire as a raw
    // SQLITE_CONSTRAINT_FOREIGNKEY reported under the untyped "internal" code.
    const parentId =
      input.parentId === undefined || input.parentId === null
        ? null
        : requireEpicId(store, input.parentId);

    const created = insertWithRetry((candidate) => {
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
    });

    // After `insertWithRetry`, not inside its callback: the callback is retried
    // on a primary-key collision, and an append that ever raised one would make
    // the retry re-run the task insert too.
    //
    // The title is stamped onto the event because a `created` event outlives
    // its task (ADR-008) — once the row is deleted, no join can recover what it
    // was called.
    appendEvent(
      store,
      {
        type: "created",
        entityId: created,
        epicId: epicIdFor({ id: created, level, parentId }),
        actor: store.actor(),
        title,
      },
      now,
    );

    return created;
  });

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
  return showTaskWithin(store, requireId(store, idInput));
}

/**
 * The same read, given an already-resolved id.
 *
 * Split out so `update` can produce its own result **inside its transaction**
 * rather than re-reading afterwards — a second, un-transacted read can return a
 * concurrent writer's state instead of the one the caller just wrote.
 */
export function showTaskWithin(store: OpenStore, id: string): TaskDetail {
  const task = getTask(store, id);
  if (task === undefined) {
    throw new KatraException({ code: "not_found", message: `no task matches "${id}"`, id });
  }

  return {
    task,
    parent: task.parentId === null ? null : summariseById(store, task.parentId),
    links: listLinks(store, id),
    // `show` is where an agent decides whether to start something, and it was
    // the only view that never mentioned dependencies — a blocked task
    // rendered identically to a startable one.
    blockers: listBlockers(store, id),
    blocking: listDependents(store, id),
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
}

export type { TaskList };

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

  // rowid breaks the remaining tie: two rows written in the same millisecond
  // are routine, and without it their order would be arbitrary.
  const rows = store.db
    .prepare(
      `SELECT t.* FROM tasks t
         JOIN ${READINESS_VIEW} r ON r.id = t.id
       ${where}
       ORDER BY t.priority, t.created_at, t.rowid`,
    )
    .all(...params) as TaskRow[];

  return { tasks: rows.map((row) => rowToTask(store, row)) };
}
