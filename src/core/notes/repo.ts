/**
 * Creating and reading notes.
 *
 * A note is the fat artifact katra stores: a handoff, a decision, an
 * acceptance record. Tasks carry titles and lanes; notes carry the prose that
 * would not fit in either.
 *
 * Two things here differ from the task repository on purpose:
 *
 * - **An empty body is refused.** `readBody` returns `undefined` for a blank
 *   file, which is right for a task's optional description and wrong here,
 *   where the body *is* the note. Left unchecked it puts NULL into a NOT NULL
 *   column and surfaces as `internal`/exit 4 — a broken-machine signal for
 *   what is really a rejected input.
 * - **Creating a note writes an event.** `note-added` is the seventh event
 *   type and the only one no task path produces, so this module is where the
 *   stream learns about notes.
 */

import { assertNotReadOnly, writeTx } from "../db/connection.js";
import type { Lane, NoteKind } from "../enums.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import { NOTE_ID_PREFIX } from "../id-format.js";
import { narrowLane, narrowNoteKind, narrowText } from "../narrow.js";
import type { OpenStore } from "../store.js";
import { insertWithRetry, requireResolved, resolveId } from "../tasks/ids.js";
import { getTask } from "../tasks/repo.js";
import type { NewNote, Note, NoteFilters } from "./types.js";

/** The raw shape SQLite hands back for a note row. */
interface NoteRow {
  readonly id: unknown;
  readonly task_id: unknown;
  readonly kind: unknown;
  readonly body: unknown;
  readonly actor: unknown;
  readonly created_at: unknown;
}

/** Maps one row into a domain object, narrowing every column. */
function rowToNote(row: NoteRow): Note {
  // `body` included, and it is the one that matters most: SQLite's flexible
  // typing lets a BLOB sit in a TEXT column, better-sqlite3 hands it back as a
  // Buffer, and a formatter calling `.trim()` on it throws a TypeError that
  // surfaces as `internal`. F1 made this exact finding for `task.title`.
  return {
    id: narrowText(row.id, "id"),
    taskId: narrowText(row.task_id, "task_id"),
    kind: narrowNoteKind(row.kind),
    body: narrowText(row.body, "body"),
    actor: narrowText(row.actor, "actor"),
    createdAt: narrowText(row.created_at, "created_at"),
  };
}

/**
 * Rejects a body that is not content.
 *
 * Whitespace-only counts as empty — a note whose body is three spaces is the
 * same mistake as one with no body, and storing it would put a row in the
 * stream that says nothing.
 *
 * The body is otherwise stored **exactly as given**: not trimmed, not
 * normalised. Notes hold pasted output and indented code, and leading
 * whitespace is often the content.
 */
function requireBody(body: string): string {
  if (body.trim() === "") {
    throw new KatraException({
      code: "validation",
      message:
        "a note needs a body — that is the whole content of a note, unlike a " +
        "task's description, which is optional",
      field: "body",
      value: body,
    });
  }
  return body;
}

/**
 * Resolves the task a note is being attached to.
 *
 * `requireId` would do, except its not-found message says only that nothing
 * matched. Attaching a note to a task that does not exist is nearly always a
 * typo or an id from the wrong repository, and the refusal should say what
 * would fix it. Ambiguity and the prefix-length floor keep their existing
 * wording — only the empty case is reshaped.
 */
function requireNoteTarget(store: OpenStore, input: string): string {
  const resolution = resolveId(store, input);
  if (resolution.kind === "not_found") {
    throw new KatraException({
      code: "not_found",
      message:
        `no task matches "${resolution.input}" — create it with \`katra add\` first, ` +
        "then attach the note to it",
      id: resolution.input,
    });
  }
  return requireResolved(resolution, "task", "tasks");
}

/**
 * The row-mutation core of `createNote`: validates the body, resolves the
 * target task, and inserts the note — stamping the caller's actor and time
 * rather than `store.actor()` or `writeTx`'s own clock.
 *
 * **Must be called inside an open transaction** — see `appendEvent`'s guard
 * (`events/repo.ts`), which this mirrors. `actor` injected is load-bearing
 * here, not just a lock-window nicety: the F5 loader attaches a beads
 * comment's own author to the note it becomes, an actor `store.actor()`
 * could never produce since it always resolves to *this* process's identity.
 * **Writes no event** — the F5 loader inserts historical notes without a
 * `note-added` event masquerading as live activity, appending its own events
 * afterwards in true chronological order. `createNote` is the only caller
 * during ordinary use: it wraps this in `writeTx`, then appends the
 * `note-added` event itself from a fresh read of the row this seam just wrote.
 */
export function createNoteWithin(
  store: OpenStore,
  input: NewNote,
  ctx: { readonly actor: string; readonly createdAt: string },
): string {
  if (!store.db.inTransaction) {
    throw new KatraException({
      code: "internal",
      message:
        "createNoteWithin must be called inside an open transaction — a note " +
        "that commits on its own can outlive the change it's part of",
    });
  }
  assertNotReadOnly(store.db, "createNoteWithin");

  const body = requireBody(input.body);
  const kind = input.kind === undefined ? undefined : narrowNoteKind(input.kind);

  // Resolved *inside* the transaction, like `createTask` does for a parent
  // epic: outside it, another worktree could delete the task in the window
  // before the INSERT and the foreign key would fire as a raw
  // SQLITE_CONSTRAINT_FOREIGNKEY under the untyped `internal` code, rather
  // than as a refusal naming the task.
  const taskId = requireNoteTarget(store, input.taskId);

  return insertWithRetry((candidate) => {
    store.db
      .prepare(
        `INSERT INTO notes (id, task_id, kind, body, actor, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(candidate, taskId, kind ?? "general", body, ctx.actor, ctx.createdAt);
  }, NOTE_ID_PREFIX);
}

/**
 * Creates a note and records that it happened.
 *
 * The note, its `note-added` event and the task's `updated_at` share one
 * transaction and one timestamp, so history can never describe a note that was
 * not written.
 */
export function createNote(store: OpenStore, input: NewNote): Note {
  // Before the transaction: resolving the actor spawns two git subprocesses,
  // and under `BEGIN IMMEDIATE` that holds the write lock across both.
  const actor = store.actor();

  const id = writeTx(store.db, (now) => {
    const noteId = createNoteWithin(store, input, { actor, createdAt: now });

    // Read back rather than carried out of the seam: `createNoteWithin`'s
    // return type is just the minted id, so the task it attached to comes
    // from the row it just wrote, not from a local variable the seam kept to
    // itself.
    const note = getNote(store, noteId);
    if (note === undefined) {
      throw new KatraException({
        code: "internal",
        message: `note ${noteId} vanished immediately after being created`,
      });
    }
    const task = getTask(store, note.taskId);
    if (task === undefined) {
      throw new KatraException({
        code: "internal",
        message: `task ${note.taskId} disappeared between being noted and being read`,
      });
    }

    appendEvent(
      store,
      {
        type: "note-added",
        entityId: note.taskId,
        epicId: epicIdFor(task),
        actor,
        // The note's id, so the event points at what was added. It dangles
        // once the note cascades away with its task — the same deliberate
        // looseness as `entity_id` (ADR-008).
        ref: noteId,
      },
      now,
    );

    return noteId;
  });

  const created = getNote(store, id);
  if (created === undefined) {
    throw new KatraException({
      code: "not_found",
      message: `note ${id} vanished immediately after being created`,
      id,
    });
  }
  return created;
}

/** Fetches a note by its exact id. */
export function getNote(store: OpenStore, id: string): Note | undefined {
  const row = store.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  return row === undefined ? undefined : rowToNote(row);
}

/**
 * Lists notes, newest first.
 *
 * Ordered by `created_at` **then `rowid`**, not then `id`. Timestamps have
 * millisecond precision and two notes added in quick succession routinely
 * share one — measured, not assumed: three separate `createNote` calls in a
 * test landed in the same millisecond. `nt-` ids are random by design
 * (ADR-001), so breaking that tie with the id returns them in an order with no
 * relation to when they were written, which is exactly what "newest first"
 * promises not to do.
 *
 * `rowid` is insertion order, so it is the tie-break `list` already uses for
 * tasks. It is only available because `notes` is an ordinary rowid table; a
 * `WITHOUT ROWID` table would need a sequence column instead.
 */
export function listNotes(store: OpenStore, filters: NoteFilters = {}): Note[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.taskId !== undefined) {
    conditions.push("task_id = ?");
    params.push(filters.taskId);
  }
  if (filters.kind !== undefined) {
    conditions.push("kind = ?");
    params.push(narrowNoteKind(filters.kind));
  }

  const bounded = filters.limit !== undefined;
  if (bounded) params.push(filters.limit);

  const rows = store.db
    .prepare(
      `SELECT * FROM notes
       ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
       ORDER BY created_at DESC, rowid DESC
       ${bounded ? "LIMIT ?" : ""}`,
    )
    .all(...params) as NoteRow[];

  return rows.map(rowToNote);
}

/**
 * Which notes a scoped read is asking about.
 *
 * `taskId` is one task's own notes. `epicId` is an epic's **and its children's**
 * — the shape `brief <epic>` needs, and the one `listNotes` cannot express.
 * Neither means the whole store; that is `listNotes` with no filter.
 */
export interface NoteScope {
  readonly taskId?: string;
  readonly epicId?: string;
  readonly kind?: NoteKind;
}

/**
 * The `WHERE` clause and parameters for a scope, over `notes n JOIN tasks t`.
 *
 * The join is why this exists. `notes` has **no `epic_id` column** — that lives
 * on `events`, stamped at write time so history needs no join at all. Notes have
 * only `task_id`, so an epic's notes can only be found by asking `tasks` which
 * rows sit under it, live.
 *
 * That difference is invisible from the outside and will bite eventually: an
 * event's epic scoping is frozen at write time, this one is evaluated now. Move
 * a task from epic A to epic B and its old notes follow it to B while its old
 * events stay with A. Neither answer is wrong; they are answers to different
 * questions, and nothing can make them agree.
 *
 * The join is INNER, unlike every read against `events`. `notes.task_id`
 * cascades on delete and `foreign_keys` is ON for every connection, so a note
 * cannot outlive its task — the dangling-reference case ADR-008 warns about for
 * events simply does not arise here. History survives, content does not.
 */
function scopeConditions(scope: NoteScope): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (scope.taskId !== undefined) {
    conditions.push("n.task_id = ?");
    params.push(scope.taskId);
  }
  if (scope.epicId !== undefined) {
    // The epic's own notes *or* any child's. `parent_id` is a single level by
    // design (spec §5), so this needs no recursion.
    conditions.push("(t.id = ? OR t.parent_id = ?)");
    params.push(scope.epicId, scope.epicId);
  }
  if (scope.kind !== undefined) {
    conditions.push("n.kind = ?");
    params.push(narrowNoteKind(scope.kind));
  }

  return {
    sql: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

/**
 * The newest note in a scope, or `undefined`.
 *
 * What `brief` calls to find the handoff it leads with. Ordered
 * `created_at DESC, rowid DESC` for the reason {@link listNotes} documents: ids
 * are random, timestamps are millisecond-precision, and notes written together
 * routinely share one — so the id is not a tie-break, it is noise.
 */
export function latestNoteInScope(store: OpenStore, scope: NoteScope): Note | undefined {
  const { sql, params } = scopeConditions(scope);
  const row = store.db
    .prepare(
      `SELECT n.* FROM notes n
         JOIN tasks t ON t.id = n.task_id
       ${sql}
       ORDER BY n.created_at DESC, n.rowid DESC
       LIMIT 1`,
    )
    .get(...params) as NoteRow | undefined;

  // Through `rowToNote`, never straight out of the row: that is where the
  // BLOB-in-a-TEXT-column refusal lives, and a second read that skipped it
  // would hand a Buffer to a formatter and report a broken machine.
  return row === undefined ? undefined : rowToNote(row);
}

/**
 * How many notes of each kind a scope holds, omitting kinds with none.
 *
 * `brief` shows one note in full and counts the rest, so the reader knows what
 * else is there without paying for it. A kind with no notes is absent rather
 * than zero — "2 decision" is worth a line, "0 acceptance" is not.
 */
export function countNotesByKind(
  store: OpenStore,
  scope: NoteScope,
): Partial<Record<NoteKind, number>> {
  const { sql, params } = scopeConditions(scope);
  const rows = store.db
    .prepare(
      `SELECT n.kind AS kind, COUNT(*) AS count FROM notes n
         JOIN tasks t ON t.id = n.task_id
       ${sql}
       GROUP BY n.kind`,
    )
    .all(...params) as Array<{ kind: unknown; count: unknown }>;

  const counts: Partial<Record<NoteKind, number>> = {};
  for (const row of rows) {
    counts[narrowNoteKind(row.kind)] = Number(row.count);
  }
  return counts;
}

/**
 * The newest `handoff` in the whole store, with the task it belongs to.
 *
 * What `board --digest` leads with. Separate from {@link latestNoteInScope}
 * because it needs three columns from `tasks` that a scoped note read has no
 * business carrying — above all the **lane**.
 *
 * The lane is load-bearing. This is deliberately *not* filtered to unfinished
 * work: "I finished X, next is Y" is the commonest real handoff and it lives on
 * a `Done` task, so filtering would hide the best ones. Showing the lane beside
 * it is what stops a finished task's handoff reading as live context.
 *
 * The join is INNER, unlike every read against `events`. `notes.task_id`
 * cascades and `foreign_keys` is ON for every connection, so a note cannot
 * outlive its task — ADR-008's dangling-reference case does not arise for
 * content, only for history.
 */
export interface StoreHandoff {
  readonly note: Note;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskLane: Lane;
}

export function latestHandoff(store: OpenStore): StoreHandoff | undefined {
  const row = store.db
    .prepare(
      // `created_at DESC, rowid DESC`, and the tie-break is not optional just
      // because there is no scope this time: with no `task_id` filter, `rowid`
      // is the table's global insertion order, which is exactly the right
      // answer when two handoffs share a millisecond.
      `SELECT n.*, t.title AS task_title, t.lane AS task_lane
         FROM notes n
         JOIN tasks t ON t.id = n.task_id
        WHERE n.kind = 'handoff'
        ORDER BY n.created_at DESC, n.rowid DESC
        LIMIT 1`,
    )
    .get() as (NoteRow & { task_title: unknown; task_lane: unknown }) | undefined;

  if (row === undefined) return undefined;

  // Through `rowToNote`, so the BLOB-in-a-TEXT-column refusal is inherited
  // rather than re-implemented — and the two task columns narrowed the same way.
  const note = rowToNote(row);
  return {
    note,
    taskId: note.taskId,
    taskTitle: narrowText(row.task_title, "task_title"),
    taskLane: narrowLane(row.task_lane),
  };
}
