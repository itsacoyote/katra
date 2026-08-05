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

import { writeTx } from "../db/connection.js";
import { KatraException } from "../errors.js";
import { appendEvent, epicIdFor } from "../events/repo.js";
import { NOTE_ID_PREFIX } from "../id-format.js";
import { narrowNoteKind, narrowText } from "../narrow.js";
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
 * Creates a note and records that it happened.
 *
 * The note, its `note-added` event and the task's `updated_at` share one
 * transaction and one timestamp, so history can never describe a note that was
 * not written.
 */
export function createNote(store: OpenStore, input: NewNote): Note {
  const body = requireBody(input.body);
  const kind = input.kind === undefined ? undefined : narrowNoteKind(input.kind);
  // Before the transaction: resolving the actor spawns two git subprocesses,
  // and under `BEGIN IMMEDIATE` that holds the write lock across both.
  const actor = store.actor();

  const id = writeTx(store.db, (now) => {
    // Resolved *inside* the transaction, like `createTask` does for a parent
    // epic: outside it, another worktree could delete the task in the window
    // before the INSERT and the foreign key would fire as a raw
    // SQLITE_CONSTRAINT_FOREIGNKEY under the untyped `internal` code, rather
    // than as a refusal naming the task.
    // One lookup, not two: `requireNoteTarget` resolves against `tasks` inside
    // this same transaction, so a second existence check here could not fail.
    const task = getTask(store, requireNoteTarget(store, input.taskId));
    if (task === undefined) {
      throw new KatraException({
        code: "internal",
        message: `task ${input.taskId} disappeared between being resolved and being read`,
      });
    }
    const taskId = task.id;

    const noteId = insertWithRetry((candidate) => {
      store.db
        .prepare(
          `INSERT INTO notes (id, task_id, kind, body, actor, created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(candidate, taskId, kind ?? "general", body, actor, now);
    }, NOTE_ID_PREFIX);

    appendEvent(
      store,
      {
        type: "note-added",
        entityId: taskId,
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
